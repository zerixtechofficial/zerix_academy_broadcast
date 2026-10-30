import { Queue, Worker, Job } from 'bullmq';
import type { Server as SocketIOServer } from 'socket.io';
import { env } from '../../config/env';
import { redis } from '../../config/redis';
import { getDataProvider } from '../../adapters';
import { RoomManager } from '../room/room.manager';
import { WhiteboardEngine } from '../whiteboard/whiteboard.engine';
import { AttendanceEngine } from '../attendance/attendance.engine';
import { getSessionTimelineTracker } from '../session-timeline/sessionTimeline.tracker';
import { SessionSnapshot } from '../../types/broadcast.types';
import { notifyTelegramErrorAsync } from '../monitoring/telegram.service';

const bullmqConnection = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD || undefined,
  db: env.REDIS_DB,
  maxRetriesPerRequest: null,
};

export class AutoSaveService {
  private static checkpointQueue = new Queue('broadcast-checkpoints', {
    connection: bullmqConnection,
  });

  private static graceQueue = new Queue('teacher-grace-closer', {
    connection: bullmqConnection,
  });

  private static checkpointWorker: Worker;
  private static graceWorker: Worker;
  private static ioServer: SocketIOServer | null = null;
  private static inMemoryGraceTimers = new Map<string, NodeJS.Timeout>();
  private static graceEndsAtMap = new Map<string, number>();

  /**
   * Attaches the active Socket.IO server instance so grace expiration can notify and disconnect all students.
   */
  public static setSocketServer(io: SocketIOServer | null): void {
    this.ioServer = io;
  }

  /**
   * Returns the unix timestamp (ms) when the active grace timer for a session expires, if armed.
   */
  public static getGraceEndsAt(sessionId: string): number | null {
    return this.graceEndsAtMap.get(sessionId) ?? null;
  }

