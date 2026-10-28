import { redis } from '../../config/redis';
import { getDataProvider, getStorageProvider } from '../../adapters';
import {
  BroadcastMode,
  BroadcastPacket,
  SessionContext,
  SessionSnapshot,
  SessionStatus,
  TeacherCam,
} from '../../types/broadcast.types';

export class RoomManager {
  private static RING_BUFFER_MAX = 500;
  private static ACTIVE_SESSIONS_KEY = 'active_broadcast_sessions';

  private static keyPrefix(sessionId: string): string {
    return `room:${sessionId}`;
  }

  /**
   * Lists all active broadcast session IDs tracked in Redis.
   */
  public static async getActiveSessions(): Promise<string[]> {
    const members = await redis.smembers(this.ACTIVE_SESSIONS_KEY);
    if (!members || members.length === 0) {
      return [];
    }
    return members;
  }

  /**
   * Initializes or fetches room session state from Redis or DataProvider.
   */
  public static async getOrInitRoom(sessionId: string, languageId?: string): Promise<SessionSnapshot> {
    const key = `${this.keyPrefix(sessionId)}:snapshot`;
    const cached = await redis.get(key);
    const provider = getDataProvider();

    if (cached) {
      try {
        const parsed = JSON.parse(cached) as SessionSnapshot;
        if (parsed.status === 'ENDED') {
          await redis.srem(this.ACTIVE_SESSIONS_KEY, sessionId);
        } else {
          await redis.sadd(this.ACTIVE_SESSIONS_KEY, sessionId);
        }
        const seqRaw = await redis.get(`${this.keyPrefix(sessionId)}:seq_counter`);
        if (seqRaw) {
          parsed.seqId = Number(seqRaw) || parsed.seqId;
        }
        const isStaleMock =
          parsed.sessionContext?.courseId === 'course_phys_class10' ||
          parsed.sessionContext?.lessonId === 'les_ohms_law';
        const isLangChanged =
          Boolean(languageId) &&
          String(parsed.sessionContext?.languageId || '') !== String(languageId);

        if (isStaleMock || isLangChanged) {
          const freshCtx = await provider.getSessionContext(sessionId, languageId);
          if (freshCtx) {
            parsed.sessionContext = freshCtx;
            if (isStaleMock || !parsed.contentState?.activeLessonId || parsed.contentState.activeLessonId === 'les_ohms_law') {
              parsed.contentState = {
                ...parsed.contentState,
                activeLessonId: String(freshCtx.lessonId || ''),
                activeTopicId: String(freshCtx.topicId || ''),
              };
            }
            await redis.set(key, JSON.stringify(parsed));
            await redis.set(`${this.keyPrefix(sessionId)}:context`, JSON.stringify(freshCtx));
          }
        }
        return parsed;
      } catch {
        // Fallback to fresh init
      }
    }

    await redis.sadd(this.ACTIVE_SESSIONS_KEY, sessionId);

    const parsedMatch = /^session_b(\d+)_c(\d+)_/i.exec(sessionId);
    const fallbackBatchId = parsedMatch ? parsedMatch[1] : sessionId;
    const fallbackCourseId = parsedMatch ? parsedMatch[2] : '1';

    const context: SessionContext = (await provider.getSessionContext(sessionId, languageId)) || {
      sessionId,
      branchId: '1',
      boardId: '1',
      languageId: String(languageId || '1'),
      courseId: fallbackCourseId,
      courseName: 'Live Course',
      subjectId: '1',
      subjectName: 'Course Subject',
      chapterId: '1',
      chapterTitle: 'Chapter 1',
      lessonId: '1',
      lessonTitle: 'Lesson 1',
      topicId: '',
      topicTitle: '',
      batchId: fallbackBatchId,
      teacherId: '1',
      teacherName: 'Instructor',
      title: 'Live Classroom Session',
      startTime: new Date().toISOString(),
      maxStudentMics: 10,
      mode: 'CONTENT' as BroadcastMode,
      status: 'LIVE' as SessionStatus,
    };

    await redis.set(`${this.keyPrefix(sessionId)}:context`, JSON.stringify(context));

    const initialSnapshot: SessionSnapshot = {
      sessionId,
      seqId: 0,
      mode: context.mode || 'CONTENT',
      status: 'LIVE',
      sessionContext: context,
      teacherCam: {
        Cx: 0,
        Cy: 0,
        Zt: 1.0,
        Wt: 1920,
        Ht: 1080,
      },
      whiteboardCursor: {
        Lx: 0,
        Ly: 0,
        active: false,
      },
      excalidrawElements: [],
      contentState: {
        sessionId,
        activeLessonId: String(context.lessonId || ''),
        activeTopicId: String(context.topicId || ''),
        activeBlockId: 'blk_header',
        blockOffsetRatio: 0,
        penStrokes: [],
        laserPointer: { x: 0, y: 0, active: false },
      },
      audioStage: {
        activeStudentMics: [],
        raisedHands: [],
        maxStudentMics: 10,
      },
      lastSavedAt: Date.now(),
    };

    await redis.set(key, JSON.stringify(initialSnapshot));
    await redis.setnx(`${this.keyPrefix(sessionId)}:seq_counter`, 0);

    // Sync initial session state into local storage_cache/ mirror
    try {
      await getStorageProvider().syncSessionState(sessionId, initialSnapshot);
    } catch {
      // Non-blocking storage cache sync
    }

    return initialSnapshot;
  }

