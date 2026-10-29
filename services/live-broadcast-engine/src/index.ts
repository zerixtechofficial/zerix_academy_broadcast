import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Server as SocketIOServer } from 'socket.io';
// @ts-ignore
import msgpackParser from '@socket.io/msgpack-parser';
import { createAdapter } from '@socket.io/redis-adapter';
import { env } from './config/env';
import { pubClient, subClient, redis } from './config/redis';
import { broadcastRoutes } from './routes/broadcast.routes';
import { validationErrorHandler } from './middlewares/validationError';
import { authenticateSocket } from './middlewares/jwtAuth';
import { RoomManager } from './modules/room/room.manager';
import { WhiteboardEngine } from './modules/whiteboard/whiteboard.engine';
import { ContentEngine } from './modules/content-sync/content.engine';
import { AudioStageController } from './modules/audio-stage/audio.controller';
import { AttendanceEngine } from './modules/attendance/attendance.engine';
import { AutoSaveService } from './modules/autosave/autosave.worker';
import { getSessionTimelineTracker } from './modules/session-timeline/sessionTimeline.tracker';
import { getDataProvider, getStorageProvider } from './adapters';
import {
  TelegramMonitorService,
  notifyTelegramErrorAsync,
} from './modules/monitoring/telegram.service';

export async function createBroadcastServer(options?: { disableBackgroundIntervals?: boolean }) {
  const fastify = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'warn',
    },
  });

  // Enable CORS for LAN and local dev
  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // Register Custom Validation Error Handler
  fastify.setErrorHandler(validationErrorHandler);

  // Register REST & Webhook routes
  await fastify.register(broadcastRoutes);

  // Initialize BullMQ background workers & Telegram health/error watchdog unless disabled for fast test teardown
  if (!options?.disableBackgroundIntervals) {
    AutoSaveService.init();
    TelegramMonitorService.init();
  }

  // Create Socket.io server attached to Fastify's raw HTTP server
  // Note: perMessageDeflate is strictly disabled (`false`) so 1,000+ concurrent MsgPack
  // binary broadcasts do not exhaust Node.js zlib CPU threads.
  const io = new SocketIOServer(fastify.server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    parser: msgpackParser,
    perMessageDeflate: false,
    adapter: createAdapter(pubClient, subClient),
    maxHttpBufferSize: 25 * 1024 * 1024, // 25MB to support high-res clipboard pasted screenshots & whiteboard media
    pingTimeout: 30000,
    pingInterval: 10000,
  });
  (fastify as any).io = io;
  AutoSaveService.setSocketServer(io);

  // Socket Authentication Middleware
  io.use(authenticateSocket);

  // Per-room coalesced attendance broadcast state (prevents O(N^2) broadcast storms for 1000s of students)
  const attendanceThrottleTimers = new Map<string, NodeJS.Timeout>();
  const attendanceLastEmit = new Map<string, number>();
  const ATTENDANCE_COALESCE_MS = 2000;

  const scheduleAttendanceBroadcast = (targetSessionId: string, immediate = false) => {
    const emitMetrics = async () => {
      attendanceThrottleTimers.delete(targetSessionId);
      attendanceLastEmit.set(targetSessionId, Date.now());
      try {
        const liveMetrics = await AttendanceEngine.getLiveAttendanceList(targetSessionId);
        io.to(targetSessionId).emit('ATTENDANCE_METRICS_UPDATE', liveMetrics);
      } catch {
        // ignore transient Redis errors
      }
    };

    const now = Date.now();
    const last = attendanceLastEmit.get(targetSessionId) || 0;
    if (immediate || now - last >= ATTENDANCE_COALESCE_MS) {
      if (attendanceThrottleTimers.has(targetSessionId)) {
        clearTimeout(attendanceThrottleTimers.get(targetSessionId)!);
        attendanceThrottleTimers.delete(targetSessionId);
      }
      void emitMetrics();
    } else if (!attendanceThrottleTimers.has(targetSessionId)) {
      const delay = Math.max(200, ATTENDANCE_COALESCE_MS - (now - last));
      const timer = setTimeout(emitMetrics, delay);
      attendanceThrottleTimers.set(targetSessionId, timer);
    }
  };

  /**
   * Hydrates the full room snapshot from Redis engines.
   */
  const hydrateRoomSnapshot = async (targetSessionId: string) => {
    const [elements, files, cam, cursor, contentState, audioStage] = await Promise.all([
      WhiteboardEngine.getAllElements(targetSessionId),
      WhiteboardEngine.getAllFiles(targetSessionId),
      WhiteboardEngine.getTeacherCam(targetSessionId),
      WhiteboardEngine.getTeacherCursor(targetSessionId),
      ContentEngine.getState(targetSessionId),
      AudioStageController.getStageState(targetSessionId),
    ]);
    return await RoomManager.updateSnapshot(targetSessionId, {
      excalidrawElements: elements,
      excalidrawFiles: files,
      teacherCam: cam,
      whiteboardCursor: cursor,
      contentState,
      audioStage,
    });
  };

  // Socket.io Connection & Event Handling
  io.on('connection', (socket) => {
    const user = socket.user;
    const initialSessionId = socket.sessionId;

    if (!user || !initialSessionId) {
      socket.disconnect(true);
      return;
    }

    let sessionId: string = initialSessionId;

    // Start joining the initial room immediately and register all socket.on listeners synchronously
    // on the first tick, while ensuring each listener awaits initialRoomJoinPromise before running.
    const initialRoomJoinPromise = Promise.resolve(socket.join(sessionId));

    // Wrap socket.on handlers with non-blocking Telegram error boundary so unexpected handler errors
    // never crash the engine or block other sockets
    const rawSocketOn = socket.on.bind(socket);
    socket.on = ((eventName: string, listener: (...args: any[]) => any) => {
      return rawSocketOn(eventName, async (...args: any[]) => {
        try {
          await initialRoomJoinPromise;
          await listener(...args);
        } catch (err: any) {
          console.error(`[Socket.IO:${eventName}] Unhandled handler error:`, err?.message || err);
          notifyTelegramErrorAsync({
            source: `Socket.IO (${eventName})`,
            error: err,
            context: {
              sessionId,
              userId: user?.userId,
              role: user?.role,
            },
          });
        }
      });
    }) as any;

    const getSocketDeviceId = (payloadDeviceId?: string): string => {
      return (
        (typeof payloadDeviceId === 'string' && payloadDeviceId.trim()) ||
        (typeof (socket as any).deviceId === 'string' && (socket as any).deviceId.trim()) ||
        (typeof (socket as any).handshake?.auth?.deviceId === 'string' &&
          (socket as any).handshake.auth.deviceId.trim()) ||
        (typeof (socket as any).handshake?.query?.deviceId === 'string' &&
          (socket as any).handshake.query.deviceId.trim()) ||
        socket.id
      );
    };

    // 1. Join Room & Catch-Up Protocol
    socket.on(
      'JOIN_ROOM',
      async (payload: {
        sessionId: string;
        lastSeqId?: number;
        deviceId?: string;
        restart?: boolean;
      }) => {
        const targetSessionId = payload?.sessionId || sessionId;
        const lastSeqId = typeof payload?.lastSeqId === 'number' ? payload.lastSeqId : 0;

        // Enforce session scoping: prevent a socket authenticated for session A from joining session B
        const boundSessionId = user.sessionId || sessionId;
        if (
          targetSessionId !== sessionId &&
          boundSessionId &&
          boundSessionId !== '*' &&
          targetSessionId !== boundSessionId
        ) {
          socket.emit('ERROR', {
            code: 'SESSION_MISMATCH',
            message: `Socket token is bound to session "${boundSessionId}" and cannot join session "${targetSessionId}".`,
          });
          return;
        }

        const existingRoomCheck = await RoomManager.getOrInitRoom(targetSessionId);
        if (
          existingRoomCheck.status === 'ENDED' &&
          !(user.role === 'teacher' && payload?.restart === true)
        ) {
          socket.emit('SESSION_ENDED', {
            sessionId: targetSessionId,
            message: 'This classroom session has already ended.',
          });
          return;
        }

        // Ensure socket is joined to targetSessionId if authorized
        await socket.join(targetSessionId);
        if (targetSessionId !== sessionId) {
          sessionId = targetSessionId;
          socket.sessionId = targetSessionId;
        }

        // Handle Teacher / Co-Host Join & Reconnection
        if (user.role === 'teacher') {
          await AutoSaveService.cancelTeacherGraceTimer(targetSessionId);
          await RoomManager.setTeacherStatus(targetSessionId, 'LIVE');
          io.to(targetSessionId).emit('TEACHER_STATUS_CHANGE', {
            status: 'LIVE',
            message: 'Teacher is live.',
          });

          // If a Co-Host teacher joins via the shared Co-Host link, register them in the Co-Host list
          // while preserving any existing Whiteboard access setting configured by the Host.
          const currentRoom = await RoomManager.getOrInitRoom(targetSessionId);
          const isHost = await AudioStageController.isHostTeacher(
            targetSessionId,
            user,
            currentRoom?.sessionContext?.teacherId
          );
          if (isHost) {
            await AudioStageController.removeCoTeacher(targetSessionId, user.userId);
            const normalizedHostId = String(user.userId).replace(/^teacher_/, '') || '1';
            if (
              currentRoom?.sessionContext &&
              String(currentRoom.sessionContext.teacherId || '').replace(/^teacher_/, '') !== normalizedHostId
            ) {
              currentRoom.sessionContext = {
                ...currentRoom.sessionContext,
                teacherId: normalizedHostId,
                teacherName: user.name || currentRoom.sessionContext.teacherName || 'Instructor',
              };
              await RoomManager.updateSnapshot(targetSessionId, {
                sessionContext: currentRoom.sessionContext,
              });
            }
          }
          if (isHost && !user.isCoTeacher && lastSeqId === 0 && (user.lessonId || user.topicId)) {
            const currentContent = await ContentEngine.getState(targetSessionId);
            const hasLiveLesson =
              Boolean(currentContent.activeLessonId) &&
              currentContent.activeLessonId !== '1' &&
              currentContent.activeLessonId !== 'les_ohms_law';
            const userLessonValid =
              Boolean(user.lessonId) &&
              String(user.lessonId) !== '1' &&
              String(user.lessonId) !== 'les_ohms_law';
            const nextLessonId =
              hasLiveLesson && !payload?.restart
                ? String(currentContent.activeLessonId)
                : userLessonValid
                ? String(user.lessonId)
                : String(currentContent.activeLessonId || currentRoom.sessionContext?.lessonId || '');
            const nextTopicId =
              hasLiveLesson && !payload?.restart
                ? String(currentContent.activeTopicId || user.topicId || '')
                : String(
                    user.topicId ||
                      currentContent.activeTopicId ||
                      currentRoom.sessionContext?.topicId ||
                      ''
                  );
            if (
              nextLessonId &&
              nextLessonId !== '1' &&
              (currentContent.activeLessonId !== nextLessonId ||
                (nextTopicId && currentContent.activeTopicId !== nextTopicId))
            ) {
              await ContentEngine.updateNavigation(targetSessionId, nextLessonId, nextTopicId);
            }
          } else if (!isHost && AudioStageController.isExplicitCoTeacher(user)) {
            const currentCoTeachers = await AudioStageController.getInvitedTeachers(targetSessionId);
            const cleanCoId = user.userId.startsWith('teacher_')
              ? user.userId
              : `teacher_${user.userId}`;
            const alreadyListed = currentCoTeachers.some(
              (t) => t.teacherId === user.userId || t.teacherId === cleanCoId
            );
            if (!alreadyListed) {
              const updatedList = await AudioStageController.inviteCoTeacher(targetSessionId, {
                teacherId: user.userId,
                name: user.name,
                canUseWhiteboard: false,
                invitedAt: Date.now(),
              });
              io.to(targetSessionId).emit('CO_TEACHERS_UPDATED', {
                invitedTeachers: updatedList,
              });
            }
          }
        } else {
          const existingRoom = await RoomManager.getOrInitRoom(targetSessionId);
          if (existingRoom.status === 'ENDED') {
            // If the classroom broadcast has ended, notify student client
            socket.emit('SESSION_ENDED', {
              sessionId: targetSessionId,
              message: 'This classroom session has already ended.',
            });
            return;
          }

          // Enforce Single-Device Student Join Rule (Configurable per student by Host Teacher)
          const deviceId = getSocketDeviceId(payload?.deviceId);
          (socket as any).deviceId = deviceId;
          const deviceCheck = await AudioStageController.canStudentDeviceJoin(
            targetSessionId,
            user.userId,
            deviceId,
            socket.id
          );
          if (!deviceCheck.allowed) {
            socket.data.blockedMultiDevice = true;
            await socket.leave(targetSessionId);
            if (targetSessionId !== sessionId) {
              await socket.leave(sessionId);
            }
            socket.emit('MULTI_DEVICE_BLOCKED', {
              code: 'MULTI_DEVICE_NOT_ALLOWED',
              sessionId: targetSessionId,
              studentId: user.userId,
              deviceId,
              activeDeviceId: deviceCheck.activeDeviceId,
              message:
                'You are already joined in this live class from another device. Students can join from one device only unless the Host Teacher enables multi-device access for your account.',
            });
            return;
          }

          socket.data.blockedMultiDevice = false;
          await socket.join(targetSessionId);

          // Record Student Presence in Attendance Engine
          await AttendanceEngine.recordJoin(targetSessionId, user, socket.id);
        }

      // Fast path: check ring buffer first; only hydrate full snapshot when needed
      if (lastSeqId > 0) {
        const catchup = await RoomManager.getMissedPackets(targetSessionId, lastSeqId);
        if (!catchup.needsFullSnapshot) {
          if (catchup.packets.length > 0) {
            socket.emit('MISSED_PACKETS_REPLAY', {
              packets: catchup.packets,
              catchupType: 'replay',
            });
          }
        } else {
          const snapshot = await hydrateRoomSnapshot(targetSessionId);
          socket.emit('FULL_SNAPSHOT', {
            snapshot,
            catchupType: 'snapshot',
          });
        }
      } else {
        const snapshot = await hydrateRoomSnapshot(targetSessionId);
        socket.emit('FULL_SNAPSHOT', {
          snapshot,
          catchupType: 'snapshot',
        });
      }

      // Send live attendance metrics & stage permissions to joining client & schedule coalesced room update
      const [liveMetrics, stageState] = await Promise.all([
        AttendanceEngine.getLiveAttendanceList(targetSessionId),
        AudioStageController.getStageState(targetSessionId),
      ]);
      socket.emit('ROOM_JOINED', {
        sessionId: targetSessionId,
        user,
        onlineCount: liveMetrics.onlineCount,
        totalCount: liveMetrics.totalCount,
        students: liveMetrics.students,
        audioStage: stageState,
      });
      getSessionTimelineTracker().updateConcurrentUsers(
        targetSessionId,
        liveMetrics.onlineCount + 1
      );
      scheduleAttendanceBroadcast(targetSessionId);
    });

    // 2. Student Heartbeat Ping (Every 30s) — Queued & flushed via Redis pipeline for 1000s of students
    socket.on('HEARTBEAT', async (data?: { deviceId?: string }) => {
      if (user.role === 'student' && !socket.data?.blockedMultiDevice) {
        AttendanceEngine.queueHeartbeat(sessionId, user.userId);
        await AudioStageController.touchStudentDevice(
          sessionId,
          user.userId,
          getSocketDeviceId(data?.deviceId),
          socket.id
        );
        scheduleAttendanceBroadcast(sessionId);
      }
    });

    // 3. Mode Change (CONTENT <-> WHITEBOARD <-> ROUGH_PAD) - Teacher Only
    socket.on('MODE_CHANGE', async (data: { mode: 'CONTENT' | 'WHITEBOARD' | 'ROUGH_PAD'; videoOffsetSec?: number }) => {
      if (user.role !== 'teacher') return;
      const packet = await RoomManager.setMode(sessionId, data.mode);
      getSessionTimelineTracker().recordModeSwitch(sessionId, data.mode, data.videoOffsetSec);
      io.to(sessionId).emit('MODE_CHANGE', packet);
    });

    // 4. Whiteboard Teacher Camera & Live Cursor Broadcast (Formula B)
    // Authorized for Host Teacher, Co-Teacher with Whiteboard access, or Student granted Whiteboard access
    socket.on('TEACHER_CAM_UPDATE', async (camData: any) => {
      const canEdit = await AudioStageController.canUserEditWhiteboard(sessionId, user);
      if (!canEdit) return;
      const roundedCam = {
        ...camData,
        Cx: typeof camData?.Cx === 'number' ? Math.round(camData.Cx * 10) / 10 : 0,
        Cy: typeof camData?.Cy === 'number' ? Math.round(camData.Cy * 10) / 10 : 0,
        authorId: user.userId,
        authorName: user.name,
        updatedAt: Date.now(),
      };
      await WhiteboardEngine.updateTeacherCam(sessionId, roundedCam);
      socket.to(sessionId).emit('TEACHER_CAM_UPDATE', roundedCam);
    });

    socket.on('WHITEBOARD_CURSOR_MOVE', async (cursorData: {
      Lx: number;
      Ly: number;
      tool?: 'pointer' | 'laser';
      button?: 'up' | 'down';
      active: boolean;
      teacherName?: string;
    }) => {
      const canEdit = await AudioStageController.canUserEditWhiteboard(sessionId, user);
      if (!canEdit) return;
      const updated = await WhiteboardEngine.updateTeacherCursor(sessionId, {
        ...cursorData,
        Lx: typeof cursorData?.Lx === 'number' ? Math.round(cursorData.Lx * 10) / 10 : 0,
        Ly: typeof cursorData?.Ly === 'number' ? Math.round(cursorData.Ly * 10) / 10 : 0,
        teacherName: cursorData.teacherName || user.name,
        userId: user.userId,
        role: user.role,
        updatedAt: Date.now(),
      });
      socket.volatile.to(sessionId).emit('WHITEBOARD_CURSOR_MOVE', updated);
    });

    // 5. Whiteboard Delta Sync (Version Map) & Clear & Files
    // Authorized for Host Teacher, Co-Teacher with Whiteboard access, or Student granted Whiteboard access
    socket.on('WHITEBOARD_DELTA', async (data: { elements: any[]; appState?: any }) => {
      const canEdit = await AudioStageController.canUserEditWhiteboard(sessionId, user);
      if (!canEdit) return;
      const roundedIncoming = Array.isArray(data.elements)
        ? data.elements.map((el) => {
            if (!el || typeof el !== 'object') return el;
            const nextEl: any = {
              ...el,
              x: typeof el.x === 'number' ? Math.round(el.x * 10) / 10 : el.x,
              y: typeof el.y === 'number' ? Math.round(el.y * 10) / 10 : el.y,
              width: typeof el.width === 'number' ? Math.round(el.width * 10) / 10 : el.width,
              height: typeof el.height === 'number' ? Math.round(el.height * 10) / 10 : el.height,
            };
            if (Array.isArray(el.points)) {
              nextEl.points = el.points.map((pt: any) =>
                Array.isArray(pt)
                  ? pt.map((val: any, idx: number) =>
                      idx < 2 && typeof val === 'number' && Number.isFinite(val)
                        ? Math.round(val * 10) / 10
                        : val
                    )
                  : pt
              );
            }
            return nextEl;
          })
        : [];
      const deltas = await WhiteboardEngine.syncElements(sessionId, roundedIncoming);
      if (deltas.length > 0) {
        socket.to(sessionId).emit('WHITEBOARD_DELTA', {
          elements: deltas,
          appState: data.appState,
          authorId: user.userId,
        });
      }
    });

    socket.on('WHITEBOARD_CLEAR', async () => {
      // Students are never allowed to clear the entire classroom whiteboard even if granted drawing permission
      if (user.role !== 'teacher') return;
      const canEdit = await AudioStageController.canUserEditWhiteboard(sessionId, user);
      if (!canEdit) return;
      await WhiteboardEngine.clearElements(sessionId);
      io.to(sessionId).emit('WHITEBOARD_CLEAR');
    });

    socket.on('WHITEBOARD_FILES_DELTA', async (data: { files: Record<string, any> }) => {
      const canEdit = await AudioStageController.canUserEditWhiteboard(sessionId, user);
      if (!canEdit) return;
      const synced = await WhiteboardEngine.syncFiles(sessionId, data.files);
      if (Object.keys(synced).length > 0) {
        socket.to(sessionId).emit('WHITEBOARD_FILES_DELTA', { files: synced });
      }
    });

    // 6. Send Content Block to Whiteboard
    socket.on('SEND_TO_WHITEBOARD', async (data: { block: any }) => {
      if (user.role !== 'teacher') return;
      const elements = await WhiteboardEngine.injectContentBlockAsExcalidraw(sessionId, data.block);
      const modePacket = await RoomManager.setMode(sessionId, 'WHITEBOARD');

      io.to(sessionId).emit('WHITEBOARD_DELTA', { elements, seqId: modePacket.seqId });
      io.to(sessionId).emit('MODE_CHANGE', modePacket);
    });

    // 7. Content Scroll Sync (Block-ID Anchoring)
    // Authorized for Host Teacher, Co-Teacher, or Student granted Whiteboard/Board access
    socket.on('CONTENT_SCROLL_SYNC', async (data: { activeBlockId: string; blockOffsetRatio: number }) => {
      const canSync = user.role === 'teacher' || (await AudioStageController.canUserEditWhiteboard(sessionId, user));
      if (!canSync) return;
      const packet = await ContentEngine.updateScroll(
        sessionId,
        data.activeBlockId,
        data.blockOffsetRatio,
        user.userId
      );
      socket.to(sessionId).emit('CONTENT_SCROLL_SYNC', {
        ...data,
        authorId: user.userId,
        authorName: user.name,
        updatedAt: packet.payload?.updatedAt || Date.now(),
        seqId: packet.seqId,
      });
    });

    // 8. Navigation State Change (Chapter / Lesson / Topic)
    socket.on('NAV_STATE_CHANGE', async (data: { activeLessonId: string; activeTopicId: string }) => {
      if (user.role !== 'teacher') return;
      const packet = await ContentEngine.updateNavigation(sessionId, data.activeLessonId, data.activeTopicId);
      socket.to(sessionId).emit('NAV_STATE_CHANGE', {
        ...data,
        penStrokes: packet.payload.penStrokes,
        seqId: packet.seqId,
      });
    });

    // 9. Content Pen, Highlighter, Eraser & Laser Sync
    socket.on('CONTENT_STROKE_ADD', async (stroke: any) => {
      const canEdit = user.role === 'teacher' || (await AudioStageController.canUserEditWhiteboard(sessionId, user));
      if (!canEdit) return;
      const roundedStroke = {
        ...stroke,
        points: Array.isArray(stroke?.points)
          ? stroke.points.map((pt: any) => ({
              ...pt,
              x: typeof pt?.x === 'number' ? Math.round(pt.x * 10) / 10 : 0,
              y: typeof pt?.y === 'number' ? Math.round(pt.y * 10) / 10 : 0,
            }))
          : [],
      };
      const packet = await ContentEngine.addStroke(sessionId, roundedStroke);
      socket.to(sessionId).emit('CONTENT_STROKE_ADD', {
        ...roundedStroke,
        authorId: user.userId,
        seqId: packet.seqId,
      });
    });

    socket.on('CONTENT_STROKE_DELETE', async (data: { lessonId: string; strokeId: string }) => {
      const canEdit = user.role === 'teacher' || (await AudioStageController.canUserEditWhiteboard(sessionId, user));
      if (!canEdit) return;
      const packet = await ContentEngine.deleteStroke(sessionId, data.lessonId, data.strokeId);
      socket.to(sessionId).emit('CONTENT_STROKE_DELETE', {
        ...data,
        authorId: user.userId,
        seqId: packet.seqId,
      });
    });

    socket.on('CONTENT_STROKES_CLEAR', async (data: { lessonId: string }) => {
      if (user.role !== 'teacher') return;
      const packet = await ContentEngine.clearStrokes(sessionId, data.lessonId);
      socket.to(sessionId).emit('CONTENT_STROKES_CLEAR', {
        ...data,
        seqId: packet.seqId,
      });
    });

    socket.on('CONTENT_LASER_MOVE', async (laser: any) => {
      const canEdit = user.role === 'teacher' || (await AudioStageController.canUserEditWhiteboard(sessionId, user));
      if (!canEdit) return;
      const roundedLaser = {
        ...laser,
        x: typeof laser?.x === 'number' ? Math.round(laser.x * 10) / 10 : 0,
        y: typeof laser?.y === 'number' ? Math.round(laser.y * 10) / 10 : 0,
        authorId: user.userId,
        authorName: user.name,
        updatedAt: Date.now(),
      };
      await ContentEngine.updateLaser(sessionId, roundedLaser);
      socket.volatile.to(sessionId).emit('CONTENT_LASER_MOVE', roundedLaser);
    });

    // 10. Audio Stage Events
    socket.on('AUDIO_RAISE_HAND', async (data?: { deviceId?: string }) => {
      const entry = {
        userId: user.userId,
        name: user.name,
        avatar: user.avatar,
        rollNumber: user.rollNumber,
        raisedAt: Date.now(),
        deviceId: getSocketDeviceId(data?.deviceId),
      };
      await AudioStageController.raiseHand(sessionId, entry);
      io.to(sessionId).emit('AUDIO_HAND_RAISED', { entry });
    });

    socket.on('AUDIO_LOWER_HAND', async (data?: { userId?: string }) => {
      const targetUserId = user.role === 'teacher' && data?.userId ? data.userId : user.userId;
      await AudioStageController.lowerHand(sessionId, targetUserId);
      io.to(sessionId).emit('AUDIO_HAND_LOWERED', { userId: targetUserId });
    });

    socket.on(
      'AUDIO_GRANT_MIC',
      async (data: { studentId: string; forceReplaceOldest?: boolean; targetDeviceId?: string }) => {
        if (user.role !== 'teacher') return;
        try {
          const result = await AudioStageController.grantStudentMic(
            sessionId,
            data.studentId,
            data.forceReplaceOldest,
            data.targetDeviceId
          );
          getSessionTimelineTracker().recordMicGrant(sessionId);
          io.to(sessionId).emit('AUDIO_MIC_GRANTED', result);
        } catch (err: any) {
          socket.emit('AUDIO_ERROR', {
            message: err.message,
            canForceReplace: true,
            studentId: data.studentId,
          });
        }
      }
    );

    socket.on('AUDIO_MUTE_STUDENT', async (data: { studentId: string }) => {
      if (user.role !== 'teacher') return;
      await AudioStageController.muteStudent(sessionId, data.studentId);
      io.to(sessionId).emit('AUDIO_MIC_REVOKED', {
        studentId: data.studentId,
        revokedByTeacher: true,
      });
    });

    socket.on('AUDIO_MUTE_ALL', async () => {
      if (user.role !== 'teacher') return;
      const muted = await AudioStageController.muteAllStudents(sessionId);
      io.to(sessionId).emit('AUDIO_MUTE_ALL', {
        mutedStudents: muted,
        allowStudentUnmute: false,
      });
      io.to(sessionId).emit('AUDIO_ALLOW_UNMUTE_CHANGED', {
        allowStudentUnmute: false,
      });
    });

    // 10b. Host Toggles "Allow Students to Unmute Themselves" (Open Discussion / Mute-Unmute for all students)
    socket.on('AUDIO_SET_ALLOW_UNMUTE', async (data: { allow: boolean }) => {
      if (user.role !== 'teacher') return;
      const allow = await AudioStageController.setAllowStudentUnmute(
        sessionId,
        Boolean(data?.allow)
      );
      io.to(sessionId).emit('AUDIO_ALLOW_UNMUTE_CHANGED', { allowStudentUnmute: allow });
    });

    // 10b-2. Host Configures Single-Device vs Multi-Device Join Access for a Particular Student
    socket.on(
      'AUDIO_SET_STUDENT_MULTI_DEVICE',
      async (data: { studentId: string; allow: boolean }) => {
        if (user.role !== 'teacher' || !data?.studentId) return;
        const multiDeviceStudents = await AudioStageController.setStudentMultiDeviceAccess(
          sessionId,
          data.studentId,
          Boolean(data.allow)
        );
        io.to(sessionId).emit('STUDENT_MULTI_DEVICE_UPDATED', {
          studentId: AudioStageController.normalizeStudentId(data.studentId),
          allow: Boolean(data.allow),
          multiDeviceStudents,
        });
      }
    );

    // 10c. Student Self Unmute (Allowed when Host has enabled allowStudentUnmute or student has mic grant)
    socket.on(
      'AUDIO_STUDENT_SELF_UNMUTE',
      async (data?: { studentId?: string; deviceId?: string }) => {
        if (user.role !== 'teacher' && data?.studentId && data.studentId !== user.userId) {
          socket.emit('AUDIO_ERROR', {
            code: 'FORBIDDEN',
            message: 'Students can only unmute their own microphone.',
            studentId: user.userId,
          });
          return;
        }
        const stId = user.role === 'teacher' && data?.studentId ? data.studentId : user.userId;
        const reqDeviceId = getSocketDeviceId(data?.deviceId);
        const hasPermission = await AudioStageController.hasStudentMicPermission(sessionId, stId);
        if (!hasPermission) {
          socket.emit('AUDIO_ERROR', {
            message: 'Microphones are currently restricted. Please raise your hand to speak.',
            studentId: stId,
          });
          return;
        }
        try {
          const result = await AudioStageController.grantStudentMic(
            sessionId,
            stId,
            false,
            reqDeviceId
          );
          await AudioStageController.setStudentDeviceMicState(sessionId, stId, reqDeviceId, true);
          io.to(sessionId).emit('AUDIO_MIC_GRANTED', {
            ...result,
            targetDeviceId: reqDeviceId,
            selfUnmuted: true,
            autoActivate: false,
          });
        } catch (err: any) {
          socket.emit('AUDIO_ERROR', {
            message: err.message,
            studentId: stId,
          });
        }
      }
    );

    // 10c-2. Per-Device Mic Active Sync (notifies server when a student's specific device activates or deactivates its mic)
    socket.on(
      'AUDIO_DEVICE_MIC_ACTIVE',
      async (data?: { deviceId?: string; micActive?: boolean; active?: boolean }) => {
        if (user.role !== 'student') return;
        const devId = getSocketDeviceId(data?.deviceId);
        const micActive = Boolean(data?.micActive ?? data?.active);
        if (micActive) {
          const hasPermission = await AudioStageController.hasStudentMicPermission(
            sessionId,
            user.userId
          );
          if (!hasPermission) return;
        }
        const state = await AudioStageController.setStudentDeviceMicState(
          sessionId,
          user.userId,
          devId,
          micActive
        );
        io.to(sessionId).emit('AUDIO_DEVICE_MIC_STATE', {
          studentId: user.userId,
          deviceId: devId,
          micActive,
          anyDeviceMicActive: state.anyDeviceMicActive,
        });
        if (micActive) {
          io.to(sessionId).emit('AUDIO_MIC_GRANTED', {
            studentId: user.userId,
            targetDeviceId: devId,
            selfUnmuted: true,
            autoActivate: false,
          });
        } else if (!state.anyDeviceMicActive) {
          io.to(sessionId).emit('AUDIO_MIC_REVOKED', {
            studentId: user.userId,
            deviceId: devId,
            selfMuted: true,
            revokedByTeacher: false,
          });
        }
      }
    );

    // 10d. Student Self Mute (Student voluntarily mutes their microphone on their current device)
    socket.on(
      'AUDIO_STUDENT_SELF_MUTE',
      async (data?: { studentId?: string; deviceId?: string }) => {
        if (user.role !== 'teacher' && data?.studentId && data.studentId !== user.userId) {
          socket.emit('AUDIO_ERROR', {
            code: 'FORBIDDEN',
            message: 'Students can only mute their own microphone.',
            studentId: user.userId,
          });
          return;
        }
        const stId = user.role === 'teacher' && data?.studentId ? data.studentId : user.userId;
        const explicitDeviceId =
          data?.deviceId ||
          (socket as any).deviceId ||
          (socket as any).handshake?.auth?.deviceId ||
          (socket as any).handshake?.query?.deviceId ||
          (user.role === 'student' ? getSocketDeviceId() : undefined);

        if (explicitDeviceId && user.role === 'student') {
          const muteRes = await AudioStageController.muteStudentDevice(
            sessionId,
            stId,
            String(explicitDeviceId)
          );
          io.to(sessionId).emit('AUDIO_DEVICE_MIC_STATE', {
            studentId: stId,
            deviceId: String(explicitDeviceId),
            micActive: false,
            anyDeviceMicActive: muteRes.anyDeviceMicActive,
          });
          if (!muteRes.anyDeviceMicActive) {
            io.to(sessionId).emit('AUDIO_MIC_REVOKED', {
              studentId: stId,
              deviceId: String(explicitDeviceId),
              selfMuted: true,
              revokedByTeacher: false,
            });
          }
        } else {
          await AudioStageController.muteStudent(sessionId, stId);
          io.to(sessionId).emit('AUDIO_MIC_REVOKED', {
            studentId: stId,
            revokedByTeacher: true,
          });
        }
      }
    );

    // 11. Teacher Mic Muted/Unmuted State Sync (All mics muted by default)
    socket.on('TEACHER_MIC_STATE_CHANGE', async (data: { active: boolean }) => {
      if (user.role !== 'teacher') return;
      const active = await AudioStageController.setTeacherMicActive(sessionId, Boolean(data?.active));
      io.to(sessionId).emit('TEACHER_MIC_STATE_CHANGE', {
        active,
        teacherId: user.userId,
      });
    });

    // 11b. Real-Time Port-443 WebAudio Voice Relay (Hybrid Fallback for Firewalled Networks / Blocked UDP-7881 ICE)
    socket.on(
      'AUDIO_VOICE_FRAME',
      async (data: {
        pcm?: number[] | Int16Array | Uint8Array | string;
        sampleRate?: number;
        seq?: number;
        rms?: number;
        deviceId?: string;
      }) => {
        if (!data || !data.pcm) return;

        // Authorize publisher: Teachers (Host & Co-Host) are always authorized;
        // Students must either have an active mic grant or allowStudentUnmute enabled.
        if (user.role !== 'teacher') {
          const hasPermission = await AudioStageController.hasStudentMicPermission(
            sessionId,
            user.userId
          );
          if (!hasPermission) return;
        }

        const relayPayload = {
          senderId: user.userId,
          senderName: user.name,
          role: user.role,
          deviceId: getSocketDeviceId(data.deviceId),
          pcm: data.pcm,
          sampleRate: Number(data.sampleRate) || 16000,
          seq: Number(data.seq) || 0,
          rms: typeof data.rms === 'number' ? data.rms : undefined,
          ts: Date.now(),
        };

        socket.to(sessionId).emit('AUDIO_VOICE_FRAME', relayPayload);
      }
    );

    // 12. Co-Teacher Invitation & Whiteboard Access Controls (Host Teacher)
    socket.on(
      'TEACHER_INVITE_CO_TEACHER',
      async (data: {
        teacherId: string;
        name: string;
        subject?: string;
        email?: string;
        canUseWhiteboard?: boolean;
      }) => {
        if (user.role !== 'teacher') return;
        const invitedTeachers = await AudioStageController.inviteCoTeacher(sessionId, {
          teacherId: data.teacherId,
          name: data.name,
          subject: data.subject,
          email: data.email,
          canUseWhiteboard: Boolean(data.canUseWhiteboard),
          invitedAt: Date.now(),
          invitedBy: user.userId,
        });
        const whiteboardEditors = await AudioStageController.getWhiteboardEditors(sessionId);
        io.to(sessionId).emit('CO_TEACHERS_UPDATED', {
          invitedTeachers,
          whiteboardEditors,
        });
        io.to(sessionId).emit('WHITEBOARD_ACCESS_UPDATED', {
          whiteboardEditors,
          targetUserId: data.teacherId,
          canEdit: Boolean(data.canUseWhiteboard),
        });
      }
    );

    socket.on(
      'TEACHER_TOGGLE_CO_TEACHER_WB',
      async (data: { teacherId: string; canUseWhiteboard: boolean }) => {
        if (user.role !== 'teacher') return;
        const result = await AudioStageController.setCoTeacherWhiteboardAccess(
          sessionId,
          data.teacherId,
          Boolean(data.canUseWhiteboard)
        );
        io.to(sessionId).emit('CO_TEACHERS_UPDATED', result);
        io.to(sessionId).emit('WHITEBOARD_ACCESS_UPDATED', {
          whiteboardEditors: result.whiteboardEditors,
          targetUserId: data.teacherId,
          canEdit: Boolean(data.canUseWhiteboard),
        });
      }
    );

    socket.on('TEACHER_REMOVE_CO_TEACHER', async (data: { teacherId: string }) => {
      if (user.role !== 'teacher') return;
      const result = await AudioStageController.removeCoTeacher(sessionId, data.teacherId);
      io.to(sessionId).emit('CO_TEACHERS_UPDATED', result);
      io.to(sessionId).emit('WHITEBOARD_ACCESS_UPDATED', {
        whiteboardEditors: result.whiteboardEditors,
        targetUserId: data.teacherId,
        canEdit: false,
      });
    });

    // 13. Student / Participant Whiteboard Edit Access Grant & Revoke
    socket.on(
      'WHITEBOARD_GRANT_ACCESS',
      async (data: { targetUserId?: string; userId?: string }) => {
        const targetId = data?.targetUserId || data?.userId;
        if (user.role !== 'teacher' || !targetId) return;
        const whiteboardEditors = await AudioStageController.grantWhiteboardAccess(
          sessionId,
          targetId
        );
        const invitedTeachers = await AudioStageController.getInvitedTeachers(sessionId);
        io.to(sessionId).emit('WHITEBOARD_ACCESS_UPDATED', {
          whiteboardEditors,
          invitedTeachers,
          targetUserId: targetId,
          canEdit: true,
        });
      }
    );

    socket.on(
      'WHITEBOARD_REVOKE_ACCESS',
      async (data: { targetUserId?: string; userId?: string }) => {
        const targetId = data?.targetUserId || data?.userId;
        if (user.role !== 'teacher' || !targetId) return;
        const whiteboardEditors = await AudioStageController.revokeWhiteboardAccess(
          sessionId,
          targetId
        );
        const invitedTeachers = await AudioStageController.getInvitedTeachers(sessionId);
        io.to(sessionId).emit('WHITEBOARD_ACCESS_UPDATED', {
          whiteboardEditors,
          invitedTeachers,
          targetUserId: targetId,
          canEdit: false,
        });
      }
    );

    const checkAndStartHostCoHostGraceIfEmpty = async (
      targetSessionId: string,
      leavingSocketId: string
    ) => {
      const room = await RoomManager.getOrInitRoom(targetSessionId);
      if (room.status === 'ENDED') return;

      const remainingSockets = await io.in(targetSessionId).fetchSockets();
      const hasActiveHostOrCoHost = remainingSockets.some(
        (s: any) =>
          s.id !== leavingSocketId &&
          s.user?.role === 'teacher' &&
          !s.data?.intentionalLeave
      );
      if (!hasActiveHostOrCoHost) {
        const grace = await AutoSaveService.startTeacherGraceTimer(targetSessionId);
        io.to(targetSessionId).emit('TEACHER_STATUS_CHANGE', {
          status: 'TEACHER_RECONNECTING',
          gracePeriodSeconds: grace.gracePeriodSeconds,
          graceEndsAt: grace.graceEndsAt,
          message:
            'No Host or Co-Host is currently active. Waiting up to 5 minutes before closing the broadcast...',
        });
      }
    };

    // 14. Participant Explicitly Leaves Meeting (Host, Co-Host, or Student leaves locally without ending broadcast)
    socket.on(
      'LEAVE_SESSION',
      async (data?: { sessionId?: string; deviceId?: string }, ack?: (res: any) => void) => {
        socket.data.intentionalLeave = true;
        if (user.role === 'student') {
          const devId = getSocketDeviceId(data?.deviceId);
          const removal = await AudioStageController.removeStudentDevice(
            sessionId,
            user.userId,
            devId,
            socket.id
          );
          if (removal.remainingDevices === 0) {
            await AudioStageController.muteStudent(sessionId, user.userId);
            await AudioStageController.lowerHand(sessionId, user.userId);
            await AttendanceEngine.recordDisconnect(sessionId, user.userId, socket.id);
            io.to(sessionId).emit('AUDIO_MIC_REVOKED', { studentId: user.userId });
            io.to(sessionId).emit('AUDIO_HAND_LOWERED', { userId: user.userId });
            scheduleAttendanceBroadcast(sessionId, true);
            AutoSaveService.performCheckpoint(sessionId).catch(() => {});
          } else if (!removal.anyDeviceMicActive) {
            await AudioStageController.muteStudentDevice(sessionId, user.userId, devId);
            io.to(sessionId).emit('AUDIO_MIC_REVOKED', {
              studentId: user.userId,
              deviceId: devId,
            });
          }
        }
        await socket.leave(sessionId);
        if (user.role === 'teacher') {
          await checkAndStartHostCoHostGraceIfEmpty(sessionId, socket.id);
        }
        if (typeof ack === 'function') {
          ack({ ok: true, action: 'left' });
        }
      }
    );

    // 15. Host or Co-Host Explicitly Ends Class Broadcast (Ends broadcast and drops all connected participants)
    socket.on(
      'END_SESSION',
      async (_data?: { sessionId?: string }, ack?: (res: any) => void) => {
        if (user.role !== 'teacher') {
          if (typeof ack === 'function') {
            ack({ ok: false, message: 'Only Host or Co-Host can end the class.' });
          }
          return;
        }
        socket.data.intentionalLeave = true;
        try {
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
          const provider = getDataProvider();
          await provider.publishSessionCompleted(summary);

          const isHostEnder = await AudioStageController.isHostTeacher(
            sessionId,
            user,
            room?.sessionContext?.teacherId
          );
          const endedPayload = {
            sessionId,
            endedBy: user.name,
            endedByUserId: user.userId,
            endedByRole: isHostEnder ? 'host' : 'cohost',
            timestamp: Date.now(),
          };

          io.to(sessionId).emit('SESSION_ENDED', endedPayload);

          if (typeof ack === 'function') {
            ack({ ok: true, action: 'ended', data: endedPayload });
          }

          const roomSockets = await io.in(sessionId).fetchSockets();
          for (const s of roomSockets) {
            s.data.intentionalLeave = true;
          }
          setTimeout(() => {
            for (const s of roomSockets) {
              s.disconnect(true);
            }
          }, 120);
        } catch (err: any) {
          if (typeof ack === 'function') {
            ack({ ok: false, message: err?.message || 'Failed to end session' });
          }
        }
      }
    );

    // Disconnect Handler
    socket.on('disconnect', async () => {
      if (socket.data?.intentionalLeave) {
        return;
      }
      if (user.role === 'teacher') {
        await checkAndStartHostCoHostGraceIfEmpty(sessionId, socket.id);
      } else {
        // Student disconnected unexpectedly: remove device registration and trigger 15-second network blip grace
        const devId = getSocketDeviceId();
        const removal = await AudioStageController.removeStudentDevice(
          sessionId,
          user.userId,
          devId,
          socket.id
        );
        if (removal.remainingDevices === 0 && !socket.data?.blockedMultiDevice) {
          await AudioStageController.muteStudent(sessionId, user.userId);
          io.to(sessionId).emit('AUDIO_MIC_REVOKED', { studentId: user.userId });
          await AttendanceEngine.recordDisconnect(sessionId, user.userId, socket.id);
          setTimeout(async () => {
            try {
              const liveMetrics = await AttendanceEngine.getLiveAttendanceList(sessionId);
              io.to(sessionId).emit('ATTENDANCE_METRICS_UPDATE', liveMetrics);
              await AutoSaveService.performCheckpoint(sessionId);
            } catch {
              // ignore
            }
          }, AttendanceEngine.NETWORK_BLIP_GRACE_MS + 250);
        }
      }
    });
  });

  // Periodic Snapshot Updater & Pipelined Heartbeat Flush
  let snapshotInterval: NodeJS.Timeout | null = null;
  let heartbeatFlushInterval: NodeJS.Timeout | null = null;

  if (!options?.disableBackgroundIntervals) {
    snapshotInterval = setInterval(async () => {
      try {
        const activeSessions = await RoomManager.getActiveSessions();
        for (const sessId of activeSessions) {
          const [elements, files, cam, cursor, contentState, audioStage] = await Promise.all([
            WhiteboardEngine.getAllElements(sessId),
            WhiteboardEngine.getAllFiles(sessId),
            WhiteboardEngine.getTeacherCam(sessId),
            WhiteboardEngine.getTeacherCursor(sessId),
            ContentEngine.getState(sessId),
            AudioStageController.getStageState(sessId),
          ]);
          await RoomManager.updateSnapshot(sessId, {
            excalidrawElements: elements,
            excalidrawFiles: files,
            teacherCam: cam,
            whiteboardCursor: cursor,
            contentState,
            audioStage,
          });
        }
      } catch {
        // Quiet background interval
      }
    }, 3000);

    // Flush queued 1,000+ student heartbeats every 5 seconds via a single Redis pipeline
    heartbeatFlushInterval = setInterval(async () => {
      try {
        await AttendanceEngine.flushQueuedHeartbeats();
      } catch {
        // Quiet background interval
      }
    }, 5000);
  }

  return {
    fastify,
    io,
    close: async () => {
      if (snapshotInterval) clearInterval(snapshotInterval);
      if (heartbeatFlushInterval) clearInterval(heartbeatFlushInterval);
      for (const timer of attendanceThrottleTimers.values()) {
        clearTimeout(timer);
      }
      attendanceThrottleTimers.clear();
      TelegramMonitorService.close();
      await AutoSaveService.close();
      await io.close();
      await fastify.close();
    },
  };
}