  private static clearInMemoryGraceTimer(sessionId: string): void {
    const existingTimer = this.inMemoryGraceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.inMemoryGraceTimers.delete(sessionId);
    }
    this.graceEndsAtMap.delete(sessionId);
  }

  /**
   * Initializes BullMQ queues and workers for checkpoints and teacher grace closing.
   */
  public static init(): void {
    // 1. Worker for periodic room state checkpoints (30s + jitter)
    this.checkpointWorker = new Worker(
      'broadcast-checkpoints',
      async (job: Job<{ sessionId: string }>) => {
        const { sessionId } = job.data;
        await this.performCheckpoint(sessionId);
      },
      { connection: bullmqConnection, concurrency: 5 }
    );

    this.checkpointWorker.on('error', (err) => {
      console.error('[AutoSaveService:CheckpointWorker] Worker error:', err.message);
      notifyTelegramErrorAsync({
        source: 'BullMQ CheckpointWorker',
        error: err,
      });
    });

    // 2. Worker for 5-minute teacher disconnect grace timeout
    this.graceWorker = new Worker(
      'teacher-grace-closer',
      async (job: Job<{ sessionId: string }>) => {
        const { sessionId } = job.data;
        console.log(`[AutoSaveService] Teacher grace window expired for session: ${sessionId}. Finalizing...`);
        await this.executeGraceFinalize(sessionId);
      },
      { connection: bullmqConnection, concurrency: 5 }
    );

    this.graceWorker.on('error', (err) => {
      console.error('[AutoSaveService:GraceWorker] Worker error:', err.message);
      notifyTelegramErrorAsync({
        source: 'BullMQ GraceWorker',
        error: err,
      });
    });

    console.log('[AutoSaveService] Background checkpoint & teacher grace workers initialized.');
  }

  /**
   * Schedules a jittered checkpoint job for an active session (30 + rand(1, 8) seconds).
   * Uses a deterministic jobId per session so concurrent user joins never spawn duplicate loops.
   */
  public static async scheduleNextCheckpoint(sessionId: string): Promise<void> {
    const jitter = Math.floor(Math.random() * 8) + 1;
    const intervalSeconds = env.CHECKPOINT_INTERVAL_SECONDS + jitter;

    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const jobId = `chk_${safeSessionId}`;

    try {
      const existing = await this.checkpointQueue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === 'delayed' || state === 'waiting' || state === 'active') {
          return;
        }
        await existing.remove().catch(() => {});
      }
    } catch {
      // Ignore lookup errors
    }

    await this.checkpointQueue.add(
      `checkpoint_${safeSessionId}`,
      { sessionId },
      {
        delay: intervalSeconds * 1000,
        jobId,
        removeOnComplete: true,
        removeOnFail: true,
      }
    );
  }

  /**
   * Flushes dirty room state to R2 / Local Disk storage.
   */
  public static async performCheckpoint(sessionId: string): Promise<void> {
    try {
      const room = await RoomManager.getOrInitRoom(sessionId);
      if (room.status === 'ENDED') {
        return;
      }

      const nowIso = new Date().toISOString();
      const [elements, files, cam, attendanceSummary] = await Promise.all([
        WhiteboardEngine.getAllElements(sessionId),
        WhiteboardEngine.getAllFiles(sessionId),
        WhiteboardEngine.getTeacherCam(sessionId),
        AttendanceEngine.finalizeSessionAttendance(
          sessionId,
          room.sessionContext,
          room.sessionContext?.startTime || nowIso,
          nowIso
        ),
      ]);

      const elapsedSeconds = attendanceSummary.totalClassDurationSeconds || 0;
      const totalDurationMinutes = Math.round((elapsedSeconds / 60) * 100) / 100;

      const snapshot: SessionSnapshot = {
        ...room,
        teacherCam: cam,
        excalidrawElements: elements,
        excalidrawFiles: files,
        lastSavedAt: Date.now(),
        elapsedSeconds,
        totalDurationMinutes,
        students: attendanceSummary.students,
        records: attendanceSummary.students,
      };

      const provider = getDataProvider();
      await provider.saveCheckpoint(sessionId, snapshot);

      // Re-schedule next checkpoint only if session is actively LIVE
      if (room.status === 'LIVE') {
        await this.scheduleNextCheckpoint(sessionId);
      }
    } catch (err: any) {
      console.error(`[AutoSaveService] Checkpoint failed for ${sessionId}:`, err.message);
      notifyTelegramErrorAsync({
        source: 'AutoSaveService.performCheckpoint',
        error: err,
        context: { sessionId },
      });
    }
  }

  /**
   * Last Host/Co-Host left or lost connection: marks room TEACHER_RECONNECTING and arms the 5-minute grace timer.
   */
  public static async startTeacherGraceTimer(
    sessionId: string,
    overrideTimeoutSeconds?: number
  ): Promise<{ gracePeriodSeconds: number; graceEndsAt: number }> {
    const gracePeriodSeconds =
      typeof overrideTimeoutSeconds === 'number' && overrideTimeoutSeconds > 0
        ? overrideTimeoutSeconds
        : env.TEACHER_GRACE_TIMEOUT_SECONDS;
    const delayMs = gracePeriodSeconds * 1000;
    const graceEndsAt = Date.now() + delayMs;

    console.log(
      `[AutoSaveService] No active Host/Co-Host in ${sessionId}. Starting grace timer (${gracePeriodSeconds}s)`
    );

    this.clearInMemoryGraceTimer(sessionId);
    this.graceEndsAtMap.set(sessionId, graceEndsAt);

    // Arm in-memory fallback timer alongside BullMQ so single-node / test / workerless environments also close cleanly
    const memTimer = setTimeout(() => {
      this.inMemoryGraceTimers.delete(sessionId);
      void this.executeGraceFinalize(sessionId);
    }, delayMs);
    if (typeof memTimer.unref === 'function') {
      memTimer.unref();
    }
    this.inMemoryGraceTimers.set(sessionId, memTimer);

    // Update room status
    await RoomManager.setTeacherStatus(sessionId, 'TEACHER_RECONNECTING');

    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const jobId = `grace_close_${safeSessionId}`;

    // Remove any pre-existing grace job for this session before creating new
    try {
      const existingJob = await this.graceQueue.getJob(jobId);
      if (existingJob) {
        await existingJob.remove();
      }
    } catch {
      // Ignore
    }

    await this.graceQueue.add(
      'grace-close',
      { sessionId },
      {
        delay: delayMs,
        jobId,
        removeOnComplete: true,
        removeOnFail: true,
      }
    );

    return { gracePeriodSeconds, graceEndsAt };
  }

  /**
   * Host or Co-Host connected/reconnected: cancels the pending grace close timer and resumes LIVE status.
   */
  public static async cancelTeacherGraceTimer(sessionId: string): Promise<void> {
    this.clearInMemoryGraceTimer(sessionId);

    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const jobId = `grace_close_${safeSessionId}`;
    try {
      const job = await this.graceQueue.getJob(jobId);
      if (job) {
        await job.remove();
        console.log(`[AutoSaveService] Teacher reconnected! Successfully cancelled grace timer for ${sessionId}.`);
      }
    } catch (err: any) {
      console.warn(`[AutoSaveService] Note during grace timer cancel: ${err.message}`);
    }

    await RoomManager.setTeacherStatus(sessionId, 'LIVE');
  }

  /**
   * Ensures the continuous 720p video stream and active lesson Whiteboard JSON are finalized
   * and published when a session ends via grace timeout or explicit teacher end action.
   */
  public static async ensureSessionVodFinalized(sessionId: string): Promise<void> {
    try {
      const [elements, files] = await Promise.all([
        WhiteboardEngine.getAllElements(sessionId),
        WhiteboardEngine.getAllFiles(sessionId),
      ]);

      const tracker = getSessionTimelineTracker();
      const finalizedSummary = await tracker.finalizeSession(sessionId, {
        whiteboardPayload: {
          elements,
          files,
        },
      });

      const provider = getDataProvider();
      if (provider.publishSessionFinalizedArtifacts) {
        await provider.publishSessionFinalizedArtifacts(finalizedSummary);
      }
    } catch (err: any) {
      console.error(
        `[AutoSaveService] VOD/Whiteboard finalization error for ${sessionId}:`,
        err.message
      );
      notifyTelegramErrorAsync({
        source: 'AutoSaveService.ensureSessionVodFinalized',
        error: err,
        context: { sessionId },
      });
    }
  }

  /**
   * Grace timer expired: if no Host or Co-Host is active in the room, finalize VOD & whiteboard artifacts,
   * finalize attendance, publish session summary, end room, and disconnect all remaining students.
   */
  public static async executeGraceFinalize(sessionId: string): Promise<void> {
    this.clearInMemoryGraceTimer(sessionId);
    try {
      const room = await RoomManager.getOrInitRoom(sessionId);
      if (room.status === 'ENDED') {
        return;
      }

      // Verify no Host or Co-Host rejoined before closing the broadcast
      if (this.ioServer) {
        const currentSockets = await this.ioServer.in(sessionId).fetchSockets();
        const hasActiveHostOrCoHost = currentSockets.some(
          (s: any) => s.user?.role === 'teacher' && !s.data?.intentionalLeave
        );
        if (hasActiveHostOrCoHost) {
          await RoomManager.setTeacherStatus(sessionId, 'LIVE');
          return;
        }
      }

      await RoomManager.endSession(sessionId);

      await this.ensureSessionVodFinalized(sessionId);

      const nowIso = new Date().toISOString();
      const summary = await AttendanceEngine.finalizeSessionAttendance(
        sessionId,
        room.sessionContext,
        room.sessionContext.startTime || nowIso,
        nowIso
      );

      const provider = getDataProvider();
      await provider.publishSessionCompleted(summary);

      // Notify all connected students that the broadcast closed after 5-min Host/Co-Host inactivity and disconnect them
      if (this.ioServer) {
        const endedPayload = {
          sessionId,
          endedBy: 'System (5-Min Host/Co-Host Inactivity Timeout)',
          endedByRole: 'system',
          reason: 'NO_ACTIVE_HOST_OR_COHOST_TIMEOUT',
          message:
            'Broadcast closed automatically because no Host or Co-Host was active for 5 minutes.',
          timestamp: Date.now(),
        };
        this.ioServer.to(sessionId).emit('SESSION_ENDED', endedPayload);

        const roomSockets = await this.ioServer.in(sessionId).fetchSockets();
        for (const s of roomSockets) {
          s.data.intentionalLeave = true;
        }
        setTimeout(() => {
          for (const s of roomSockets) {
            s.disconnect(true);
          }
        }, 120);
      }

      console.log(`[AutoSaveService] Session ${sessionId} cleanly finalized and archived.`);
    } catch (err: any) {
      console.error(`[AutoSaveService] Error in executeGraceFinalize for ${sessionId}:`, err.message);
      notifyTelegramErrorAsync({
        source: 'AutoSaveService.executeGraceFinalize',
        error: err,
        context: { sessionId },
      });
    }
  }

  /**
   * Graceful shutdown of workers.
   */
  public static async close(): Promise<void> {
    for (const timer of this.inMemoryGraceTimers.values()) {
      clearTimeout(timer);
    }
    this.inMemoryGraceTimers.clear();
    this.graceEndsAtMap.clear();
    this.ioServer = null;
    if (this.checkpointWorker) await this.checkpointWorker.close();
    if (this.graceWorker) await this.graceWorker.close();
    if (this.checkpointQueue) await this.checkpointQueue.close();
    if (this.graceQueue) await this.graceQueue.close();
  }
}
