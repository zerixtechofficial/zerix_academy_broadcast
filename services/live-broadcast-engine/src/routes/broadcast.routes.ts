import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Type } from '@sinclair/typebox';
import { getDataProvider, getStorageProvider } from '../adapters';
import { RoomManager } from '../modules/room/room.manager';
import { AudioStageController } from '../modules/audio-stage/audio.controller';
import { AttendanceEngine } from '../modules/attendance/attendance.engine';
import { WhiteboardEngine } from '../modules/whiteboard/whiteboard.engine';
import { ContentEngine } from '../modules/content-sync/content.engine';
import { AutoSaveService } from '../modules/autosave/autosave.worker';
import { getSessionTimelineTracker } from '../modules/session-timeline/sessionTimeline.tracker';
import { authenticateFastify, requireTeacherFastify } from '../middlewares/jwtAuth';
import { FileCache } from '../utils/fileCache';
import { RelationalLessonContext } from '../types/broadcast.types';
import {
  TelegramMonitorService,
  notifyTelegramErrorAsync,
  sendTelegramMessageAsync,
} from '../modules/monitoring/telegram.service';
import * as path from 'path';

export const broadcastRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const provider = getDataProvider();

  // Register binary body parsers so 720p video chunks can be uploaded as raw binary
  // (`application/octet-stream`, `video/webm`, `video/mp4`) in addition to JSON base64
  for (const mime of ['application/octet-stream', 'video/webm', 'video/mp4']) {
    if (!fastify.hasContentTypeParser(mime)) {
      fastify.addContentTypeParser(
        mime,
        { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 },
        (_req, body, done) => {
          done(null, body);
        }
      );
    }
  }

  // 1. Health & Readiness Check
  fastify.get('/health', async (request, reply) => {
    const storageCfg = getStorageProvider().getConfig();
    return {
      status: 'healthy',
      service: 'live-broadcast-engine',
      nodeVersion: process.version,
      mode: provider.mode,
      storage: {
        driver: storageCfg.driver,
        backend: storageCfg.backend,
        region: storageCfg.region,
        bucket: storageCfg.bucket,
        endpoint: storageCfg.endpoint || null,
        publicCdnUrl: storageCfg.publicCdnUrl || null,
        cacheDir: storageCfg.cacheDir,
      },
      timestamp: new Date().toISOString(),
    };
  });

  // 2. Dev Testing Profiles (Teacher + 12 Students)
  fastify.get('/api/v1/dev/users', async (request, reply) => {
    if (
      process.env.NODE_ENV === 'production' ||
      process.env.ALLOW_DEV_TOKENS === 'false' ||
      provider.mode !== 'mock_json'
    ) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Dev testing profiles endpoint is disabled outside standalone mock development mode.',
      });
    }
    try {
      const devTokensPath = path.resolve(__dirname, '../../mock-data/dev-tokens.json');
      const data = await FileCache.readJson<any>(devTokensPath);
      return {
        success: true,
        data,
      };
    } catch (err: any) {
      return reply.status(500).send({
        success: false,
        message: `Failed to load dev users: ${err.message}`,
      });
    }
  });

  // 3. Curriculum Sidebar Tree
  fastify.get(
    '/api/v1/curriculum/:courseId',
    {
      schema: {
        params: Type.Object({
          courseId: Type.String({ minLength: 1, description: 'Course ID' }),
        }),
      },
    },
    async (request, reply) => {
      const { courseId } = request.params as { courseId: string };
      const curriculum = await provider.getCurriculumSidebar(courseId);
      if (!curriculum) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'NotFound',
          message: `Curriculum not found for course '${courseId}'.`,
        });
      }
      return { success: true, data: curriculum };
    }
  );

  // 4. Lesson 800px Virtual Page Blocks
  fastify.get(
    '/api/v1/lessons/:lessonId/content',
    {
      schema: {
        params: Type.Object({
          lessonId: Type.String({ minLength: 1, description: 'Lesson ID' }),
        }),
      },
    },
    async (request, reply) => {
      const { lessonId } = request.params as { lessonId: string };
      const content = await provider.getLessonContent(lessonId);
      if (!content) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'NotFound',
          message: `Content blocks not found for lesson '${lessonId}'.`,
        });
      }
      return { success: true, data: content };
    }
  );

  // 5. Initialize / Join Session
  fastify.post(
    '/api/v1/sessions/init',
    {
      schema: {
        body: Type.Object({
          sessionId: Type.String({ minLength: 1, description: 'Unique Session ID' }),
          token: Type.Optional(Type.String()),
          role: Type.Optional(Type.Union([Type.Literal('teacher'), Type.Literal('student')])),
          studentId: Type.Optional(Type.String()),
          teacherId: Type.Optional(Type.String()),
          deviceId: Type.Optional(Type.String()),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        sessionId: string;
        token?: string;
        role?: 'teacher' | 'student';
        studentId?: string;
        teacherId?: string;
        deviceId?: string;
      };

      let authToken = body.token;
      if (!authToken) {
        if (body.role === 'teacher') {
          const cleanTeacherId = body.teacherId
            ? String(body.teacherId).replace(/^teacher_/, '')
            : '501';
          authToken = `DEV_TOKEN_TEACHER_${cleanTeacherId}`;
        } else {
          authToken = `DEV_TOKEN_STUDENT_${body.studentId || '101'}`;
        }
      }

      const user = await provider.validateToken(authToken, body.sessionId);
      if (!user) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Invalid credentials or dev token for session initialization.',
        });
      }

      let room = await RoomManager.getOrInitRoom(body.sessionId);
      if (user.role === 'teacher' && room.status !== 'LIVE') {
        await AutoSaveService.cancelTeacherGraceTimer(body.sessionId);
        await RoomManager.setTeacherStatus(body.sessionId, 'LIVE');
        room = await RoomManager.getOrInitRoom(body.sessionId);
      }
      const [elements, files, cam, cursor, contentState, audioStage, liveAttendance] =
        await Promise.all([
          WhiteboardEngine.getAllElements(body.sessionId),
          WhiteboardEngine.getAllFiles(body.sessionId),
          WhiteboardEngine.getTeacherCam(body.sessionId),
          WhiteboardEngine.getTeacherCursor(body.sessionId),
          (await import('../modules/content-sync/content.engine')).ContentEngine.getState(
            body.sessionId
          ),
          AudioStageController.getStageState(body.sessionId),
          AttendanceEngine.getLiveAttendanceList(body.sessionId),
        ]);

      // Generate LiveKit SFU Token (with per-device identity when deviceId is provided)
      const livekit = await AudioStageController.getJoinToken(
        body.sessionId,
        user.userId,
        user.name,
        user.role,
        body.deviceId
      );

      // Schedule auto-save checkpoint if starting live session
      await AutoSaveService.scheduleNextCheckpoint(body.sessionId);

      return {
        success: true,
        data: {
          user,
          sessionContext: room.sessionContext,
          mode: room.mode,
          status: room.status,
          seqId: room.seqId,
          teacherCam: cam,
          whiteboardCursor: cursor,
          excalidrawElements: elements,
          excalidrawFiles: files,
          contentState,
          audioStage,
          attendance: liveAttendance,
          livekit: {
            token: livekit.token,
            url: livekit.url,
            canPublishAudio: livekit.canPublishAudio,
          },
        },
      };
    }
  );

  // 6. Fetch Room State Snapshot
  fastify.get(
    '/api/v1/sessions/:sessionId/state',
    {
      schema: {
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const room = await RoomManager.getOrInitRoom(sessionId);
      const [elements, files, cam, cursor, contentState, activeMics, raisedHands, liveAttendance] =
        await Promise.all([
          WhiteboardEngine.getAllElements(sessionId),
          WhiteboardEngine.getAllFiles(sessionId),
          WhiteboardEngine.getTeacherCam(sessionId),
          WhiteboardEngine.getTeacherCursor(sessionId),
          (await import('../modules/content-sync/content.engine')).ContentEngine.getState(sessionId),
          AudioStageController.getActiveStudentMics(sessionId),
          AudioStageController.getRaisedHands(sessionId),
          AttendanceEngine.getLiveAttendanceList(sessionId),
        ]);

      return {
        success: true,
        data: {
          ...room,
          teacherCam: cam,
          whiteboardCursor: cursor,
          excalidrawElements: elements,
          excalidrawFiles: files,
          contentState,
          audioStage: {
            activeStudentMics: activeMics,
            raisedHands,
            maxStudentMics: AudioStageController.MAX_CONCURRENT_STUDENT_MICS,
          },
          attendance: liveAttendance,
        },
      };
    }
  );

  // 7. Teacher Grants Mic (Strict Max 10 Rule)
  fastify.post(
    '/api/v1/sessions/:sessionId/audio/grant',
    {
      preHandler: [authenticateFastify],
      schema: {
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
        }),
        body: Type.Object({
          studentId: Type.String({ minLength: 1 }),
          forceReplaceOldest: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const { studentId, forceReplaceOldest } = request.body as {
        studentId: string;
        forceReplaceOldest?: boolean;
      };

      if (request.user?.role !== 'teacher') {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Only the session teacher is authorized to grant student microphone permissions.',
        });
      }

      try {
        const result = await AudioStageController.grantStudentMic(
          sessionId,
          studentId,
          Boolean(forceReplaceOldest)
        );

        return {
          success: true,
          message: `Microphone granted to student ${studentId}.`,
          data: result,
        };
      } catch (err: any) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'AudioConcurrencyLimitReached',
          message: err.message,
          canForceReplace: true,
        });
      }
    }
  );

  // 8. Teacher Mutes Individual Student
  fastify.post(
    '/api/v1/sessions/:sessionId/audio/mute',
    {
      preHandler: [authenticateFastify],
      schema: {
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
        }),
        body: Type.Object({
          studentId: Type.String({ minLength: 1 }),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const { studentId } = request.body as { studentId: string };

      if (request.user?.role !== 'teacher') {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Only the teacher can mute a student.',
        });
      }

      await AudioStageController.muteStudent(sessionId, studentId);
      return { success: true, message: `Student ${studentId} microphone muted.` };
    }
  );

  // 9. Teacher Mutes All Students (Emergency Mute All)
  fastify.post(
    '/api/v1/sessions/:sessionId/audio/mute-all',
    {
      preHandler: [authenticateFastify],
      schema: {
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };

      if (request.user?.role !== 'teacher') {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Only the teacher can mute all students.',
        });
      }

      const muted = await AudioStageController.muteAllStudents(sessionId);
      return {
        success: true,
        message: `All ${muted.length} active student microphones muted immediately.`,
        data: { mutedStudents: muted },
      };
    }
  );

  // 10. Student Raises Hand
  fastify.post(
    '/api/v1/sessions/:sessionId/audio/raise-hand',
    {
      preHandler: [authenticateFastify],
      schema: {
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const user = request.user!;

      const result = await AudioStageController.raiseHand(sessionId, {
        userId: user.userId,
        name: user.name,
        avatar: user.avatar,
        rollNumber: user.rollNumber,
        raisedAt: Date.now(),
      });

      return {
        success: true,
        message: 'Hand raised successfully.',
        data: result,
      };
    }
  );

  // 11. Student Lowers Hand
  fastify.post(
    '/api/v1/sessions/:sessionId/audio/lower-hand',
    {
      preHandler: [authenticateFastify],
      schema: {
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const user = request.user!;

      await AudioStageController.lowerHand(sessionId, user.userId);
      return { success: true, message: 'Hand lowered.' };
    }
  );

  // 12. Teacher Explicitly Ends Session
  fastify.post(
    '/api/v1/sessions/:sessionId/end',
    {
      preHandler: [authenticateFastify],
      schema: {
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };

      if (request.user?.role !== 'teacher') {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Only the teacher can conclude the live broadcast.',
        });
      }

      const room = await RoomManager.getOrInitRoom(sessionId);
      if (!getStorageProvider().getSessionVideoState(sessionId).finalized) {
        await AutoSaveService.ensureSessionVodFinalized(sessionId);
      }
      const nowIso = new Date().toISOString();

      const summary = await AttendanceEngine.finalizeSessionAttendance(
        sessionId,
        room.sessionContext,
        room.sessionContext.startTime || nowIso,
        nowIso
      );

      await provider.publishSessionCompleted(summary);
      await RoomManager.endSession(sessionId);

      const io = (fastify as any).io;
      if (io) {
        const isHostEnder = await AudioStageController.isHostTeacher(
          sessionId,
          request.user,
          room?.sessionContext?.teacherId
        );
        const endedPayload = {
          sessionId,
          endedBy: request.user.name,
          endedByUserId: request.user.userId,
          endedByRole: isHostEnder ? 'host' : 'cohost',
          timestamp: Date.now(),
        };
        io.to(sessionId).emit('SESSION_ENDED', endedPayload);
        try {
          const roomSockets = await io.in(sessionId).fetchSockets();
          for (const s of roomSockets) {
            s.data.intentionalLeave = true;
          }
          setTimeout(() => {
            for (const s of roomSockets) {
              s.disconnect(true);
            }
          }, 120);
        } catch {
          // ignore
        }
      }

      return {
        success: true,
        message: `Live session ${sessionId} successfully ended. Attendance summary published.`,
        data: summary,
      };
    }
  );

  // 13. Live Attendance Metrics
  fastify.get(
    '/api/v1/sessions/:sessionId/attendance',
    {
      preHandler: [requireTeacherFastify],
      schema: {
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const room = await RoomManager.getOrInitRoom(sessionId);
      const onlineCount = await AttendanceEngine.getOnlineStudentCount(sessionId);

      const summary = await AttendanceEngine.finalizeSessionAttendance(
        sessionId,
        room.sessionContext,
        room.sessionContext.startTime || new Date().toISOString(),
        new Date().toISOString()
      );

      return {
        success: true,
        data: {
          onlineCount,
          summary,
        },
      };
    }
  );

  // 14. Room / Session Status (for Rejoin Screen & Room-Based Access Validation)
  fastify.get(
    '/api/v1/sessions/:sessionId/status',
    {
      schema: {
        params: Type.Object({
          sessionId: Type.String({ minLength: 1, description: 'Session ID' }),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const room = await RoomManager.getOrInitRoom(sessionId);
      const onlineCount = await AttendanceEngine.getOnlineStudentCount(sessionId);
      const isActive = room.status === 'LIVE' || room.status === 'TEACHER_RECONNECTING';

      let roomName =
        sessionId === 'batch_chemistry_102'
          ? 'Class 10 Chemistry — Batch B'
          : sessionId === 'batch_physics_101'
          ? 'Class 10 Physics — Batch A (Live)'
          : room.sessionContext?.batchName || room.sessionContext?.title || sessionId;

      return {
        success: true,
        data: {
          sessionId,
          status: room.status,
          isActive,
          roomName,
          title: room.sessionContext?.title || roomName,
          batchName: room.sessionContext?.batchName || roomName,
          courseName: room.sessionContext?.courseName || 'CBSE Live Curriculum',
          subjectName: room.sessionContext?.subjectName || 'Science',
          teacherName: room.sessionContext?.teacherName || 'Prof. Anand Sharma',
          lessonTitle: room.sessionContext?.lessonTitle || '',
          onlineCount,
          seqId: room.seqId,
        },
      };
    }
  );

  // ============================================================================
  // PHASE 1: CONTINUOUS 720p VIDEO CHUNK STREAMING, MULTI-TOPIC TIMELINE,
  // GZIP WHITEBOARD ARTIFACTS & HTTP 206 BYTE-RANGE STREAMING ROUTES
  // ============================================================================

  /**
   * Shared handler for `POST /api/v1/sessions/:sessionId/video-chunk` and
   * `POST /api/v1/sessions/:sessionId/lessons/:lessonId/video-chunk`.
   *
   * Appends a compressed 720p video chunk (`10000ms` + random `150ms–1850ms` client jitter)
   * into the session's single continuous recording (`video_720p.webm` or `.mp4`).
   * Switching lessons mid-session NEVER splits or restarts the video file.
   */
  const handleVideoChunkUpload = async (request: any, reply: any) => {
    const { sessionId, lessonId: paramLessonId } = request.params as {
      sessionId: string;
      lessonId?: string;
    };
    const query = (request.query || {}) as Record<string, any>;
    const headers = request.headers || {};

    let chunkBuffer: Buffer | null = null;
    let chunkIndexRaw: any =
      query.chunkIndex ?? headers['x-chunk-index'] ?? headers['x-video-chunk-index'];
    let mimeType =
      query.mimeType ||
      (headers['x-video-mime-type'] as string) ||
      'video/webm;codecs=vp9,opus';
    let relationalContext: Partial<RelationalLessonContext> = {};

    if (Buffer.isBuffer(request.body)) {
      chunkBuffer = request.body;
      relationalContext = {
        courseId: query.courseId ? Number(query.courseId) : undefined,
        boardId: query.boardId !== undefined ? Number(query.boardId) : undefined,
        languageId: query.languageId ? Number(query.languageId) : undefined,
        chapterId: query.chapterId ? Number(query.chapterId) : undefined,
        lessonId: paramLessonId
          ? Number(paramLessonId)
          : query.lessonId
          ? Number(query.lessonId)
          : undefined,
        topicId: query.topicId !== undefined ? Number(query.topicId) : undefined,
        version: query.version ? Number(query.version) : undefined,
        academicYear: query.academicYear ? Number(query.academicYear) : undefined,
      };
    } else if (request.body && typeof request.body === 'object') {
      const body = request.body as Record<string, any>;
      chunkIndexRaw = body.chunkIndex ?? chunkIndexRaw;
      mimeType = body.mimeType || mimeType;
      if (typeof body.chunkBase64 === 'string' && body.chunkBase64.length > 0) {
        const cleanedBase64 = body.chunkBase64.replace(/^data:[^;]+;base64,/, '');
        chunkBuffer = Buffer.from(cleanedBase64, 'base64');
      } else if (Array.isArray(body.chunkBytes)) {
        chunkBuffer = Buffer.from(body.chunkBytes);
      }
      relationalContext = {
        ...(body.relationalContext || {}),
        courseId: body.courseId ?? body.relationalContext?.courseId,
        boardId: body.boardId ?? body.relationalContext?.boardId,
        languageId: body.languageId ?? body.relationalContext?.languageId,
        chapterId: body.chapterId ?? body.relationalContext?.chapterId,
        lessonId:
          paramLessonId !== undefined
            ? Number(paramLessonId)
            : body.lessonId ?? body.relationalContext?.lessonId,
        topicId: body.topicId ?? body.relationalContext?.topicId,
        version: body.version ?? body.relationalContext?.version,
        academicYear: body.academicYear ?? body.relationalContext?.academicYear,
      };
    }

    const chunkIndex = Number(chunkIndexRaw);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      return reply.status(422).send({
        statusCode: 422,
        error: 'ValidationError',
        message: 'A valid non-negative integer chunkIndex is required for 720p video chunk upload.',
        details: [
          {
            field: 'chunkIndex',
            message: 'chunkIndex must be a non-negative integer (0, 1, 2, ...).',
          },
        ],
      });
    }

    if (!chunkBuffer || chunkBuffer.length === 0) {
      return reply.status(422).send({
        statusCode: 422,
        error: 'ValidationError',
        message: 'Video chunk payload cannot be empty.',
        details: [
          {
            field: 'chunk',
            message: 'Provide a non-empty binary body or base64-encoded chunkBase64 payload.',
          },
        ],
      });
    }

    const storageProvider = getStorageProvider();
    const tracker = getSessionTimelineTracker();

    // Ensure session timeline has relational context initialized
    const cleanRelCtx = Object.fromEntries(
      Object.entries(relationalContext).filter(([, v]) => v !== undefined && !Number.isNaN(v))
    ) as Partial<RelationalLessonContext>;

    let appendResult;
    try {
      appendResult = await storageProvider.appendVideoChunk(sessionId, chunkBuffer, {
        chunkIndex,
        mimeType,
        relationalContext: cleanRelCtx,
      });
    } catch (err: any) {
      return reply.status(422).send({
        statusCode: 422,
        error: 'ValidationError',
        message: err.message || 'Failed to append video chunk.',
      });
    }

    if (!appendResult.duplicateIgnored) {
      tracker.recordVideoChunkUploaded(
        sessionId,
        chunkIndex,
        chunkBuffer.length,
        cleanRelCtx
      );
    }

    return {
      success: true,
      message: appendResult.duplicateIgnored
        ? `Duplicate video chunk #${chunkIndex} safely ignored.`
        : `Video chunk #${chunkIndex} appended to continuous session stream.`,
      data: appendResult,
    };
  };

  // 15. Continuous 720p Session Video Chunk Upload Endpoint
  fastify.post(
    '/api/v1/sessions/:sessionId/video-chunk',
    { preHandler: [requireTeacherFastify] },
    handleVideoChunkUpload
  );

  // 15b. Lesson-Scoped Alias for 720p Video Chunk Upload (Appends to the SAME continuous session video)
  fastify.post(
    '/api/v1/sessions/:sessionId/lessons/:lessonId/video-chunk',
    { preHandler: [requireTeacherFastify] },
    handleVideoChunkUpload
  );

  // 16. Multi-Topic Curriculum Navigation Endpoint (Switches Lesson/Topic WITHOUT stopping video)
  const curriculumNavigateRouteOpts = {
    preHandler: [requireTeacherFastify],
    schema: {
      params: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
      }),
      body: Type.Object({
        chapterId: Type.Union([Type.Number({ minimum: 1 }), Type.String({ minLength: 1 })]),
        chapterNumber: Type.Optional(Type.Number()),
        chapterTitle: Type.Optional(Type.String()),
        lessonId: Type.Union([Type.Number({ minimum: 1 }), Type.String({ minLength: 1 })]),
        lessonNumber: Type.Optional(Type.String()),
        lessonTitle: Type.Optional(Type.String()),
        topicId: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Null()])),
        topicNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        topicTitle: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        videoOffsetSec: Type.Number({ minimum: 0 }),
        mode: Type.Optional(
          Type.Union([Type.Literal('taught'), Type.Literal('reference_only')])
        ),
        explicitModeLock: Type.Optional(Type.Boolean()),
        relationalContext: Type.Optional(Type.Record(Type.String(), Type.Any())),
      }),
    },
  };

  const handleCurriculumNavigate = async (request: any, reply: any) => {
    const { sessionId } = request.params as { sessionId: string };
    const body = request.body as {
      chapterId: number | string;
      chapterNumber?: number;
      chapterTitle?: string;
      lessonId: number | string;
      lessonNumber?: string;
      lessonTitle?: string;
      topicId?: number | string | null;
      topicNumber?: string | null;
      topicTitle?: string | null;
      videoOffsetSec: number;
      mode?: 'taught' | 'reference_only';
      explicitModeLock?: boolean;
      relationalContext?: Partial<RelationalLessonContext>;
    };

    const tracker = getSessionTimelineTracker();
    const navResult = tracker.navigateCurriculum({
      sessionId,
      ...body,
    });

    // Synchronize ContentEngine active lesson/topic state
    await ContentEngine.updateNavigation(
      sessionId,
      String(body.lessonId),
      body.topicId ? String(body.topicId) : ''
    );

    const io = (fastify as any).io;
    if (io) {
      io.to(sessionId).emit('CURRICULUM_SEGMENT_CHANGED', {
        sessionId,
        closedSegment: navResult.closedSegment,
        activeSegment: navResult.activeSegment,
      });
    }

    return {
      success: true,
      message:
        navResult.activeSegment.mode === 'reference_only'
          ? `Opened lesson ${body.lessonId} in reference_only mode (existing VOD & whiteboard protected).`
          : `Navigated to lesson ${body.lessonId} at ${body.videoOffsetSec}s in continuous session stream.`,
      data: navResult,
    };
  };

  fastify.post(
    '/api/v1/sessions/:sessionId/curriculum/navigate',
    curriculumNavigateRouteOpts,
    handleCurriculumNavigate
  );
  fastify.post(
    '/api/v1/sessions/:sessionId/curriculum-navigate',
    curriculumNavigateRouteOpts,
    handleCurriculumNavigate
  );

  // 17. Save Isolated Gzipped Whiteboard Artifact (`whiteboard.json`)
  const handleWhiteboardSave = async (request: any, reply: any) => {
    const { sessionId, lessonId: paramLessonId } = request.params as {
      sessionId: string;
      lessonId?: string;
    };
    const body = (request.body || {}) as {
      chapterId?: number | string;
      lessonId?: number | string;
      topicId?: number | string | null;
      elements?: any[];
      appState?: Record<string, any>;
      files?: Record<string, any>;
      pages?: any[];
      relationalContext?: Partial<RelationalLessonContext>;
      forceReferenceOnlySkip?: boolean;
    };

    if (!Array.isArray(body.elements)) {
      return reply.status(422).send({
        statusCode: 422,
        error: 'ValidationError',
        message: 'Whiteboard elements array is required to save whiteboard.json.',
        details: [
          {
            field: 'elements',
            message: 'elements must be a valid Excalidraw elements array.',
          },
        ],
      });
    }

    const tracker = getSessionTimelineTracker();
    const saveResult = await tracker.saveTopicWhiteboard(sessionId, {
      chapterId: body.chapterId,
      lessonId: paramLessonId !== undefined ? paramLessonId : body.lessonId,
      topicId: body.topicId,
      elements: body.elements,
      appState: body.appState,
      files: body.files,
      pages: body.pages,
      relationalContext: body.relationalContext,
      forceReferenceOnlySkip: body.forceReferenceOnlySkip,
    });

    return {
      success: true,
      message: saveResult.skippedAsReferenceOnly
        ? 'Lesson is in reference_only mode — existing whiteboard.json was protected and not overwritten.'
        : 'Gzipped whiteboard.json saved (Content Mode strokes excluded) and FileCache updated.',
      data: saveResult,
    };
  };

  fastify.post(
    '/api/v1/sessions/:sessionId/whiteboard/save',
    { preHandler: [requireTeacherFastify] },
    handleWhiteboardSave
  );
  fastify.post(
    '/api/v1/sessions/:sessionId/whiteboard-save',
    { preHandler: [requireTeacherFastify] },
    handleWhiteboardSave
  );
  fastify.post(
    '/api/v1/sessions/:sessionId/lessons/:lessonId/whiteboard',
    { preHandler: [requireTeacherFastify] },
    handleWhiteboardSave
  );

  // 18. Finalize Continuous Session Recording & Publish Taught Lesson VOD Artifacts
  const handleSessionFinalize = async (request: any, reply: any) => {
    const { sessionId, lessonId: paramLessonId } = request.params as {
      sessionId: string;
      lessonId?: string;
    };
    const body = (request.body || {}) as {
      relationalContext?: Partial<RelationalLessonContext>;
      totalDurationSec?: number;
      whiteboard?: {
        elements?: any[];
        appState?: Record<string, any>;
        files?: Record<string, any>;
        pages?: any[];
      };
    };

    const mergedContext: Partial<RelationalLessonContext> = {
      ...(body.relationalContext || {}),
      ...(paramLessonId !== undefined ? { lessonId: Number(paramLessonId) } : {}),
    };

    const tracker = getSessionTimelineTracker();
    const summary = await tracker.finalizeSession(sessionId, {
      relationalContext: Object.keys(mergedContext).length > 0 ? mergedContext : undefined,
      totalDurationSec: body.totalDurationSec,
      whiteboardPayload: body.whiteboard,
    });

    if (provider.publishSessionFinalizedArtifacts) {
      await provider.publishSessionFinalizedArtifacts(summary);
    }

    return {
      success: true,
      message: `Session ${sessionId} finalized: ${summary.publishedLessonArtifacts.length} taught lesson(s) published, ${summary.skippedReferenceLessons.length} reference-only lesson(s) protected from overwrite.`,
      data: summary,
    };
  };

  fastify.post(
    '/api/v1/sessions/:sessionId/finalize',
    { preHandler: [requireTeacherFastify] },
    handleSessionFinalize
  );
  fastify.post(
    '/api/v1/sessions/:sessionId/lessons/:lessonId/finalize',
    { preHandler: [requireTeacherFastify] },
    handleSessionFinalize
  );

  // 19. Inspect Session Multi-Topic Timeline & Continuous Video Recording State
  fastify.get(
    '/api/v1/sessions/:sessionId/timeline',
    {
      schema: {
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
        }),
      },
    },
    async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      const tracker = getSessionTimelineTracker();
      const storageProvider = getStorageProvider();
      return {
        success: true,
        data: {
          ...tracker.getSessionTimelineSnapshot(sessionId),
          videoState: storageProvider.getSessionVideoState(sessionId),
        },
      };
    }
  );

  // 20. HTTP 206 Byte-Range Video Streaming Endpoint (`GET /api/v1/stream/video/*`)
  fastify.get('/api/v1/stream/video/*', async (request, reply) => {
    const wildcardKey = (request.params as Record<string, string>)['*'] || '';
    if (!wildcardKey || wildcardKey.trim().length === 0) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'BadRequest',
        message: 'A valid video storage key path is required.',
      });
    }

    const rangeHeader = request.headers.range as string | undefined;
    const storageProvider = getStorageProvider();
    const streamResult = await storageProvider.createVideoByteRangeStream(
      wildcardKey,
      rangeHeader
    );

    if (!streamResult.found || streamResult.statusCode === 404) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'NotFound',
        message: `Recorded 720p video artifact not found for key "${wildcardKey}".`,
      });
    }

    for (const [headerName, headerVal] of Object.entries(streamResult.headers)) {
      reply.header(headerName, headerVal);
    }

    if (streamResult.statusCode === 302 && streamResult.redirectUrl) {
      return reply.status(302).redirect(streamResult.redirectUrl);
    }

    if (streamResult.statusCode === 416) {
      return reply.status(416).send({
        statusCode: 416,
        error: 'RangeNotSatisfiable',
        message: `Requested byte range "${rangeHeader}" is not satisfiable for file of size ${streamResult.totalSizeBytes} bytes.`,
      });
    }

    return reply.status(streamResult.statusCode).send(streamResult.stream);
  });

  // 21. Gzipped Whiteboard Artifact Retrieval Endpoint (`GET /api/v1/artifacts/whiteboard/*` & `/api/v1/stream/whiteboard/*`)
  const handleGetWhiteboardArtifact = async (request: any, reply: any) => {
    const wildcardKey = (request.params as Record<string, string>)['*'] || '';
    if (!wildcardKey || wildcardKey.trim().length === 0) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'BadRequest',
        message: 'A valid whiteboard storage key path is required.',
      });
    }

    const storageProvider = getStorageProvider();
    const result = await storageProvider.getGzippedWhiteboard(wildcardKey);

    if (!result) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'NotFound',
        message: `Whiteboard artifact not found for key "${wildcardKey}".`,
      });
    }

    const query = (request.query || {}) as Record<string, string>;
    const acceptEncoding = String(request.headers['accept-encoding'] || '');

    // If caller requests raw gzipped payload (`?rawGzip=1` or `Accept-Encoding: gzip` with `?format=raw`),
    // stream the cached gzipped Buffer directly with Content-Encoding: gzip (zero CPU overhead)
    if (query.rawGzip === '1' || (query.format === 'raw' && acceptEncoding.includes('gzip'))) {
      reply
        .header('Content-Type', 'application/json; charset=utf-8')
        .header('Content-Encoding', 'gzip')
        .header('Cache-Control', 'public, max-age=300');
      return reply.status(200).send(result.gzippedBuffer);
    }

    return {
      success: true,
      data: result.artifact,
      meta: {
        key: wildcardKey.replace(/^\/+/, ''),
        gzippedBytes: result.gzippedBuffer.length,
      },
    };
  };

  fastify.get('/api/v1/artifacts/whiteboard/*', handleGetWhiteboardArtifact);
  fastify.get('/api/v1/stream/whiteboard/*', handleGetWhiteboardArtifact);

  // ============================================================================
  // 22. SERVER HEALTH MONITORING & NON-BLOCKING TELEGRAM ALERT ENDPOINTS
  // ============================================================================

  // 22a. Detailed Server & Service Health Metrics
  fastify.get('/api/v1/monitoring/health', async () => {
    const report = await TelegramMonitorService.collectServerHealthMetrics();
    return {
      success: true,
      data: report,
    };
  });

  // 22b. Trigger Server Health Report or Custom Alert to Telegram Group (Non-Blocking by default)
  fastify.post('/api/v1/monitoring/health-report', async (request, reply) => {
    const body = (request.body || {}) as {
      title?: string;
      message?: string;
      WaitForDelivery?: boolean;
    };

    if (body.WaitForDelivery) {
      if (body.message) {
        const res = await TelegramMonitorService.sendTelegramMessage(body.message, {
          parseMode: 'HTML',
        });
        return { success: res.ok, data: res };
      }
      const { report, telegramResult } = await TelegramMonitorService.sendServerHealthReport({
        title: body.title,
      });
      return {
        success: telegramResult.ok,
        data: { telegramResult, report },
      };
    }

    // Default: dispatch asynchronously in the background so the HTTP request never blocks
    if (body.message) {
      sendTelegramMessageAsync(body.message, { parseMode: 'HTML' });
    } else {
      setImmediate(() => {
        void TelegramMonitorService.sendServerHealthReport({ title: body.title }).catch(() => {});
      });
    }

    return reply.status(202).send({
      success: true,
      queued: true,
      message: 'Telegram health report dispatched asynchronously in the background.',
    });
  });

  // 22c. Non-Blocking Client / Frontend Error Alert Endpoint
  fastify.post('/api/v1/monitoring/client-error', async (request, reply) => {
    const body = (request.body || {}) as {
      source?: string;
      message?: string;
      stack?: string;
      sessionId?: string;
      userId?: string;
      role?: string;
      url?: string;
    };

    const err = new Error(body.message || 'Unknown client runtime error');
    if (body.stack) {
      err.stack = body.stack;
    }

    notifyTelegramErrorAsync({
      source: body.source || 'Broadcast Frontend (Browser)',
      error: err,
      context: {
        sessionId: body.sessionId,
        userId: body.userId,
        role: body.role,
        url: body.url,
        ip: request.ip,
      },
    });

    return reply.status(202).send({
      success: true,
      queued: true,
    });
  });
};
