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
import { JwtVerifier } from '../utils/jwtVerifier';
import { FileCache } from '../utils/fileCache';
import { RelationalLessonContext } from '../types/broadcast.types';
import {
  TelegramMonitorService,
  notifyTelegramErrorAsync,
  sendTelegramMessageAsync,
} from '../modules/monitoring/telegram.service';
import * as path from 'path';
import * as crypto from 'crypto';

export const broadcastRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const provider = getDataProvider();

  const mintCoHostInviteToken = (
    sessionId: string,
    sessionContext: any,
    options?: { canUseWhiteboard?: boolean; label?: string }
  ): string => {
    const canUseWb = Boolean(options?.canUseWhiteboard);
    return JwtVerifier.sign({
      sub: 'cohost_invite',
      userId: 'cohost_invite',
      name: options?.label || 'Co-Host Teacher',
      role: 'teacher',
      sessionId,
      courseId: Number(sessionContext?.courseId || 1),
      batchId: sessionContext?.batchId || 1,
      branchId: Number(sessionContext?.branchId || 1),
      languageId: String(sessionContext?.languageId || '1'),
      chapterId: String(sessionContext?.chapterId || '1'),
      lessonId: String(sessionContext?.lessonId || '1'),
      topicId: String(sessionContext?.topicId || ''),
      isCoTeacher: true,
      isCoHostInvite: true,
      canUseWhiteboard: canUseWb,
      exp: Math.floor(Date.now() / 1000) + 6 * 3600,
    });
  };

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

  // 2. Dev Testing Profiles (Strictly Disabled in Server Mode)
  fastify.get('/api/v1/dev/users', async (_request, reply) => {
    return reply.status(403).send({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Dev testing profiles endpoint is disabled.',
    });
  });

  // 3. Curriculum Sidebar Tree
  fastify.get(
    '/api/v1/curriculum/:courseId',
    {
      preHandler: [authenticateFastify],
      schema: {
        params: Type.Object({
          courseId: Type.String({ minLength: 1, description: 'Course ID' }),
        }),
      },
    },
    async (request, reply) => {
      const { courseId } = request.params as { courseId: string };
      const query = (request.query || {}) as Record<string, any>;
      const languageId =
        query.language_id || query.languageId || request.user?.languageId || undefined;
      const userId = query.user_id || query.userId || request.user?.userId || undefined;
      const curriculum = await provider.getCurriculumSidebar(
        courseId,
        languageId ? String(languageId) : undefined,
        userId ? String(userId) : undefined
      );
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
      preHandler: [authenticateFastify],
      schema: {
        params: Type.Object({
          lessonId: Type.String({ minLength: 1, description: 'Lesson ID' }),
        }),
      },
    },
    async (request, reply) => {
      const { lessonId } = request.params as { lessonId: string };
      const query = (request.query || {}) as Record<string, any>;
      const languageId =
        query.language_id || query.languageId || request.user?.languageId || undefined;
      const topicId = query.topic_id || query.topicId || undefined;
      const userId = query.user_id || query.userId || request.user?.userId || undefined;
      const content = await provider.getLessonContent(
        lessonId,
        languageId ? String(languageId) : undefined,
        topicId ? String(topicId) : undefined,
        userId ? String(userId) : undefined
      );
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

  // 4b. Mark Lesson or Topic as Completed (Student and Teacher separately)
  fastify.post(
    '/api/v1/content/:contentId/complete',
    {
      preHandler: [authenticateFastify],
      schema: {
        params: Type.Object({
          contentId: Type.String({ minLength: 1, description: 'Lesson or Topic ID' }),
        }),
        body: Type.Object({
          type: Type.Optional(Type.Union([Type.Literal('lesson'), Type.Literal('topic')])),
          courseId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
          course_id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
          sessionId: Type.Optional(Type.String()),
          session_id: Type.Optional(Type.String()),
          userId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
          user_id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
          role: Type.Optional(Type.String()),
        }),
      },
    },
    async (request) => {
      const { contentId } = request.params as { contentId: string };
      const body = (request.body || {}) as Record<string, any>;
      const resolvedType: 'lesson' | 'topic' = body.type === 'lesson' ? 'lesson' : 'topic';
      const resolvedUserId = String(
        body.userId || body.user_id || request.user?.userId || '1'
      );
      const resolvedRole = String(body.role || request.user?.role || 'student');
      const resolvedCourseId =
        body.courseId || body.course_id || request.user?.courseId
          ? String(body.courseId || body.course_id || request.user?.courseId)
          : undefined;
      const resolvedSessionId =
        body.sessionId || body.session_id || request.user?.sessionId
          ? String(body.sessionId || body.session_id || request.user?.sessionId)
          : undefined;

      const result = await provider.markContentComplete(contentId, {
        type: resolvedType,
        userId: resolvedUserId,
        role: resolvedRole,
        courseId: resolvedCourseId,
        sessionId: resolvedSessionId,
      });

      return {
        success: true,
        message: `${resolvedType === 'lesson' ? 'Lesson' : 'Topic'} marked as completed`,
        data: result,
      };
    }
  );

  // 4c. Get Course Progress for Current User (Student and Teacher separately)
  fastify.get(
    '/api/v1/courses/:courseId/progress',
    {
      preHandler: [authenticateFastify],
      schema: {
        params: Type.Object({
          courseId: Type.String({ minLength: 1, description: 'Course ID' }),
        }),
      },
    },
    async (request) => {
      const { courseId } = request.params as { courseId: string };
      const query = (request.query || {}) as Record<string, any>;
      const resolvedUserId = String(
        query.userId || query.user_id || request.user?.userId || '1'
      );
      const progress = await provider.getCourseProgress(courseId, resolvedUserId);
      return {
        success: true,
        data: progress,
      };
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
          languageId: Type.Optional(Type.String()),
          deviceId: Type.Optional(Type.String()),
          cohost: Type.Optional(Type.Boolean()),
          cohostName: Type.Optional(Type.String()),
          restart: Type.Optional(Type.Boolean()),
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
        languageId?: string;
        deviceId?: string;
        cohost?: boolean;
        cohostName?: string;
        restart?: boolean;
      };

      const headerAuth = request.headers.authorization;
      const headerToken =
        headerAuth && headerAuth.startsWith('Bearer ')
          ? headerAuth.substring(7).trim()
          : '';
      const authToken =
        body.token && body.token !== 'undefined' && body.token !== 'null'
          ? body.token.trim()
          : headerToken;

      if (!authToken || authToken.startsWith('DEV_TOKEN_')) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Valid classroom token issued by Zerix Academy is required to join this session.',
        });
      }

      const verified = JwtVerifier.verify(authToken);
      const verifiedClaims = verified.valid ? verified.claims : undefined;

      const user = await provider.validateToken(authToken, body.sessionId);
      if (!user) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Invalid or expired classroom authentication token.',
        });
      }

      const resolvedLanguageId =
        body.languageId || user.languageId || undefined;

      let room = await RoomManager.getOrInitRoom(body.sessionId, resolvedLanguageId);
      if (
        user.role === 'teacher' &&
        room.status !== 'LIVE' &&
        (room.status !== 'ENDED' || body.restart === true)
      ) {
        await AutoSaveService.cancelTeacherGraceTimer(body.sessionId);
        await RoomManager.setTeacherStatus(body.sessionId, 'LIVE');
        room = await RoomManager.getOrInitRoom(body.sessionId, resolvedLanguageId);
        if (body.restart === true) {
          AutoSaveService.performCheckpoint(body.sessionId).catch(() => {});
        }
      }

      const isCoHostJoin = Boolean(
        body.cohost ||
          user.isCoTeacher ||
          verifiedClaims?.isCoTeacher ||
          verifiedClaims?.isCoHostInvite ||
          user.userId === 'cohost_invite' ||
          user.userId === 'teacher_cohost_invite'
      );

      let issuedSessionToken: string = authToken;

      if (isCoHostJoin && user.role === 'teacher') {
        const isGenericInvite = Boolean(
          verifiedClaims?.isCoHostInvite ||
            user.userId === 'cohost_invite' ||
            user.userId === 'teacher_cohost_invite' ||
            user.userId === String(room.sessionContext?.teacherId || '') ||
            user.userId === `teacher_${room.sessionContext?.teacherId || ''}`
        );

        let uniqueCoHostId = user.userId;
        if (isGenericInvite) {
          const rawDevSeed = String(
            body.deviceId || body.teacherId || request.ip || Date.now()
          ).trim();
          const devHash = crypto
            .createHash('sha1')
            .update(`${body.sessionId}:${rawDevSeed}`)
            .digest('hex')
            .slice(0, 6);
          uniqueCoHostId = `teacher_cohost_${devHash}`;
        } else if (!uniqueCoHostId.startsWith('teacher_')) {
          uniqueCoHostId = `teacher_${uniqueCoHostId}`;
        }

        const existingCoTeachers = await AudioStageController.getInvitedTeachers(body.sessionId);
        const existingEntry = existingCoTeachers.find(
          (t) =>
            t.teacherId === uniqueCoHostId ||
            String(t.teacherId).replace(/^teacher_/, '') ===
              uniqueCoHostId.replace(/^teacher_/, '')
        );

        const coHostNumber = existingEntry
          ? existingCoTeachers.indexOf(existingEntry) + 1
          : existingCoTeachers.length + 1;

        const resolvedCoHostName =
          body.cohostName && body.cohostName.trim()
            ? body.cohostName.trim()
            : existingEntry?.name
            ? existingEntry.name
            : user.name &&
              user.name !== 'Co-Host Teacher' &&
              user.name !== 'Co-Host Invite' &&
              !isGenericInvite
            ? user.name
            : `Co-Host #${coHostNumber}`;

        const effectiveCanUseWb = existingEntry
          ? Boolean(existingEntry.canUseWhiteboard)
          : Boolean(verifiedClaims?.canUseWhiteboard);

        const updatedInvitedTeachers = await AudioStageController.inviteCoTeacher(body.sessionId, {
          teacherId: uniqueCoHostId,
          name: resolvedCoHostName,
          subject: existingEntry?.subject || room.sessionContext?.subjectName || 'Co-Instructor',
          canUseWhiteboard: effectiveCanUseWb,
          invitedAt: existingEntry?.invitedAt || Date.now(),
        });
        const updatedWbEditors = await AudioStageController.getWhiteboardEditors(body.sessionId);

        const ioInstance = (fastify as any).io;
        if (ioInstance) {
          ioInstance.to(body.sessionId).emit('CO_TEACHERS_UPDATED', {
            invitedTeachers: updatedInvitedTeachers,
            whiteboardEditors: updatedWbEditors,
          });
          ioInstance.to(body.sessionId).emit('WHITEBOARD_ACCESS_UPDATED', {
            whiteboardEditors: updatedWbEditors,
            invitedTeachers: updatedInvitedTeachers,
            targetUserId: uniqueCoHostId,
            canEdit: effectiveCanUseWb,
          });
        }

        user.userId = uniqueCoHostId;
        user.name = resolvedCoHostName;
        user.isCoTeacher = true;
      }

      const currentContent = await ContentEngine.getState(body.sessionId);
      const effectiveCourseId =
        user.courseId && String(user.courseId) !== '0' && String(user.courseId) !== '1'
          ? String(user.courseId)
          : room.sessionContext?.courseId &&
            String(room.sessionContext.courseId) !== '0' &&
            String(room.sessionContext.courseId) !== '1'
          ? String(room.sessionContext.courseId)
          : String(user.courseId || room.sessionContext?.courseId || '1');

      const liveLessonId =
        currentContent.activeLessonId &&
        currentContent.activeLessonId !== '1' &&
        currentContent.activeLessonId !== 'les_ohms_law'
          ? String(currentContent.activeLessonId)
          : room.sessionContext?.lessonId &&
            room.sessionContext.lessonId !== '1' &&
            room.sessionContext.lessonId !== 'les_ohms_law'
          ? String(room.sessionContext.lessonId)
          : '';

      const userRealLessonId =
        user.lessonId &&
        String(user.lessonId) !== '1' &&
        String(user.lessonId) !== 'les_ohms_law'
          ? String(user.lessonId)
          : '';

      const effectiveLessonId =
        user.role === 'teacher' && !isCoHostJoin && (!liveLessonId || body.restart === true)
          ? userRealLessonId || liveLessonId
          : liveLessonId || userRealLessonId;

      const effectiveTopicId =
        user.role === 'teacher' && !isCoHostJoin && (!liveLessonId || body.restart === true)
          ? String(user.topicId || currentContent.activeTopicId || room.sessionContext?.topicId || '')
          : String(currentContent.activeTopicId || room.sessionContext?.topicId || user.topicId || '');

      if (isCoHostJoin && user.role === 'teacher') {
        const existingCoTeachers = await AudioStageController.getInvitedTeachers(body.sessionId);
        const existingEntry = existingCoTeachers.find(
          (t) =>
            t.teacherId === user.userId ||
            String(t.teacherId).replace(/^teacher_/, '') ===
              String(user.userId).replace(/^teacher_/, '')
        );
        const effectiveCanUseWb = existingEntry
          ? Boolean(existingEntry.canUseWhiteboard)
          : Boolean(verifiedClaims?.canUseWhiteboard);

        issuedSessionToken = JwtVerifier.sign({
          sub: user.userId,
          userId: user.userId,
          name: user.name,
          role: 'teacher',
          sessionId: body.sessionId,
          courseId: Number(effectiveCourseId) || 1,
          batchId: room.sessionContext?.batchId || user.batchId || 1,
          branchId: Number(room.sessionContext?.branchId || user.branchId || 1),
          languageId: String(
            resolvedLanguageId || room.sessionContext?.languageId || '1'
          ),
          chapterId: String(room.sessionContext?.chapterId || user.chapterId || '1'),
          lessonId: effectiveLessonId,
          topicId: effectiveTopicId,
          isCoTeacher: true,
          isCoHostInvite: false,
          canUseWhiteboard: effectiveCanUseWb,
          exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        });
      } else {
        // Mint a 12-hour classroom session JWT for Host Teachers & Students so short-lived or one-time
        // Academy launch tokens can seamlessly rejoin as many times as needed until the class ends.
        issuedSessionToken = JwtVerifier.sign({
          sub: String(user.userId),
          userId: String(user.userId),
          name: user.name || (user.role === 'teacher' ? 'Instructor' : 'Student'),
          role: user.role,
          sessionId: body.sessionId,
          courseId: Number(effectiveCourseId) || 1,
          batchId: room.sessionContext?.batchId || user.batchId || body.sessionId,
          branchId: Number(room.sessionContext?.branchId || user.branchId || 1),
          languageId: String(
            resolvedLanguageId || room.sessionContext?.languageId || user.languageId || '1'
          ),
          chapterId: String(room.sessionContext?.chapterId || user.chapterId || '1'),
          lessonId: effectiveLessonId,
          topicId: effectiveTopicId,
          isCoTeacher: false,
          isCoHostInvite: false,
          canUseWhiteboard:
            typeof user.canUseWhiteboard === 'boolean'
              ? user.canUseWhiteboard
              : user.role === 'teacher',
          exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        });
      }

      // Ensure room.sessionContext has the resolved courseId when available
      if (effectiveCourseId && room.sessionContext && String(room.sessionContext.courseId || '') !== effectiveCourseId) {
        room.sessionContext = {
          ...room.sessionContext,
          courseId: effectiveCourseId,
        };
        await RoomManager.updateSnapshot(body.sessionId, {
          sessionContext: room.sessionContext,
        });
      }

      // Ensure any regular Course/Batch Teacher (non-Co-Host) is registered as the Primary Host Teacher
      // and never left in Redis `invited_teachers` from a stale session state.
      if (user.role === 'teacher' && !isCoHostJoin && !AudioStageController.isExplicitCoTeacher(user)) {
        await AudioStageController.removeCoTeacher(body.sessionId, user.userId);
        const normalizedHostId = String(user.userId).replace(/^teacher_/, '') || '1';
        const currentTeacherId = String(room.sessionContext?.teacherId || '').replace(/^teacher_/, '');
        if (currentTeacherId !== normalizedHostId || !room.sessionContext?.teacherName || room.sessionContext?.teacherName === 'Instructor') {
          room.sessionContext = {
            ...(room.sessionContext || ({} as any)),
            teacherId: normalizedHostId,
            teacherName: user.name || room.sessionContext?.teacherName || 'Instructor',
          };
          await RoomManager.updateSnapshot(body.sessionId, {
            sessionContext: room.sessionContext,
          });
        }
      }

      // Sync active lesson/topic when resolved
      if (
        effectiveLessonId &&
        (currentContent.activeLessonId !== effectiveLessonId ||
          (effectiveTopicId && currentContent.activeTopicId !== effectiveTopicId))
      ) {
        await ContentEngine.updateNavigation(body.sessionId, effectiveLessonId, effectiveTopicId);
        room.sessionContext = {
          ...room.sessionContext,
          chapterId: String(user.chapterId || room.sessionContext?.chapterId || ''),
          lessonId: effectiveLessonId,
          topicId: effectiveTopicId,
        };
        await RoomManager.updateSnapshot(body.sessionId, {
          sessionContext: room.sessionContext,
        });
      }

      const [elements, files, cam, cursor, contentState, audioStage, liveAttendance] =
        await Promise.all([
          WhiteboardEngine.getAllElements(body.sessionId),
          WhiteboardEngine.getAllFiles(body.sessionId),
          WhiteboardEngine.getTeacherCam(body.sessionId),
          WhiteboardEngine.getTeacherCursor(body.sessionId),
          ContentEngine.getState(body.sessionId),
          AudioStageController.getStageState(body.sessionId),
          AttendanceEngine.getLiveAttendanceList(body.sessionId),
        ]);

      if (!contentState.activeLessonId || contentState.activeLessonId === '1') {
        contentState.activeLessonId = effectiveLessonId;
      }
      if (!contentState.activeTopicId && effectiveTopicId) {
        contentState.activeTopicId = effectiveTopicId;
      }

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

      const coHostInviteToken =
        user.role === 'teacher'
          ? mintCoHostInviteToken(body.sessionId, room.sessionContext, {
              canUseWhiteboard: false,
            })
          : undefined;

      return {
        success: true,
        data: {
          user,
          token: issuedSessionToken,
          coHostInviteToken,
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
          videoState: getStorageProvider().getSessionVideoState(body.sessionId),
          livekit: {
            token: livekit.token,
            url: livekit.url,
            canPublishAudio: livekit.canPublishAudio,
          },
        },
      };
    }
  );

  // 5b. Mint / Refresh Signed Co-Host Invite Token (Supports Multiple Co-Hosts Simultaneously)
  fastify.post(
    '/api/v1/sessions/:sessionId/cohost-invite',
    {
      preHandler: [requireTeacherFastify],
      schema: {
        params: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
        }),
        body: Type.Optional(
          Type.Object({
            canUseWhiteboard: Type.Optional(Type.Boolean()),
            label: Type.Optional(Type.String()),
          })
        ),
      },
    },
    async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      const body = (request.body || {}) as {
        canUseWhiteboard?: boolean;
        label?: string;
      };
      const room = await RoomManager.getOrInitRoom(sessionId);
      const inviteToken = mintCoHostInviteToken(sessionId, room.sessionContext, {
        canUseWhiteboard: Boolean(body.canUseWhiteboard),
        label: body.label,
      });

      return {
        success: true,
        data: {
          sessionId,
          coHostInviteToken: inviteToken,
          canUseWhiteboard: Boolean(body.canUseWhiteboard),
        },
      };
    }
  );

  // 6. Fetch Room State Snapshot
  fastify.get(
    '/api/v1/sessions/:sessionId/state',
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

      await AutoSaveService.cancelTeacherGraceTimer(sessionId);
      await AudioStageController.clearSessionState(sessionId);
      const room = await RoomManager.getOrInitRoom(sessionId);
      await RoomManager.endSession(sessionId);

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
      preHandler: [authenticateFastify],
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

      const roomName =
        room.sessionContext?.batchName || room.sessionContext?.title || sessionId;

      return {
        success: true,
        data: {
          sessionId,
          status: room.status,
          isActive,
          roomName,
          title: room.sessionContext?.title || roomName,
          batchName: room.sessionContext?.batchName || roomName,
          courseName: room.sessionContext?.courseName || 'Live Course',
          subjectName: room.sessionContext?.subjectName || 'Course',
          teacherName: room.sessionContext?.teacherName || 'Instructor',
          lessonTitle: room.sessionContext?.lessonTitle || '',
          onlineCount,
          seqId: room.seqId,
          videoState: getStorageProvider().getSessionVideoState(sessionId),
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
    let headerRelationalContext: Partial<RelationalLessonContext> = {};
    const rawHeaderCtx = headers['x-relational-context'];
    if (typeof rawHeaderCtx === 'string' && rawHeaderCtx.trim().length > 0) {
      try {
        headerRelationalContext = JSON.parse(rawHeaderCtx);
      } catch {
        // Ignore malformed header JSON
      }
    }

    const resetRecording =
      query.reset === '1' ||
      query.reset === 'true' ||
      query.reset === true ||
      headers['x-reset-recording'] === '1' ||
      headers['x-reset-recording'] === 'true' ||
      Boolean((request.body as any)?.reset);

    const resumeRecording =
      query.resume === '1' ||
      query.resume === 'true' ||
      query.resume === true ||
      headers['x-resume-recording'] === '1' ||
      headers['x-resume-recording'] === 'true' ||
      Boolean((request.body as any)?.resume);

    if (Buffer.isBuffer(request.body)) {
      chunkBuffer = request.body;
      relationalContext = {
        ...headerRelationalContext,
        courseId:
          query.courseId !== undefined
            ? Number(query.courseId)
            : headerRelationalContext.courseId,
        boardId:
          query.boardId !== undefined
            ? Number(query.boardId)
            : headerRelationalContext.boardId,
        languageId:
          query.languageId !== undefined
            ? Number(query.languageId)
            : headerRelationalContext.languageId,
        chapterId:
          query.chapterId !== undefined
            ? Number(query.chapterId)
            : headerRelationalContext.chapterId,
        lessonId: paramLessonId
          ? Number(paramLessonId)
          : query.lessonId !== undefined
          ? Number(query.lessonId)
          : headerRelationalContext.lessonId,
        topicId:
          query.topicId !== undefined
            ? Number(query.topicId)
            : headerRelationalContext.topicId,
        version: query.version ? Number(query.version) : headerRelationalContext.version,
        academicYear: query.academicYear
          ? Number(query.academicYear)
          : headerRelationalContext.academicYear,
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
        ...headerRelationalContext,
        ...(body.relationalContext || {}),
        courseId: body.courseId ?? body.relationalContext?.courseId ?? headerRelationalContext.courseId,
        boardId: body.boardId ?? body.relationalContext?.boardId ?? headerRelationalContext.boardId,
        languageId: body.languageId ?? body.relationalContext?.languageId ?? headerRelationalContext.languageId,
        chapterId: body.chapterId ?? body.relationalContext?.chapterId ?? headerRelationalContext.chapterId,
        lessonId:
          paramLessonId !== undefined
            ? Number(paramLessonId)
            : body.lessonId ?? body.relationalContext?.lessonId ?? headerRelationalContext.lessonId,
        topicId: body.topicId ?? body.relationalContext?.topicId ?? headerRelationalContext.topicId,
        version: body.version ?? body.relationalContext?.version ?? headerRelationalContext.version,
        academicYear: body.academicYear ?? body.relationalContext?.academicYear ?? headerRelationalContext.academicYear,
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

    if (chunkIndex === 0 && resetRecording) {
      tracker.resetRecordingTimeline(sessionId, cleanRelCtx);
    }

    let appendResult;
    try {
      appendResult = await storageProvider.appendVideoChunk(sessionId, chunkBuffer, {
        chunkIndex,
        mimeType,
        relationalContext: cleanRelCtx,
        reset: resetRecording,
        resume: resumeRecording,
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
      keepSessionLive?: boolean;
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
    if (body.keepSessionLive !== undefined) {
      (summary as any).keepSessionLive = Boolean(body.keepSessionLive);
    }

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
