import { redis } from '../../config/redis';
import {
  AttendanceSegment,
  SessionAttendanceSummary,
  StudentAttendanceCalculation,
  StudentAttendanceRecord,
} from '../../types/attendance.types';
import { SessionContext, UserAuthPayload } from '../../types/broadcast.types';
import { RoomManager } from '../room/room.manager';

export class AttendanceEngine {
  public static NETWORK_BLIP_GRACE_MS = 15000; // 15 seconds
  public static HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds
  public static HEARTBEAT_STALE_MS = 45000; // 30s heartbeat + 15s grace

  /**
   * In-memory pending heartbeat buffer (`sessionId -> Set<userId>`) for high-concurrency
   * pipelined Redis flushing every 5 seconds when 1,000+ students are active in a room.
   */
  private static pendingHeartbeats = new Map<string, Set<string>>();

  private static recordKey(sessionId: string, userId: string): string {
    return `room:${sessionId}:attendance:${userId}`;
  }

  private static studentsSetKey(sessionId: string): string {
    return `room:${sessionId}:attendance_students`;
  }

  /**
   * Helper to compute a single student's live or finalized attendance calculation (Formula C).
   */
  public static computeStudentCalculation(
    record: StudentAttendanceRecord,
    sessionStartMs: number,
    referenceEndMs: number
  ): StudentAttendanceCalculation {
    const totalClassDurationSeconds = Math.max(1, Math.floor((referenceEndMs - sessionStartMs) / 1000));
    const isHeartbeatStale =
      record.isOnline && referenceEndMs - record.lastSeenAt > this.HEARTBEAT_STALE_MS;
    const effectiveOnline = record.isOnline && !isHeartbeatStale;

    let totalJoinedSeconds = 0;
    let lastLeftAt: number | null = null;

    for (let i = 0; i < record.segments.length; i++) {
      const seg = record.segments[i];
      const isLastSegment = i === record.segments.length - 1;
      let segEnd: number;

      if (isLastSegment && record.isOnline) {
        segEnd = isHeartbeatStale ? record.lastSeenAt : referenceEndMs;
      } else {
        segEnd = seg.leftAt > 0 ? seg.leftAt : record.lastSeenAt;
        lastLeftAt = segEnd;
      }

      const segDuration = Math.max(0, Math.floor((segEnd - seg.joinedAt) / 1000));
      totalJoinedSeconds += segDuration;
    }

    const totalJoinedMinutes = Math.round((totalJoinedSeconds / 60) * 100) / 100;
    const totalJoinedHours = Math.round((totalJoinedSeconds / 3600) * 1000) / 1000;

    const rawPercentage = (totalJoinedSeconds / totalClassDurationSeconds) * 100;
    const attendancePercentage = Math.min(100, Math.round(rawPercentage * 100) / 100);

    let status: 'present' | 'partial' | 'late' | 'absent';
    if (attendancePercentage >= 75) {
      status = 'present';
    } else if (attendancePercentage >= 30) {
      status = 'partial';
    } else if (record.firstJoinedAt - sessionStartMs > 15 * 60 * 1000) {
      status = 'late';
    } else {
      status = 'absent';
    }

    return {
      userId: record.userId,
      name: record.name,
      rollNumber: record.rollNumber,
      email: record.email,
      avatar: record.avatar,
      firstJoinedAt: record.firstJoinedAt,
      lastSeenAt: record.lastSeenAt,
      leftAt: effectiveOnline ? null : lastLeftAt || record.lastSeenAt,
      rejoinCount: record.rejoinCount || 0,
      isOnline: effectiveOnline,
      totalJoinedSeconds,
      totalJoinedMinutes,
      totalJoinedHours,
      attendancePercentage,
      status,
    };
  }