  /**
   * Generates next monotonically increasing seqId for room.
   */
  public static async nextSeqId(sessionId: string): Promise<number> {
    return await redis.incr(`${this.keyPrefix(sessionId)}:seq_counter`);
  }

  /**
   * Stores a broadcast packet into the 500-item sequence ring buffer.
   */
  public static async appendPacket(
    sessionId: string,
    type: string,
    payload: any
  ): Promise<BroadcastPacket> {
    const seqId = await this.nextSeqId(sessionId);
    const packet: BroadcastPacket = {
      seqId,
      type,
      timestamp: Date.now(),
      payload,
    };

    const bufferKey = `${this.keyPrefix(sessionId)}:ring_buffer`;
    const serialized = JSON.stringify(packet);

    const pipeline = redis.pipeline();
    pipeline.lpush(bufferKey, serialized);
    pipeline.ltrim(bufferKey, 0, this.RING_BUFFER_MAX - 1);
    await pipeline.exec();

    return packet;
  }

  /**
   * Replays missed packets after reconnect.
   * If lastSeqId is too stale (not in buffer), returns full snapshot.
   */
  public static async getMissedPackets(
    sessionId: string,
    lastSeqId: number
  ): Promise<{ needsFullSnapshot: boolean; packets: BroadcastPacket[]; snapshot?: SessionSnapshot }> {
    const bufferKey = `${this.keyPrefix(sessionId)}:ring_buffer`;
    const rawItems = await redis.lrange(bufferKey, 0, -1);

    if (!rawItems || rawItems.length === 0) {
      const snapshot = await this.getOrInitRoom(sessionId);
      return { needsFullSnapshot: true, packets: [], snapshot };
    }

    const packets: BroadcastPacket[] = rawItems
      .map((item: string) => JSON.parse(item) as BroadcastPacket)
      .reverse(); // ascending order

    const oldestInBuffer = packets[0]?.seqId ?? 0;
    const currentSeqId = packets[packets.length - 1]?.seqId ?? 0;

    // If client is already up-to-date
    if (lastSeqId >= currentSeqId) {
      return { needsFullSnapshot: false, packets: [] };
    }

    // If client missed packets that have already been evicted from the 500-item ring buffer, full snapshot is required
    if (lastSeqId < oldestInBuffer - 1) {
      const snapshot = await this.getOrInitRoom(sessionId);
      return { needsFullSnapshot: true, packets: [], snapshot };
    }

    // Replay filtered packets
    const deltaPackets = packets.filter((p) => p.seqId > lastSeqId);
    return { needsFullSnapshot: false, packets: deltaPackets };
  }

  /**
   * Updates and saves the current room snapshot in Redis and automatically updates/invalidates
   * the local `storage_cache/` mirror whenever session state changes.
   */
  public static async updateSnapshot(
    sessionId: string,
    partial: Partial<SessionSnapshot>
  ): Promise<SessionSnapshot> {
    const current = await this.getOrInitRoom(sessionId);
    const updated: SessionSnapshot = {
      ...current,
      ...partial,
      lastSavedAt: Date.now(),
    };

    await redis.set(`${this.keyPrefix(sessionId)}:snapshot`, JSON.stringify(updated));

    try {
      await getStorageProvider().syncSessionState(sessionId, updated);
    } catch {
      // Non-blocking storage cache sync
    }

    return updated;
  }

  /**
   * Changes room mode (CONTENT | WHITEBOARD | ROUGH_PAD).
   */
  public static async setMode(sessionId: string, mode: BroadcastMode): Promise<BroadcastPacket> {
    await this.updateSnapshot(sessionId, { mode });
    return await this.appendPacket(sessionId, 'MODE_CHANGE', { mode });
  }

  /**
   * Sets teacher connection status.
   */
  public static async setTeacherStatus(
    sessionId: string,
    status: SessionStatus
  ): Promise<BroadcastPacket> {
    if (status === 'LIVE') {
      await redis.sadd('active_broadcast_sessions', sessionId);
    }
    await this.updateSnapshot(sessionId, { status });
    return await this.appendPacket(sessionId, 'TEACHER_STATUS_CHANGE', { status });
  }

  /**
   * Marks a session as officially ended and removes it from active broadcast sessions.
   */
  public static async endSession(sessionId: string): Promise<BroadcastPacket> {
    await redis.srem('active_broadcast_sessions', sessionId);
    await this.updateSnapshot(sessionId, { status: 'ENDED' });
    return await this.appendPacket(sessionId, 'SESSION_ENDED', { sessionId, endedAt: Date.now() });
  }
}