async function bootstrap() {
  const { fastify, close } = await createBroadcastServer();

  // Start Fastify HTTP & Socket Server
  try {
    const address = await fastify.listen({
      port: env.PORT,
      host: env.HOST,
    });
    console.log(`🚀 [LiveBroadcastEngine] Service listening at ${address}`);
    console.log(`📡 [DataSourceMode] Active mode: ${env.DATA_SOURCE_MODE.toUpperCase()}`);
  } catch (err: any) {
    fastify.log.error(err);
    await TelegramMonitorService.sendTelegramMessage(
      `🚨 <b>[SERVICE STARTUP FAILURE]</b>\nLiveBroadcastEngine failed to bind port ${env.PORT}: <code>${err?.message || err}</code>`,
      { parseMode: 'HTML' }
    ).catch(() => {});
    process.exit(1);
  }

  // Graceful Process Termination
  const gracefulShutdown = async (signal: string) => {
    console.log(`\n[Process] Received ${signal}. Shutting down gracefully...`);
    try {
      await close();
      redis.disconnect();
      pubClient.disconnect();
      subClient.disconnect();
      console.log('[Process] All connections closed cleanly. Exiting.');
      process.exit(0);
    } catch (err: any) {
      console.error('[Process] Error during shutdown:', err.message);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error('[Bootstrap] Fatal startup error:', err);
    process.exit(1);
  });
}