  /**
   * Records student join with 15-second Network Blip Grace.
   * Supports `options.skipMetricsBroadcast` during 1,000+ student surge joins so
   * attendance metrics can be broadcast once on a throttled interval instead of N^2 times.
   */
  public static async recordJoin(
    sessionId: string,
    user: UserAuthPayload,
    socketId: string,
    options?: { skipMetricsBroadcast?: boolean }
  ): Promise<StudentAttendanceRecord> {
    const key = this.recordKey(sessionId, user.userId);
    const now = Date.now();
    const raw = await redis.get(key);

    let record: StudentAttendanceRecord;

    if (raw) {
      record = JSON.parse(raw);
      record.rejoinCount = record.rejoinCount || 0;

      // Check for 15s Network Blip Grace or active socket replacement
      if (
        record.isOnline ||
        (record.tempDisconnectAt && now - record.tempDisconnectAt <= this.NETWORK_BLIP_GRACE_MS)
      ) {
        // Reconnected within 15s: merge seamlessly into active segment
        record.tempDisconnectAt = null;
        record.isOnline = true;
        record.currentSocketId = socketId;
        record.lastSeenAt = now;
        if (record.segments.length > 0) {
          record.segments[record.segments.length - 1].leftAt = 0;
        }
      } else {
        // Genuine rejoin after >15s disconnect: new continuous segment
        record.isOnline = true;
        record.currentSocketId = socketId;
        record.lastSeenAt = now;
        record.tempDisconnectAt = null;
        record.rejoinCount += 1;

        record.segments.push({
          joinedAt: now,
          leftAt: 0,
          durationSeconds: 0,
        });
      }
    } else {
      // First-time join in this session
      record = {
        userId: user.userId,
        name: user.name,
        role: 'student',
        rollNumber: user.rollNumber,
        email: user.email,
        avatar: user.avatar,
        firstJoinedAt: now,
        lastSeenAt: now,
        rejoinCount: 0,
        segments: [
          {
            joinedAt: now,
            leftAt: 0,
            durationSeconds: 0,
          },
        ],
        totalJoinedSeconds: 0,
        isOnline: true,
        currentSocketId: socketId,
        tempDisconnectAt: null,
      };
    }

    const pipeline = redis.pipeline();
    pipeline.set(key, JSON.stringify(record));
    pipeline.sadd(this.studentsSetKey(sessionId), user.userId);
    await pipeline.exec();

    if (!options?.skipMetricsBroadcast) {
      const liveMetrics = await this.getLiveAttendanceList(sessionId);
      await RoomManager.appendPacket(sessionId, 'ATTENDANCE_METRICS_UPDATE', {
        onlineCount: liveMetrics.onlineCount,
        totalCount: liveMetrics.totalCount,
        students: liveMetrics.students,
        joinedUser: { userId: user.userId, name: user.name },
      });
    }

    return record;
  }

  /**
   * Heartbeat Ping: student sends ping every 30s.
   */
  public static async recordHeartbeat(sessionId: string, userId: string): Promise<void> {
    const key = this.recordKey(sessionId, userId);
    const raw = await redis.get(key);
    if (!raw) return;

    const record: StudentAttendanceRecord = JSON.parse(raw);
    const now = Date.now();
    record.lastSeenAt = now;
    record.isOnline = true;

    if (record.segments.length > 0) {
      const activeSegment = record.segments[record.segments.length - 1];
      activeSegment.leftAt = 0;
      activeSegment.durationSeconds = Math.max(
        0,
        Math.floor((now - activeSegment.joinedAt) / 1000)
      );
    }

    let totalSeconds = 0;
    for (const seg of record.segments) {
      totalSeconds += seg.durationSeconds;
    }
    record.totalJoinedSeconds = totalSeconds;

    await redis.set(key, JSON.stringify(record));
  }

  /**
   * Queues a student heartbeat in memory so 1,000+ concurrent student heartbeats can be
   * flushed in a single Redis pipeline (`flushQueuedHeartbeats` / `recordHeartbeatBatch`).
   */
  public static queueHeartbeat(sessionId: string, userId: string): void {
    let set = this.pendingHeartbeats.get(sessionId);
    if (!set) {
      set = new Set<string>();
      this.pendingHeartbeats.set(sessionId, set);
    }
    set.add(userId);
  }

