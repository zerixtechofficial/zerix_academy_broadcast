import { Queue, Worker, Job } from 'bullmq';
import { env } from '../../config/env';
import { redis } from '../../config/redis';
import { getDataProvider } from '../../adapters';
import { RoomManager } from '../room/room.manager';
import { WhiteboardEngine } from '../whiteboard/whiteboard.engine';
import { AttendanceEngine } from '../attendance/attendance.engine';
import { getSessionTimelineTracker } from '../session-timeline/sessionTimeline.tracker';
import { SessionSnapshot } from '../../types/broadcast.types';

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

      const [elements, files, cam] = await Promise.all([
        WhiteboardEngine.getAllElements(sessionId),
        WhiteboardEngine.getAllFiles(sessionId),
        WhiteboardEngine.getTeacherCam(sessionId),
      ]);

      const snapshot: SessionSnapshot = {
        ...room,
        teacherCam: cam,
        excalidrawElements: elements,
        excalidrawFiles: files,
        lastSavedAt: Date.now(),
      };

      const provider = getDataProvider();
      await provider.saveCheckpoint(sessionId, snapshot);

      // Re-schedule next checkpoint only if session is actively LIVE
      if (room.status === 'LIVE') {
        await this.scheduleNextCheckpoint(sessionId);
      }
    } catch (err: any) {
      console.error(`[AutoSaveService] Checkpoint failed for ${sessionId}:`, err.message);
    }
  }

  /**
   * Teacher lost connection: marks room TEACHER_RECONNECTING and arms the grace timer.
   */
  public static async startTeacherGraceTimer(sessionId: string): Promise<void> {
    console.log(
      `[AutoSaveService] Teacher disconnected from ${sessionId}. Starting grace timer (${env.TEACHER_GRACE_TIMEOUT_SECONDS}s)`
    );

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
        delay: env.TEACHER_GRACE_TIMEOUT_SECONDS * 1000,
        jobId,
        removeOnComplete: true,
        removeOnFail: true,
      }
    );
  }

  /**
   * Teacher reconnected: cancels the pending grace close timer and resumes LIVE status.
   */
  public static async cancelTeacherGraceTimer(sessionId: string): Promise<void> {
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
    }
  }

  /**
   * Grace timer expired: finalize VOD & whiteboard artifacts, finalize attendance,
   * publish session summary, and end room.
   */
  public static async executeGraceFinalize(sessionId: string): Promise<void> {
    try {
      const room = await RoomManager.getOrInitRoom(sessionId);
      if (room.status === 'ENDED') {
        return;
      }

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

      await RoomManager.endSession(sessionId);
      console.log(`[AutoSaveService] Session ${sessionId} cleanly finalized and archived.`);
    } catch (err: any) {
      console.error(`[AutoSaveService] Error in executeGraceFinalize for ${sessionId}:`, err.message);
    }
  }

  /**
   * Graceful shutdown of workers.
   */
  public static async close(): Promise<void> {
    if (this.checkpointWorker) await this.checkpointWorker.close();
    if (this.graceWorker) await this.graceWorker.close();
    if (this.checkpointQueue) await this.checkpointQueue.close();
    if (this.graceQueue) await this.graceQueue.close();
  }
}