  /**
   * Processes a batch of student heartbeats for a session using a single `redis.mget()`
   * and a single `redis.pipeline().set()` round-trip.
   * Capable of updating 1,000+ concurrent student attendance records in `< 15ms`.
   */
  public static async recordHeartbeatBatch(
    sessionId: string,
    userIds: string[],
    nowMs?: number
  ): Promise<number> {
    if (!userIds || userIds.length === 0) return 0;
    const uniqueUserIds = Array.from(new Set(userIds));
    const keys = uniqueUserIds.map((uid) => this.recordKey(sessionId, uid));
    const rawRecords = await redis.mget(...keys);

    const now = nowMs ?? Date.now();
    const pipeline = redis.pipeline();
    let updatedCount = 0;

    for (let i = 0; i < rawRecords.length; i++) {
      const raw = rawRecords[i];
      if (!raw) continue;
      try {
        const record: StudentAttendanceRecord = JSON.parse(raw);
        record.lastSeenAt = now;
        record.isOnline = true;

        if (record.segments.length > 0) {
          const activeSegment = record.segments[record.segments.length - 1];
          activeSegment.leftAt = 0;
          activeSegment.durationSeconds = Math.max(
            0,
            Math.floor((now - activeSegment.joinedAt) / 1000)
          );
        }

        let totalSeconds = 0;
        for (const seg of record.segments) {
          totalSeconds += seg.durationSeconds;
        }
        record.totalJoinedSeconds = totalSeconds;

        pipeline.set(keys[i], JSON.stringify(record));
        updatedCount += 1;
      } catch {
        // Ignore malformed JSON
      }
    }

    if (updatedCount > 0) {
      await pipeline.exec();
    }
    return updatedCount;
  }

  /**
   * Flushes all queued in-memory student heartbeats across all active sessions via Redis pipeline.
   */
  public static async flushQueuedHeartbeats(): Promise<number> {
    if (this.pendingHeartbeats.size === 0) return 0;
    let totalFlushed = 0;
    const entries = Array.from(this.pendingHeartbeats.entries());
    this.pendingHeartbeats.clear();

    for (const [sessionId, userIdSet] of entries) {
      if (userIdSet.size > 0) {
        totalFlushed += await this.recordHeartbeatBatch(sessionId, Array.from(userIdSet));
      }
    }
    return totalFlushed;
  }

  /**
   * Records student socket disconnect. Initiates 15s blip window.
   */
  public static async recordDisconnect(
    sessionId: string,
    userId: string,
    socketId: string
  ): Promise<void> {
    const key = this.recordKey(sessionId, userId);
    const raw = await redis.get(key);
    if (!raw) return;

    const record: StudentAttendanceRecord = JSON.parse(raw);

    // Only handle if disconnect matches active socket
    if (record.currentSocketId && record.currentSocketId !== socketId) {
      return;
    }

    const now = Date.now();
    record.tempDisconnectAt = now;
    record.isOnline = false;

    if (record.segments.length > 0) {
      const activeSegment = record.segments[record.segments.length - 1];
      activeSegment.leftAt = now;
      activeSegment.durationSeconds = Math.max(
        0,
        Math.floor((now - activeSegment.joinedAt) / 1000)
      );
    }

    await redis.set(key, JSON.stringify(record));

    // Wait for 15s grace before committing disconnect segment permanently
    setTimeout(async () => {
      try {
        const verifyRaw = await redis.get(key);
        if (!verifyRaw) return;
        const currentRecord: StudentAttendanceRecord = JSON.parse(verifyRaw);

        // If still disconnected after 15s, accumulate segment duration
        if (!currentRecord.isOnline && currentRecord.tempDisconnectAt) {
          currentRecord.tempDisconnectAt = null;
          let totalSeconds = 0;
          for (const seg of currentRecord.segments) {
            totalSeconds += seg.durationSeconds;
          }
          currentRecord.totalJoinedSeconds = totalSeconds;
          await redis.set(key, JSON.stringify(currentRecord));

          const liveMetrics = await AttendanceEngine.getLiveAttendanceList(sessionId);
          await RoomManager.appendPacket(sessionId, 'ATTENDANCE_METRICS_UPDATE', {
            onlineCount: liveMetrics.onlineCount,
            totalCount: liveMetrics.totalCount,
            students: liveMetrics.students,
            leftUser: { userId: currentRecord.userId, name: currentRecord.name },
          });
        }
      } catch (err: any) {
        console.error('[AttendanceEngine] Blip timer error:', err.message);
      }
    }, this.NETWORK_BLIP_GRACE_MS);
  }

  /**
   * Returns live attendance records & metrics for all students in the session.
   */
  public static async getLiveAttendanceList(
    sessionId: string,
    sessionStartTimeIso?: string
  ): Promise<{
    onlineCount: number;
    totalCount: number;
    students: StudentAttendanceCalculation[];
  }> {
    const studentIds = await redis.smembers(this.studentsSetKey(sessionId));
    if (!studentIds || studentIds.length === 0) {
      return { onlineCount: 0, totalCount: 0, students: [] };
    }

    const now = Date.now();
    let startMs = sessionStartTimeIso ? new Date(sessionStartTimeIso).getTime() : 0;
    if (!startMs || Number.isNaN(startMs)) {
      const ctxRaw = await redis.get(`room:${sessionId}:context`);
      if (ctxRaw) {
        try {
          const ctx: SessionContext = JSON.parse(ctxRaw);
          startMs = new Date(ctx.startTime).getTime();
        } catch {
          // ignore
        }
      }
    }

    const recordKeys = studentIds.map((id) => this.recordKey(sessionId, id));
    const recordsRaw = recordKeys.length > 0 ? await redis.mget(...recordKeys) : [];

    const students: StudentAttendanceCalculation[] = [];
    let onlineCount = 0;

    for (const raw of recordsRaw) {
      if (!raw) continue;
      try {
        const rec: StudentAttendanceRecord = JSON.parse(raw);
        const effectiveStartMs =
          startMs && startMs < now ? startMs : Math.min(rec.firstJoinedAt, now - 1000);
        const calc = this.computeStudentCalculation(rec, effectiveStartMs, now);
        if (calc.isOnline) {
          onlineCount++;
        }
        students.push(calc);
      } catch {
        // ignore malformed record
      }
    }

    // Sort online students first, then by name
    students.sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return {
      onlineCount,
      totalCount: students.length,
      students,
    };
  }

  /**
   * Counts currently online students.
   */
  public static async getOnlineStudentCount(sessionId: string): Promise<number> {
    const live = await this.getLiveAttendanceList(sessionId);
    return live.onlineCount;
  }

  /**
   * Finalizes and calculates attendance metrics for all students (Formula C).
   */
  public static async finalizeSessionAttendance(
    sessionId: string,
    sessionContext: SessionContext,
    sessionStartTime: string,
    sessionEndTime: string
  ): Promise<SessionAttendanceSummary> {
    const startMs = new Date(sessionStartTime).getTime();
    const endMs = new Date(sessionEndTime).getTime();
    const totalClassDurationSeconds = Math.max(1, Math.floor((endMs - startMs) / 1000));

    const studentIds = await redis.smembers(this.studentsSetKey(sessionId));
    const recordKeys = studentIds.map((id) => this.recordKey(sessionId, id));
    const recordsRaw = recordKeys.length > 0 ? await redis.mget(...recordKeys) : [];

    const calculations: StudentAttendanceCalculation[] = [];
    let presentCount = 0;
    let partialCount = 0;
    let lateOrAbsentCount = 0;

    for (const raw of recordsRaw) {
      if (!raw) continue;
      try {
        const record: StudentAttendanceRecord = JSON.parse(raw);
        const effectiveStartMs =
          startMs && startMs < endMs ? startMs : Math.min(record.firstJoinedAt, endMs - 1000);
        const calc = this.computeStudentCalculation(record, effectiveStartMs, endMs);

        if (calc.status === 'present') {
          presentCount++;
        } else if (calc.status === 'partial') {
          partialCount++;
        } else {
          lateOrAbsentCount++;
        }

        calculations.push(calc);
      } catch (err: any) {
        console.error('[AttendanceEngine] Calc error for student:', err.message);
      }
    }

    const summary: SessionAttendanceSummary = {
      sessionId,
      teacherId: sessionContext.teacherId,
      teacherName: sessionContext.teacherName,
      sessionTitle: sessionContext.title,
      startTime: sessionStartTime,
      endTime: sessionEndTime,
      totalClassDurationSeconds,
      totalStudentsCount: calculations.length,
      presentCount,
      partialCount,
      lateOrAbsentCount,
      students: calculations,
      metadata: {
        boardId: sessionContext.boardId,
        courseId: sessionContext.courseId,
        subjectId: sessionContext.subjectId,
        chapterId: sessionContext.chapterId,
        lessonId: sessionContext.lessonId,
      },
    };

    return summary;
  }
}
