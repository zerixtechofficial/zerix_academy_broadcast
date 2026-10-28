import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';

import { createBroadcastServer } from '../../src/index';
import { redis, pubClient, subClient } from '../../src/config/redis';
import { StorageProvider, setStorageProvider } from '../../src/adapters/storage.provider';
import { setSessionTimelineTracker, SessionTimelineTracker } from '../../src/modules/session-timeline/sessionTimeline.tracker';
import { FileCache } from '../../src/utils/fileCache';
import { RelationalLessonContext } from '../../src/types/broadcast.types';
import { JwtVerifier } from '../../src/utils/jwtVerifier';

describe('Phase 1 Integration Tests: End-to-End Fastify REST & Streaming Pipeline', () => {
  let tempDir: string;
  let storageProvider: StorageProvider;
  let server: Awaited<ReturnType<typeof createBroadcastServer>>;

  const sessionId = 'sess_integration_jee_physics_2026';
  const baseRelCtx: RelationalLessonContext = {
    sessionId,
    branchId: 4,
    batchId: 105,
    boardId: null,
    examId: 21, // JEE Main & Advanced
    languageId: 1,
    courseId: 55,
    linkedVodCourseId: 255,
    subjectId: 11,
    chapterId: 5,
    chapterNumber: 5,
    chapterTitle: 'Rotational Mechanics',
    lessonId: 201,
    lessonNumber: '5.1',
    lessonTitle: 'Moment of Inertia & Parallel Axis Theorem',
    topicId: null,
    teacherId: 501,
    academicYear: 2026,
    version: 1,
    publishToVodCourse: true,
    isPrimaryVod: true,
  };

  before(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'broadcast-phase1-int-'));
    storageProvider = new StorageProvider({
      driver: 'local_disk',
      cacheDir: path.join(tempDir, 'storage_cache'),
      localFallbackDir: path.join(tempDir, 'local_r2'),
      publicCdnUrl: '',
    });
    setStorageProvider(storageProvider);
    setSessionTimelineTracker(new SessionTimelineTracker());

    server = await createBroadcastServer({ disableBackgroundIntervals: true });
    await server.fastify.ready();
  });

  after(async () => {
    if (server) {
      await server.close();
    }
    setStorageProvider(null);
    setSessionTimelineTracker(null);
    FileCache.invalidate();
    if (tempDir && fs.existsSync(tempDir)) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
    redis.disconnect();
    pubClient.disconnect();
    subClient.disconnect();
  });

  const signedTeacherJwt = JwtVerifier.sign({
    userId: 'teacher_501',
    name: 'Prof. S. Verma',
    role: 'teacher',
    sessionId,
    batchId: '105',
  });
  const signedStudentJwt = JwtVerifier.sign({
    userId: 'student_101',
    name: 'Aarav Kumar',
    role: 'student',
    sessionId,
    batchId: '105',
  });

  const teacherHeaders = {
    authorization: `Bearer ${signedTeacherJwt}`,
  };

  it('1. validates video chunk upload inputs and returns structured 422 ValidationError on bad payloads', async () => {
    // Missing/negative chunkIndex
    const badIdxRes = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/video-chunk`,
      headers: teacherHeaders,
      payload: {
        chunkIndex: -1,
        chunkBase64: Buffer.from('test').toString('base64'),
      },
    });
    assert.equal(badIdxRes.statusCode, 422);
    const badIdxBody = badIdxRes.json();
    assert.equal(badIdxBody.error, 'ValidationError');

    // Empty chunk payload
    const emptyChunkRes = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/video-chunk`,
      headers: teacherHeaders,
      payload: {
        chunkIndex: 0,
        chunkBase64: '',
      },
    });
    assert.equal(emptyChunkRes.statusCode, 422);
  });

  it('2. ingests binary & base64 720p video chunks (including out-of-order jitter & duplicate retries) into a single continuous session stream', async () => {
    // Chunk 0: Binary application/octet-stream with synthetic WebM EBML 0x4489 duration header
    const chunk0 = Buffer.alloc(64, 0x1a);
    chunk0[12] = 0x44;
    chunk0[13] = 0x89;
    chunk0[14] = 0x88;
    chunk0.writeDoubleBE(0.0, 15);

    const res0 = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/video-chunk?chunkIndex=0&courseId=55&boardId=21&languageId=1&chapterId=5&lessonId=201&version=1&academicYear=2026`,
      headers: {
        'content-type': 'application/octet-stream',
        ...teacherHeaders,
      },
      payload: chunk0,
    });
    assert.equal(res0.statusCode, 200);
    const body0 = res0.json();
    assert.equal(body0.success, true);
    assert.equal(body0.data.nextExpectedChunkIndex, 1);

    // Chunk 2 arrives BEFORE Chunk 1 (simulating random 150ms-1850ms client jitter)
    const chunk2 = Buffer.from('__VIDEO_SEGMENT_CHUNK_2_DATA__', 'utf-8');
    const res2 = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/lessons/201/video-chunk`,
      headers: teacherHeaders,
      payload: {
        chunkIndex: 2,
        chunkBase64: chunk2.toString('base64'),
        relationalContext: baseRelCtx,
      },
    });
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.json().data.bufferedOutOfOrderCount, 1);
    assert.equal(res2.json().data.nextExpectedChunkIndex, 1);

    // Chunk 1 arrives -> flushes Chunk 1 and Chunk 2 contiguously
    const chunk1 = Buffer.from('__VIDEO_SEGMENT_CHUNK_1_DATA__', 'utf-8');
    const res1 = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/video-chunk`,
      headers: teacherHeaders,
      payload: {
        chunkIndex: 1,
        chunkBase64: chunk1.toString('base64'),
        relationalContext: baseRelCtx,
      },
    });
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.json().data.bufferedOutOfOrderCount, 0);
    assert.equal(res1.json().data.nextExpectedChunkIndex, 3);

    // Duplicate Chunk 1 retry -> ignored idempotently
    const dup1 = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/video-chunk`,
      headers: teacherHeaders,
      payload: {
        chunkIndex: 1,
        chunkBase64: chunk1.toString('base64'),
        relationalContext: baseRelCtx,
      },
    });
    assert.equal(dup1.statusCode, 200);
    assert.equal(dup1.json().data.duplicateIgnored, true);
  });

  it('3. navigates across multiple curriculum lessons, protects reference-only lessons from Whiteboard/VOD overwrite, and strips Content Mode strokes', async () => {
    // Pre-seed old Lesson 199 (Center of Mass - taught in an earlier class) so we can verify it is NEVER overwritten
    const lesson199Ctx: RelationalLessonContext = {
      ...baseRelCtx,
      lessonId: 199,
      lessonNumber: '4.9',
      lessonTitle: 'Center of Mass (Previously Completed Lesson)',
    };
    const lesson199WbKey = StorageProvider.buildTopicWhiteboardKey(lesson199Ctx);
    await storageProvider.putGzippedWhiteboard(lesson199WbKey, {
      sessionId: 'old_session_last_week',
      relationalContext: lesson199WbKey as any,
      elements: [{ id: 'original_com_derivation', type: 'text', text: 'R_com = sum(m_i r_i) / M' }],
    });

    // Save Whiteboard for Lesson 201 (including a Content Mode pen stroke & Laser stroke that MUST be stripped)
    const save201Res = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/whiteboard/save`,
      headers: teacherHeaders,
      payload: {
        chapterId: 5,
        lessonId: 201,
        relationalContext: baseRelCtx,
        elements: [
          { id: 'moi_ring', type: 'ellipse', strokeColor: '#000000' },
          { id: 'moi_formula', type: 'text', text: 'I = I_cm + M*d^2', strokeColor: '#12a3ff' },
          { id: 'transient_content_pen', type: 'freedraw', mode: 'CONTENT', isContentAnnotation: true },
          { id: 'transient_laser', type: 'laser', tool: 'LASER' },
        ],
      },
    });
    assert.equal(save201Res.statusCode, 200);
    assert.equal(save201Res.json().data.saved, true);

    // At videoOffsetSec = 500s, Teacher opens old Lesson 199 ONLY FOR REFERENCE (`mode: 'reference_only'`)
    const nav199Res = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/curriculum/navigate`,
      headers: teacherHeaders,
      payload: {
        chapterId: 5,
        lessonId: 199,
        lessonNumber: '4.9',
        lessonTitle: 'Center of Mass (Previously Completed Lesson)',
        videoOffsetSec: 500,
        mode: 'reference_only',
        relationalContext: lesson199Ctx,
      },
    });
    assert.equal(nav199Res.statusCode, 200);
    assert.equal(nav199Res.json().data.activeSegment.mode, 'reference_only');
    assert.equal(nav199Res.json().data.closedSegment.lessonId, 201);
    assert.equal(nav199Res.json().data.closedSegment.endOffsetSec, 500);

    // Attempt to save Whiteboard while Lesson 199 is open in reference_only mode -> MUST be skipped!
    const save199Attempt = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/whiteboard/save`,
      headers: teacherHeaders,
      payload: {
        chapterId: 5,
        lessonId: 199,
        elements: [{ id: 'should_not_overwrite', type: 'rectangle' }],
      },
    });
    assert.equal(save199Attempt.statusCode, 200);
    assert.equal(save199Attempt.json().data.saved, false);
    assert.equal(save199Attempt.json().data.skippedAsReferenceOnly, true);

    // At videoOffsetSec = 580s, Teacher switches to new Lesson 202 ('Perpendicular Axis Theorem') in 'taught' mode
    const nav202Res = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/curriculum/navigate`,
      headers: teacherHeaders,
      payload: {
        chapterId: 5,
        lessonId: 202,
        lessonNumber: '5.2',
        lessonTitle: 'Perpendicular Axis Theorem',
        videoOffsetSec: 580,
        mode: 'taught',
        relationalContext: {
          ...baseRelCtx,
          lessonId: 202,
          lessonNumber: '5.2',
          lessonTitle: 'Perpendicular Axis Theorem',
        },
      },
    });
    assert.equal(nav202Res.statusCode, 200);
    assert.equal(nav202Res.json().data.closedSegment.lessonId, 199);
    assert.equal(nav202Res.json().data.closedSegment.mode, 'reference_only');

    // Teacher uploads chunk 3 while teaching Lesson 202 -> appends to the SAME continuous session video
    const chunk3 = Buffer.from('__VIDEO_SEGMENT_CHUNK_3_LESSON_202__', 'utf-8');
    const res3 = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/lessons/202/video-chunk`,
      headers: teacherHeaders,
      payload: {
        chunkIndex: 3,
        chunkBase64: chunk3.toString('base64'),
        relationalContext: {
          ...baseRelCtx,
          lessonId: 202,
        },
      },
    });
    assert.equal(res3.statusCode, 200);
    assert.equal(res3.json().data.chunksReceivedCount, 4);

    // Save Whiteboard for Lesson 202
    const save202Res = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/lessons/202/whiteboard`,
      headers: teacherHeaders,
      payload: {
        chapterId: 5,
        lessonId: 202,
        elements: [{ id: 'perp_axis_formula', type: 'text', text: 'I_z = I_x + I_y' }],
      },
    });
    assert.equal(save202Res.statusCode, 200);
    assert.equal(save202Res.json().data.saved, true);
  });

  it('4. finalizes the session, publishes ONLY taught lessons with exact video offsets, and serves HTTP 206 byte-range video & gzipped whiteboard artifacts', async () => {
    const finalizeRes = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/finalize`,
      headers: teacherHeaders,
      payload: {
        totalDurationSec: 1200,
        relationalContext: baseRelCtx,
      },
    });
    assert.equal(finalizeRes.statusCode, 200);
    const finBody = finalizeRes.json();
    assert.equal(finBody.success, true);

    const summary = finBody.data;
    assert.equal(summary.publishedLessonArtifacts.length, 2);
    assert.equal(summary.skippedReferenceLessons.length, 1);
    assert.equal(summary.skippedReferenceLessons[0].lessonId, 199);

    const art201 = summary.publishedLessonArtifacts[0];
    const art202 = summary.publishedLessonArtifacts[1];

    assert.equal(art201.relationalContext.lessonId, 201);
    assert.equal(art201.videoStartOffsetSec, 0);
    assert.equal(art201.videoEndOffsetSec, 500);

    assert.equal(art202.relationalContext.lessonId, 202);
    assert.equal(art202.videoStartOffsetSec, 580);
    assert.equal(art202.videoEndOffsetSec, 1200);

    // Test HTTP 206 Byte-Range Video Streaming Endpoint (`GET /api/v1/stream/video/*`)
    const videoKey = art201.videoRelativePath;
    const partialRes = await server.fastify.inject({
      method: 'GET',
      url: `/api/v1/stream/video/${videoKey}`,
      headers: {
        range: 'bytes=0-31',
      },
    });
    assert.equal(partialRes.statusCode, 206);
    assert.equal(partialRes.headers['accept-ranges'], 'bytes');
    assert.equal(Number(partialRes.headers['content-length']), 32);
    assert.equal(partialRes.rawPayload.length, 32);
    // Verify EBML 0x4489 Float64 duration was patched to 1200 * 1000 = 1,200,000 ms
    assert.equal(partialRes.rawPayload.readDoubleBE(15), 1200000);

    // Test HTTP 416 Range Not Satisfiable
    const invalidRangeRes = await server.fastify.inject({
      method: 'GET',
      url: `/api/v1/stream/video/${videoKey}`,
      headers: {
        range: 'bytes=500000-600000',
      },
    });
    assert.equal(invalidRangeRes.statusCode, 416);

    // Test Gzipped Whiteboard Retrieval Endpoint (`GET /api/v1/artifacts/whiteboard/*`)
    const wbKey201 = art201.whiteboardGzipRelativePath;
    const wbJsonRes = await server.fastify.inject({
      method: 'GET',
      url: `/api/v1/artifacts/whiteboard/${wbKey201}`,
    });
    assert.equal(wbJsonRes.statusCode, 200);
    assert.equal(wbJsonRes.json().data.elements.length, 2, 'Content Mode & Laser strokes must not be present');

    // Test rawGzip=1 zero-CPU gzipped binary response
    const wbGzipRes = await server.fastify.inject({
      method: 'GET',
      url: `/api/v1/artifacts/whiteboard/${wbKey201}?rawGzip=1`,
    });
    assert.equal(wbGzipRes.statusCode, 200);
    assert.equal(wbGzipRes.headers['content-encoding'], 'gzip');
    const decompressed = JSON.parse(zlib.gunzipSync(wbGzipRes.rawPayload).toString('utf-8'));
    assert.equal(decompressed.elements.length, 2);
  });

  it('5. P0-2: supports frontend hyphenated routes (/curriculum-navigate, /whiteboard-save, /stream/whiteboard/*) and string curriculum IDs without NaN or 404', async () => {
    const navStrRes = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/curriculum-navigate`,
      headers: teacherHeaders,
      payload: {
        chapterId: 'chap_electricity',
        lessonId: 'les_ohms_law',
        topicId: 'top_resistance',
        videoOffsetSec: 1250,
        mode: 'taught',
      },
    });
    assert.equal(navStrRes.statusCode, 200);
    const navBody = navStrRes.json();
    assert.equal(navBody.success, true);
    assert.equal(Number.isInteger(navBody.data.activeSegment.chapterId), true);
    assert.ok(navBody.data.activeSegment.chapterId > 0);
    assert.equal(Number.isInteger(navBody.data.activeSegment.lessonId), true);
    assert.ok(navBody.data.activeSegment.lessonId > 0);
    assert.equal(typeof navBody.data.videoStorageKey, 'string');
    assert.equal(navBody.data.videoStorageKey.includes('NaN'), false);

    const wbSaveStrRes = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/whiteboard-save`,
      headers: teacherHeaders,
      payload: {
        chapterId: 'chap_electricity',
        lessonId: 'les_ohms_law',
        topicId: 'top_resistance',
        elements: [{ id: 'ohm_v_ir', type: 'text', text: 'V = I * R' }],
      },
    });
    assert.equal(wbSaveStrRes.statusCode, 200);
    const wbSaveBody = wbSaveStrRes.json();
    assert.equal(wbSaveBody.success, true);
    assert.equal(wbSaveBody.data.saved, true);
    assert.equal(wbSaveBody.data.whiteboardKey.includes('NaN'), false);
    assert.equal(wbSaveBody.data.whiteboardStorageKey, wbSaveBody.data.whiteboardKey);
    assert.equal(wbSaveBody.data.compressedBytes, wbSaveBody.data.gzippedBytes);
    assert.equal(wbSaveBody.data.elementsCount, 1);

    const streamWbRes = await server.fastify.inject({
      method: 'GET',
      url: `/api/v1/stream/whiteboard/${wbSaveBody.data.whiteboardStorageKey}`,
    });
    assert.equal(streamWbRes.statusCode, 200);
    assert.equal(streamWbRes.json().data.elements[0].id, 'ohm_v_ir');
  });

  it('6. P0-4: blocks unauthenticated and student requests to session mutation endpoints (/video-chunk, /curriculum/navigate, /whiteboard/save, /finalize) with 401/403', async () => {
    const studentHeaders = {
      authorization: `Bearer ${signedStudentJwt}`,
    };

    // 1. Unauthenticated requests -> 401
    const unauthChunk = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/video-chunk`,
      payload: { chunkIndex: 0, chunkBase64: Buffer.from('x').toString('base64') },
    });
    assert.equal(unauthChunk.statusCode, 401);

    const unauthNav = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/curriculum/navigate`,
      payload: { chapterId: 1, lessonId: 1, videoOffsetSec: 10 },
    });
    assert.equal(unauthNav.statusCode, 401);

    const unauthWb = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/whiteboard/save`,
      payload: { elements: [] },
    });
    assert.equal(unauthWb.statusCode, 401);

    const unauthFinalize = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/finalize`,
      payload: { totalDurationSec: 100 },
    });
    assert.equal(unauthFinalize.statusCode, 401);

    // 2. Student requests -> 403 Forbidden
    const studentChunk = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/video-chunk`,
      headers: studentHeaders,
      payload: { chunkIndex: 0, chunkBase64: Buffer.from('x').toString('base64') },
    });
    assert.equal(studentChunk.statusCode, 403);

    const studentNav = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/curriculum-navigate`,
      headers: studentHeaders,
      payload: { chapterId: 1, lessonId: 1, videoOffsetSec: 10 },
    });
    assert.equal(studentNav.statusCode, 403);

    const studentWb = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/whiteboard-save`,
      headers: studentHeaders,
      payload: { elements: [] },
    });
    assert.equal(studentWb.statusCode, 403);

    const studentFinalize = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/finalize`,
      headers: studentHeaders,
      payload: { totalDurationSec: 100 },
    });
    assert.equal(studentFinalize.statusCode, 403);

    // 3. P1-4: Unauthenticated request with ?role=teacher query param must NOT bypass auth on protected routes
    const roleQueryBypassAttempt = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/finalize?role=teacher`,
      payload: { totalDurationSec: 100 },
    });
    assert.equal(
      roleQueryBypassAttempt.statusCode,
      401,
      '?role=teacher query parameter must not bypass authentication on protected REST routes'
    );

    // 4. P1-4: /api/v1/dev/users must return 403 Forbidden when NODE_ENV=production
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const prodDevUsersRes = await server.fastify.inject({
        method: 'GET',
        url: '/api/v1/dev/users',
      });
      assert.equal(
        prodDevUsersRes.statusCode,
        403,
        '/api/v1/dev/users must be forbidden in production'
      );
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  it('7. P1-6 & P1-7: blocks Socket.IO cross-room JOIN_ROOM hijacking and prevents student-to-student AUDIO_STUDENT_SELF_MUTE / UNMUTE IDOR', async () => {
    const { EventEmitter } = await import('node:events');
    const { AudioStageController } = await import('../../src/modules/audio-stage/audio.controller');

    const connectionListeners = server.io.listeners('connection') as Array<(socket: any) => Promise<void>>;
    assert.ok(connectionListeners.length > 0, 'Socket.IO connection listener must be registered');
    const handleConnection = connectionListeners[0];

    const createTestSocket = (user: any, boundSessionId: string) => {
      const emitter = new EventEmitter();
      const emittedEvents: Array<{ event: string; payload: any }> = [];
      const joinedRooms = new Set<string>();
      const registeredHandlers = new Map<string, (...args: any[]) => Promise<void>>();

      const fakeSocket: any = {
        id: `sock_${user.userId}_${Date.now()}`,
        user,
        sessionId: boundSessionId,
        data: {},
        joinedRooms,
        emittedEvents,
        join: async (room: string) => {
          joinedRooms.add(room);
        },
        leave: async (room: string) => {
          joinedRooms.delete(room);
        },
        emit: (event: string, payload: any) => {
          emittedEvents.push({ event, payload });
          emitter.emit(event, payload);
        },
        on: (event: string, handler: (...args: any[]) => Promise<void>) => {
          registeredHandlers.set(event, handler);
        },
        to: () => ({ emit: () => {} }),
        volatile: { to: () => ({ emit: () => {} }) },
        disconnect: () => {},
        triggerClientEvent: async (event: string, payload?: any, ack?: any) => {
          const handler = registeredHandlers.get(event);
          assert.ok(handler, `Handler for ${event} must be registered`);
          await handler(payload, ack);
        },
      };
      return fakeSocket;
    };

    const roomA = `sess_room_a_${Date.now()}`;
    const roomB = `sess_room_b_${Date.now()}`;

    // Connect student_101 scoped strictly to roomA
    const student101Socket = createTestSocket(
      {
        userId: 'student_101',
        name: 'Rahul Verma',
        role: 'student',
        batchId: roomA,
        sessionId: roomA,
      },
      roomA
    );
    await handleConnection(student101Socket);

    // 1. P1-6: student_101 attempts to JOIN_ROOM for unauthorized roomB
    await student101Socket.triggerClientEvent('JOIN_ROOM', {
      sessionId: roomB,
      lastSeqId: 0,
    });

    assert.equal(
      student101Socket.joinedRooms.has(roomB),
      false,
      'Socket scoped to roomA must NOT be allowed to join roomB via JOIN_ROOM'
    );
    const mismatchErr = student101Socket.emittedEvents.find(
      (e: any) =>
        (e.event === 'ERROR' || e.event === 'JOIN_ERROR') &&
        e.payload?.code === 'SESSION_MISMATCH'
    );
    assert.ok(mismatchErr, 'JOIN_ROOM with mismatched sessionId must emit SESSION_MISMATCH error');

    // 2. P1-7: Grant microphone to student_102 in roomA, then student_101 attempts to mute student_102 via AUDIO_STUDENT_SELF_MUTE
    await AudioStageController.grantStudentMic(roomA, 'student_102', false);
    const activeBefore = await AudioStageController.getActiveStudentMics(roomA);
    assert.ok(activeBefore.includes('student_102'), 'student_102 must have active mic initially');

    await student101Socket.triggerClientEvent('AUDIO_STUDENT_SELF_MUTE', {
      studentId: 'student_102',
    });

    const activeAfterMuteAttempt = await AudioStageController.getActiveStudentMics(roomA);
    assert.ok(
      activeAfterMuteAttempt.includes('student_102'),
      'student_101 must NOT be able to mute student_102 via AUDIO_STUDENT_SELF_MUTE'
    );

    // Also test AUDIO_STUDENT_SELF_UNMUTE IDOR when allowStudentUnmute is enabled
    await AudioStageController.setAllowStudentUnmute(roomA, true);
    await student101Socket.triggerClientEvent('AUDIO_STUDENT_SELF_UNMUTE', {
      studentId: 'student_103',
    });
    const activeAfterUnmuteAttempt = await AudioStageController.getActiveStudentMics(roomA);
    assert.equal(
      activeAfterUnmuteAttempt.includes('student_103'),
      false,
      'student_101 must NOT be able to unmute student_103 via AUDIO_STUDENT_SELF_UNMUTE'
    );
  });

  it('8. P2-4: protects GET /api/v1/sessions/:sessionId/attendance PII endpoint against unauthenticated and student access', async () => {
    // 1. Unauthenticated request must return 401
    const unauthAttRes = await server.fastify.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/attendance`,
    });
    assert.equal(
      unauthAttRes.statusCode,
      401,
      'Unauthenticated GET /attendance must be rejected with 401'
    );

    // 2. Student request must return 403
    const studentAttRes = await server.fastify.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/attendance`,
      headers: {
        authorization: `Bearer ${signedStudentJwt}`,
      },
    });
    assert.equal(
      studentAttRes.statusCode,
      403,
      'Student GET /attendance must be rejected with 403 (contains full student roster PII)'
    );

    // 3. Authorized Teacher request succeeds with 200 OK
    const teacherAttRes = await server.fastify.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/attendance`,
      headers: teacherHeaders,
    });
    assert.equal(
      teacherAttRes.statusCode,
      200,
      'Authorized Teacher GET /attendance must succeed with 200'
    );
    assert.equal(teacherAttRes.json().success, true);
  });

  it('9. Goal Deliverables: blocks student WHITEBOARD_CLEAR, enforces single-device JOIN_ROOM unless host enables multi-device, and isolates per-device self-mute', async () => {
    const { EventEmitter } = await import('node:events');
    const { AudioStageController } = await import('../../src/modules/audio-stage/audio.controller');
    const { WhiteboardEngine } = await import('../../src/modules/whiteboard/whiteboard.engine');

    const connectionListeners = server.io.listeners('connection') as Array<(socket: any) => Promise<void>>;
    const handleConnection = connectionListeners[0];

    const createTestSocket = (user: any, boundSessionId: string, deviceId?: string) => {
      const emitter = new EventEmitter();
      const emittedEvents: Array<{ event: string; payload: any }> = [];
      const joinedRooms = new Set<string>();
      const registeredHandlers = new Map<string, (...args: any[]) => Promise<void>>();

      const fakeSocket: any = {
        id: `sock_${user.userId}_${deviceId || 'default'}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        user,
        sessionId: boundSessionId,
        deviceId,
        handshake: {
          auth: { deviceId },
          query: { sessionId: boundSessionId, deviceId },
        },
        data: {},
        joinedRooms,
        emittedEvents,
        join: async (room: string) => {
          joinedRooms.add(room);
        },
        leave: async (room: string) => {
          joinedRooms.delete(room);
        },
        emit: (event: string, payload: any) => {
          emittedEvents.push({ event, payload });
          emitter.emit(event, payload);
        },
        on: (event: string, handler: (...args: any[]) => Promise<void>) => {
          registeredHandlers.set(event, handler);
        },
        to: () => ({ emit: () => {} }),
        volatile: { to: () => ({ emit: () => {} }) },
        disconnect: () => {},
        triggerClientEvent: async (event: string, payload?: any, ack?: any) => {
          const handler = registeredHandlers.get(event);
          assert.ok(handler, `Handler for ${event} must be registered`);
          await handler(payload, ack);
        },
      };
      return fakeSocket;
    };

    const roomGoal = `sess_goal_${Date.now()}`;

    const teacherSocket = createTestSocket(
      {
        userId: 'teacher_501',
        name: 'Dr. H.C. Verma',
        role: 'teacher',
        batchId: roomGoal,
        sessionId: roomGoal,
      },
      roomGoal,
      'dev_teacher_1'
    );
    await handleConnection(teacherSocket);
    await teacherSocket.triggerClientEvent('JOIN_ROOM', { sessionId: roomGoal, lastSeqId: 0 });

    const studentDev1Socket = createTestSocket(
      {
        userId: 'student_101',
        name: 'Rahul Verma',
        role: 'student',
        batchId: roomGoal,
        sessionId: roomGoal,
      },
      roomGoal,
      'dev_student_phone'
    );
    await handleConnection(studentDev1Socket);
    await studentDev1Socket.triggerClientEvent('JOIN_ROOM', {
      sessionId: roomGoal,
      lastSeqId: 0,
      deviceId: 'dev_student_phone',
    });
    assert.equal(
      studentDev1Socket.joinedRooms.has(roomGoal),
      true,
      'First device for student_101 must join roomGoal'
    );

    // 1. Student with whiteboard edit permission attempts WHITEBOARD_CLEAR -> must be rejected!
    await AudioStageController.grantWhiteboardAccess(roomGoal, 'student_101');
    await WhiteboardEngine.syncElements(roomGoal, [
      { id: 'teacher_diagram_1', type: 'rectangle', version: 1, x: 10, y: 10, isDeleted: false },
    ]);
    await studentDev1Socket.triggerClientEvent('WHITEBOARD_CLEAR');
    const elementsAfterStudentClearAttempt = await WhiteboardEngine.getAllElements(roomGoal);
    assert.equal(
      elementsAfterStudentClearAttempt.length,
      1,
      'Student must NOT be allowed to clear the whiteboard via WHITEBOARD_CLEAR even when granted whiteboard drawing permission'
    );

    // Teacher WHITEBOARD_CLEAR -> must succeed!
    await teacherSocket.triggerClientEvent('WHITEBOARD_CLEAR');
    const elementsAfterTeacherClear = await WhiteboardEngine.getAllElements(roomGoal);
    assert.equal(elementsAfterTeacherClear.length, 0, 'Teacher WHITEBOARD_CLEAR must clear the board');

    // 2. Second device (dev_student_laptop) for student_101 attempts JOIN_ROOM -> must be blocked!
    const studentDev2Socket = createTestSocket(
      {
        userId: 'student_101',
        name: 'Rahul Verma',
        role: 'student',
        batchId: roomGoal,
        sessionId: roomGoal,
      },
      roomGoal,
      'dev_student_laptop'
    );
    await handleConnection(studentDev2Socket);
    await studentDev2Socket.triggerClientEvent('JOIN_ROOM', {
      sessionId: roomGoal,
      lastSeqId: 0,
      deviceId: 'dev_student_laptop',
    });

    const blockedEvent = studentDev2Socket.emittedEvents.find(
      (e: any) => e.event === 'MULTI_DEVICE_BLOCKED'
    );
    assert.ok(blockedEvent, 'Second device must receive MULTI_DEVICE_BLOCKED when multi-device is disabled');
    assert.equal(
      studentDev2Socket.joinedRooms.has(roomGoal),
      false,
      'Blocked second device must not join the Socket.IO room'
    );

    // 3. Host Teacher enables multi-device access for student_101 via AUDIO_SET_STUDENT_MULTI_DEVICE
    await teacherSocket.triggerClientEvent('AUDIO_SET_STUDENT_MULTI_DEVICE', {
      studentId: 'student_101',
      allow: true,
    });

    // Now dev_student_laptop retries JOIN_ROOM -> succeeds!
    await studentDev2Socket.triggerClientEvent('JOIN_ROOM', {
      sessionId: roomGoal,
      lastSeqId: 0,
      deviceId: 'dev_student_laptop',
    });
    assert.equal(
      studentDev2Socket.joinedRooms.has(roomGoal),
      true,
      'Second device must be allowed to join after Host Teacher enables multi-device for student_101'
    );

    // 4. Independent device microphones: Teacher grants mic to student_101, both devices activate mic, then dev_student_phone self-mutes
    await AudioStageController.grantStudentMic(roomGoal, 'student_101', false);
    await (AudioStageController as any).setStudentDeviceMicState(
      roomGoal,
      'student_101',
      'dev_student_phone',
      true
    );
    await (AudioStageController as any).setStudentDeviceMicState(
      roomGoal,
      'student_101',
      'dev_student_laptop',
      true
    );

    await studentDev1Socket.triggerClientEvent('AUDIO_STUDENT_SELF_MUTE', {
      studentId: 'student_101',
      deviceId: 'dev_student_phone',
    });

    const activeMics = await AudioStageController.getActiveStudentMics(roomGoal);
    assert.ok(
      activeMics.includes('student_101'),
      'student_101 must remain in activeStudentMics when dev_student_phone mutes because dev_student_laptop is still unmuted'
    );
  });

  it('10. Bidirectional Whiteboard & Content Sync Across Host, Co-Host, and Student with Board Access', async () => {
    const { EventEmitter } = await import('node:events');
    const { AudioStageController } = await import('../../src/modules/audio-stage/audio.controller');
    const { WhiteboardEngine } = await import('../../src/modules/whiteboard/whiteboard.engine');
    const { ContentEngine } = await import('../../src/modules/content-sync/content.engine');

    const connectionListeners = server.io.listeners('connection') as Array<(socket: any) => Promise<void>>;
    const handleConnection = connectionListeners[0];

    const createTestSocket = (user: any, boundSessionId: string, deviceId?: string) => {
      const emitter = new EventEmitter();
      const emittedEvents: Array<{ event: string; payload: any }> = [];
      const joinedRooms = new Set<string>();
      const registeredHandlers = new Map<string, (...args: any[]) => Promise<void>>();

      const fakeSocket: any = {
        id: `sock_${user.userId}_${deviceId || 'default'}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        user,
        sessionId: boundSessionId,
        deviceId,
        handshake: {
          auth: { deviceId },
          query: { sessionId: boundSessionId, deviceId },
        },
        data: {},
        joinedRooms,
        emittedEvents,
        join: async (room: string) => {
          joinedRooms.add(room);
        },
        leave: async (room: string) => {
          joinedRooms.delete(room);
        },
        emit: (event: string, payload: any) => {
          emittedEvents.push({ event, payload });
          emitter.emit(event, payload);
        },
        on: (event: string, handler: (...args: any[]) => Promise<void>) => {
          registeredHandlers.set(event, handler);
        },
        to: () => ({ emit: () => {} }),
        volatile: { to: () => ({ emit: () => {} }) },
        disconnect: () => {},
        triggerClientEvent: async (event: string, payload?: any, ack?: any) => {
          const handler = registeredHandlers.get(event);
          assert.ok(handler, `Handler for ${event} must be registered`);
          await handler(payload, ack);
        },
      };
      return fakeSocket;
    };

    const roomSync = 'sess_bidirectional_sync_test';

    const hostSocket = createTestSocket(
      {
        userId: 'teacher_501',
        name: 'Dr. Anand Sharma',
        role: 'teacher',
        batchId: roomSync,
        sessionId: roomSync,
      },
      roomSync,
      'dev_host'
    );
    const coHostSocket = createTestSocket(
      {
        userId: 'teacher_502',
        name: 'Prof. Neha Verma',
        role: 'teacher',
        batchId: roomSync,
        sessionId: roomSync,
      },
      roomSync,
      'dev_cohost'
    );
    const studentSocket = createTestSocket(
      {
        userId: 'student_101',
        name: 'Rahul Verma',
        role: 'student',
        batchId: roomSync,
        sessionId: roomSync,
      },
      roomSync,
      'dev_student_101'
    );
    const viewerStudentSocket = createTestSocket(
      {
        userId: 'student_999',
        name: 'Priya Viewer',
        role: 'student',
        batchId: roomSync,
        sessionId: roomSync,
      },
      roomSync,
      'dev_student_999'
    );

    await handleConnection(hostSocket);
    await handleConnection(coHostSocket);
    await handleConnection(studentSocket);
    await handleConnection(viewerStudentSocket);

    await hostSocket.triggerClientEvent('JOIN_ROOM', { sessionId: roomSync, lastSeqId: 0 });
    await coHostSocket.triggerClientEvent('JOIN_ROOM', { sessionId: roomSync, lastSeqId: 0 });
    await studentSocket.triggerClientEvent('JOIN_ROOM', { sessionId: roomSync, lastSeqId: 0 });
    await viewerStudentSocket.triggerClientEvent('JOIN_ROOM', { sessionId: roomSync, lastSeqId: 0 });

    // 1. Host scrolls Whiteboard camera -> Co-Host & Students receive TEACHER_CAM_UPDATE with authorId='teacher_501'
    await hostSocket.triggerClientEvent('TEACHER_CAM_UPDATE', {
      x: -420,
      y: -310,
      w: 1280,
      h: 720,
      zoom: 1.25,
    });
    const hostCamState = await WhiteboardEngine.getTeacherCam(roomSync);
    assert.equal(hostCamState.x, -420);
    assert.equal(hostCamState.y, -310);
    assert.equal(hostCamState.authorId, 'teacher_501');

    // 2. Host grants Co-Host (teacher_502) Whiteboard access -> Co-Host scrolls Whiteboard camera -> updates state with authorId='teacher_502'
    await AudioStageController.setCoTeacherWhiteboardAccess(roomSync, 'teacher_502', true);
    await coHostSocket.triggerClientEvent('TEACHER_CAM_UPDATE', {
      x: -800,
      y: -600,
      w: 1440,
      h: 900,
      zoom: 1.5,
    });
    const coHostCamState = await WhiteboardEngine.getTeacherCam(roomSync);
    assert.equal(coHostCamState.x, -800);
    assert.equal(coHostCamState.y, -600);
    assert.equal(coHostCamState.authorId, 'teacher_502');

    // 3. Unauthorized viewer student (student_999) attempts TEACHER_CAM_UPDATE -> ignored!
    await viewerStudentSocket.triggerClientEvent('TEACHER_CAM_UPDATE', {
      x: 9999,
      y: 9999,
      w: 800,
      h: 600,
      zoom: 1,
    });
    const camAfterUnauthorized = await WhiteboardEngine.getTeacherCam(roomSync);
    assert.equal(
      camAfterUnauthorized.x,
      -800,
      'Unauthorized student must not be able to overwrite TEACHER_CAM_UPDATE'
    );

    // 4. Grant student_101 whiteboard access -> student_101 can now sync TEACHER_CAM_UPDATE, CONTENT_SCROLL_SYNC, and CONTENT_LASER_MOVE
    await AudioStageController.grantWhiteboardAccess(roomSync, 'student_101');

    await studentSocket.triggerClientEvent('TEACHER_CAM_UPDATE', {
      x: -150,
      y: -250,
      w: 1024,
      h: 768,
      zoom: 1.1,
    });
    const studentCamState = await WhiteboardEngine.getTeacherCam(roomSync);
    assert.equal(studentCamState.x, -150);
    assert.equal(studentCamState.y, -250);
    assert.equal(studentCamState.authorId, 'student_101');

    // 5. Content Mode Scroll Sync from Host, Co-Host, and Authorized Student
    await hostSocket.triggerClientEvent('CONTENT_SCROLL_SYNC', {
      activeBlockId: 'blk_faraday_law',
      blockOffsetRatio: 0.45,
    });
    let contentState = await ContentEngine.getState(roomSync);
    assert.equal(contentState.activeBlockId, 'blk_faraday_law');
    assert.equal(contentState.blockOffsetRatio, 0.45);
    assert.equal(contentState.scrollAuthorId, 'teacher_501');

    await coHostSocket.triggerClientEvent('CONTENT_SCROLL_SYNC', {
      activeBlockId: 'blk_lenz_law',
      blockOffsetRatio: 0.75,
    });
    contentState = await ContentEngine.getState(roomSync);
    assert.equal(contentState.activeBlockId, 'blk_lenz_law');
    assert.equal(contentState.blockOffsetRatio, 0.75);
    assert.equal(contentState.scrollAuthorId, 'teacher_502');

    await studentSocket.triggerClientEvent('CONTENT_SCROLL_SYNC', {
      activeBlockId: 'blk_summary',
      blockOffsetRatio: 0.9,
    });
    contentState = await ContentEngine.getState(roomSync);
    assert.equal(contentState.activeBlockId, 'blk_summary');
    assert.equal(contentState.blockOffsetRatio, 0.9);
    assert.equal(contentState.scrollAuthorId, 'student_101');

    // Unauthorized viewer student cannot overwrite CONTENT_SCROLL_SYNC
    await viewerStudentSocket.triggerClientEvent('CONTENT_SCROLL_SYNC', {
      activeBlockId: 'blk_header',
      blockOffsetRatio: 0,
    });
    contentState = await ContentEngine.getState(roomSync);
    assert.equal(
      contentState.activeBlockId,
      'blk_summary',
      'Unauthorized viewer student must not overwrite CONTENT_SCROLL_SYNC'
    );
  });

  it('11. Hybrid Voice Relay (AUDIO_VOICE_FRAME) & LiveKit URL in Session Init', async () => {
    const { EventEmitter } = await import('node:events');
    const { AudioStageController } = await import('../../src/modules/audio-stage/audio.controller');

    // 1. Verify POST /api/v1/sessions/init returns livekit.url alongside token & roomName
    const voiceInitTeacherToken = JwtVerifier.sign({
      userId: 'teacher_501',
      name: 'Prof. S. Verma',
      role: 'teacher',
      sessionId: 'sess_voice_init_test',
      batchId: 'batch_voice_1',
    });
    const initRes = await server.fastify.inject({
      method: 'POST',
      url: '/api/v1/sessions/init',
      headers: {
        authorization: `Bearer ${voiceInitTeacherToken}`,
      },
      payload: {
        sessionId: 'sess_voice_init_test',
        batchId: 'batch_voice_1',
      },
    });
    assert.equal(initRes.statusCode, 200);
    const initBody = initRes.json();
    assert.equal(initBody.success, true);
    assert.ok(initBody.data.livekit.token, 'livekit.token must be present');
    assert.ok(initBody.data.livekit.url, 'livekit.url must be returned in /api/v1/sessions/init');

    // 2. Verify AUDIO_VOICE_FRAME relays authorized teacher & permitted student audio while blocking unauthorized students
    const connectionListeners = server.io.listeners('connection') as Array<(socket: any) => Promise<void>>;
    const handleConnection = connectionListeners[0];

    const roomBroadcasts: Array<{ event: string; payload: any }> = [];
    const createVoiceTestSocket = (user: any, boundSessionId: string, deviceId?: string) => {
      const emitter = new EventEmitter();
      const joinedRooms = new Set<string>();
      const registeredHandlers = new Map<string, (...args: any[]) => Promise<void>>();

      const fakeSocket: any = {
        id: `sock_${user.userId}_${deviceId || 'default'}_${Date.now()}`,
        user,
        sessionId: boundSessionId,
        deviceId,
        handshake: {
          auth: { deviceId },
          query: { sessionId: boundSessionId, deviceId },
        },
        data: {},
        joinedRooms,
        join: async (room: string) => {
          joinedRooms.add(room);
        },
        leave: async (room: string) => {
          joinedRooms.delete(room);
        },
        emit: (event: string, payload: any) => {
          emitter.emit(event, payload);
        },
        on: (event: string, handler: (...args: any[]) => Promise<void>) => {
          registeredHandlers.set(event, handler);
        },
        to: () => ({
          emit: (event: string, payload: any) => {
            roomBroadcasts.push({ event, payload });
          },
        }),
        volatile: {
          to: () => ({
            emit: (event: string, payload: any) => {
              roomBroadcasts.push({ event, payload });
            },
          }),
        },
        disconnect: () => {},
        triggerClientEvent: async (event: string, payload?: any, ack?: any) => {
          const handler = registeredHandlers.get(event);
          assert.ok(handler, `Handler for ${event} must be registered`);
          await handler(payload, ack);
        },
      };
      return fakeSocket;
    };

    const roomVoice = `sess_voice_relay_test_${Date.now()}`;
    const hostSocket = createVoiceTestSocket(
      {
        userId: 'teacher_501',
        name: 'Dr. Anand Sharma',
        role: 'teacher',
        batchId: roomVoice,
        sessionId: roomVoice,
      },
      roomVoice,
      'dev_host_voice'
    );
    const studentSocket = createVoiceTestSocket(
      {
        userId: 'student_101',
        name: 'Rahul Verma',
        role: 'student',
        batchId: roomVoice,
        sessionId: roomVoice,
      },
      roomVoice,
      'dev_student_voice'
    );

    await handleConnection(hostSocket);
    await handleConnection(studentSocket);
    await hostSocket.triggerClientEvent('JOIN_ROOM', { sessionId: roomVoice, lastSeqId: 0 });
    await studentSocket.triggerClientEvent('JOIN_ROOM', { sessionId: roomVoice, lastSeqId: 0 });

    roomBroadcasts.length = 0;

    // Host teacher emits AUDIO_VOICE_FRAME -> relayed to room
    await hostSocket.triggerClientEvent('AUDIO_VOICE_FRAME', {
      pcm: 'AAAA//8AAAD//w==',
      sampleRate: 16000,
      seq: 1,
      rms: 0.25,
    });
    const hostFrame = roomBroadcasts.find((b) => b.event === 'AUDIO_VOICE_FRAME' && b.payload.senderId === 'teacher_501');
    assert.ok(hostFrame, 'Host teacher AUDIO_VOICE_FRAME must be relayed to room participants');

    // Unauthorized student emits AUDIO_VOICE_FRAME -> blocked
    roomBroadcasts.length = 0;
    await studentSocket.triggerClientEvent('AUDIO_VOICE_FRAME', {
      pcm: 'AAAA//8AAAD//w==',
      sampleRate: 16000,
      seq: 2,
      rms: 0.3,
    });
    const unauthStudentFrame = roomBroadcasts.find(
      (b) => b.event === 'AUDIO_VOICE_FRAME' && b.payload.senderId === 'student_101'
    );
    assert.equal(unauthStudentFrame, undefined, 'Unauthorized student AUDIO_VOICE_FRAME must NOT be relayed');

    // Grant student mic -> student emits AUDIO_VOICE_FRAME -> relayed to room
    await AudioStageController.grantStudentMic(roomVoice, 'student_101', false);
    await studentSocket.triggerClientEvent('AUDIO_VOICE_FRAME', {
      pcm: 'AAAA//8AAAD//w==',
      sampleRate: 16000,
      seq: 3,
      rms: 0.35,
    });
    const authStudentFrame = roomBroadcasts.find(
      (b) => b.event === 'AUDIO_VOICE_FRAME' && b.payload.senderId === 'student_101'
    );
    assert.ok(authStudentFrame, 'Authorized student AUDIO_VOICE_FRAME must be relayed to room participants');
  });

  it('18. supports Mute All when allowStudentUnmute is enabled or student mics are active, tracks device mic active counts, and closes broadcast after 5-min Host/Co-Host grace timeout', async () => {
    const { AudioStageController } = await import('../../src/modules/audio-stage/audio.controller');
    const { AutoSaveService } = await import('../../src/modules/autosave/autosave.worker');
    const { RoomManager } = await import('../../src/modules/room/room.manager');
    const roomGrace = `sess_grace_mute_all_${Date.now()}`;

    // 1. Enable allowStudentUnmute and verify student mic activation via AUDIO_DEVICE_MIC_ACTIVE / self-unmute
    await AudioStageController.setAllowStudentUnmute(roomGrace, true);
    let stageState = await AudioStageController.getStageState(roomGrace);
    assert.equal(stageState.allowStudentUnmute, true);

    await AudioStageController.setStudentDeviceMicState(roomGrace, 'student_201', 'dev_mob_1', true);
    stageState = await AudioStageController.getStageState(roomGrace);
    assert.equal(stageState.activeStudentMics.includes('student_201'), true);

    // 2. Mute All Students -> clears activeStudentMics AND resets allowStudentUnmute to false
    const mutedIds = await AudioStageController.muteAllStudents(roomGrace);
    assert.equal(mutedIds.includes('student_201'), true);
    stageState = await AudioStageController.getStageState(roomGrace);
    assert.equal(stageState.activeStudentMics.length, 0);
    assert.equal(stageState.allowStudentUnmute, false, 'muteAllStudents must reset allowStudentUnmute to false');

    // 3. Verify 5-minute (300s) grace timer and automatic session close + student disconnect when no Host/Co-Host is active
    await RoomManager.getOrInitRoom(roomGrace);
    await RoomManager.setTeacherStatus(roomGrace, 'LIVE');

    const timerInfo = await AutoSaveService.startTeacherGraceTimer(roomGrace, 300);
    assert.equal(timerInfo.gracePeriodSeconds, 300);
    assert.ok(timerInfo.graceEndsAt > Date.now());
    const reconnectingRoom = await RoomManager.getOrInitRoom(roomGrace);
    assert.equal(reconnectingRoom.status, 'TEACHER_RECONNECTING');

    // Simulate grace period expiration when no Host or Co-Host has rejoined
    await AutoSaveService.executeGraceFinalize(roomGrace);
    const endedRoom = await RoomManager.getOrInitRoom(roomGrace);
    assert.equal(endedRoom.status, 'ENDED', 'Broadcast status must be marked ENDED after 5-min grace timeout expires with no Host/Co-Host');
  });

  it('19. keeps a single continuous recording across lesson/chapter changes and resumes existing video after engine restart or instructor rejoin without resetting', async () => {
    const { getStorageProvider } = await import('../../src/adapters/storage.provider');
    const storage = getStorageProvider();
    const resumeSessionId = `sess_continuous_resume_${Date.now()}`;
    const resumeTeacherJwt = JwtVerifier.sign({
      userId: 'teacher_501',
      name: 'Prof. S. Verma',
      role: 'teacher',
      sessionId: resumeSessionId,
      batchId: '105',
    });
    const resumeTeacherHeaders = {
      authorization: `Bearer ${resumeTeacherJwt}`,
    };

    // 1. Upload Chunk #0 on Chapter 1 / Lesson 301
    const chunk0 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x10, 0x20, 0x30, 0x40]);
    const res0 = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${resumeSessionId}/video-chunk?chunkIndex=0&courseId=77&boardId=1&languageId=1&chapterId=1&lessonId=301&version=1&academicYear=2026&reset=1`,
      headers: {
        ...resumeTeacherHeaders,
        'content-type': 'video/webm;codecs=vp9,opus',
      },
      payload: chunk0,
    });
    assert.equal(res0.statusCode, 200);

    // 2. Instructor changes Chapter & Lesson mid-session (Chapter 2 / Lesson 302) -> Chunk #1 appends to the SAME continuous video
    const chunk1 = Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x50, 0x60, 0x70, 0x80]);
    const res1 = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${resumeSessionId}/video-chunk?chunkIndex=1&courseId=77&boardId=1&languageId=1&chapterId=2&lessonId=302&version=1&academicYear=2026`,
      headers: {
        ...resumeTeacherHeaders,
        'content-type': 'video/webm;codecs=vp9,opus',
      },
      payload: chunk1,
    });
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.json().data.totalBytesWritten, chunk0.length + chunk1.length);

    // 3. Simulate server restart by clearing in-memory videoRecordings map, then check getSessionVideoState rehydration from disk
    (storage as any).videoRecordings.delete(resumeSessionId);
    const rehydratedState = storage.getSessionVideoState(resumeSessionId);
    assert.ok(rehydratedState, 'Video recording state must rehydrate from disk after server restart');
    assert.equal(rehydratedState?.totalBytesWritten, chunk0.length + chunk1.length);
    assert.equal(rehydratedState?.nextExpectedChunkIndex, 2);
    assert.equal(rehydratedState?.startingRelationalContext?.lessonId, 301);

    // 4. Instructor rejoins after browser reload (MediaRecorder emits chunkIndex=0 with resume=1) -> must append as chunk #2 instead of overwriting
    const chunkRejoin = Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x90, 0xa0, 0xb0, 0xc0]);
    const resRejoin = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${resumeSessionId}/video-chunk?chunkIndex=0&courseId=77&boardId=1&languageId=1&chapterId=2&lessonId=302&version=1&academicYear=2026&resume=1`,
      headers: {
        ...resumeTeacherHeaders,
        'content-type': 'video/webm;codecs=vp9,opus',
        'x-resume-recording': '1',
      },
      payload: chunkRejoin,
    });
    assert.equal(resRejoin.statusCode, 200);
    assert.equal(
      resRejoin.json().data.totalBytesWritten,
      chunk0.length + chunk1.length + chunkRejoin.length,
      'Rejoined instructor video chunk with resume=1 must append to existing recording instead of starting from scratch'
    );
    assert.equal(resRejoin.json().data.nextExpectedChunkIndex, 3);
  });

  it('20. clears session and audio state on POST /api/v1/sessions/:sessionId/end, prevents auto-reviving ENDED sessions on init without restart=true, and revives only when restart=true', async () => {
    const { RoomManager } = await import('../../src/modules/room/room.manager');
    const { AudioStageController } = await import('../../src/modules/audio-stage/audio.controller');

    const endTestSessionId = `sess_end_cleanup_${Date.now()}`;
    const endTeacherJwt = JwtVerifier.sign({
      userId: 'teacher_777',
      name: 'Prof. R. Sharma',
      role: 'teacher',
      sessionId: endTestSessionId,
      batchId: '108',
    });

    // 1. Initialize live classroom session as teacher
    const initLiveRes = await server.fastify.inject({
      method: 'POST',
      url: '/api/v1/sessions/init',
      payload: {
        sessionId: endTestSessionId,
        role: 'teacher',
        teacherId: 'teacher_777',
        token: endTeacherJwt,
      },
    });
    assert.equal(initLiveRes.statusCode, 200);
    assert.equal(initLiveRes.json().data.status, 'LIVE');

    // Simulate active audio stage state (raised hand, granted student mic, teacher mic on)
    await AudioStageController.raiseHand(endTestSessionId, {
      userId: 'student_301',
      name: 'Aarav',
      raisedAt: Date.now(),
    });
    await AudioStageController.setTeacherMicActive(endTestSessionId, true);
    const stageBeforeEnd = await AudioStageController.getStageState(endTestSessionId);
    assert.equal(
      stageBeforeEnd.raisedHands.some((h) => h.userId === 'student_301'),
      true
    );
    assert.equal(stageBeforeEnd.teacherMicActive, true);

    // 2. End classroom session via REST endpoint
    const endRes = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${endTestSessionId}/end`,
      headers: {
        authorization: `Bearer ${endTeacherJwt}`,
      },
      payload: {},
    });
    assert.equal(endRes.statusCode, 200);
    assert.equal(endRes.json().success, true);
    const roomAfterEnd = await RoomManager.getOrInitRoom(endTestSessionId);
    assert.equal(roomAfterEnd.status, 'ENDED');

    // Verify Redis audio stage state is completely wiped and sessionId is removed from active_broadcast_sessions
    const stageAfterEnd = await AudioStageController.getStageState(endTestSessionId);
    assert.equal(stageAfterEnd.raisedHands.length, 0);
    assert.equal(stageAfterEnd.activeStudentMics.length, 0);
    assert.equal(
      await AudioStageController.hasStudentMicPermission(endTestSessionId, 'student_301'),
      false
    );
    assert.equal(stageAfterEnd.teacherMicActive, false);
    const isActiveMember = await redis.sismember(
      'active_broadcast_sessions',
      endTestSessionId
    );
    assert.equal(isActiveMember, 0);

    // 3. Calling /api/v1/sessions/init with teacher token WITHOUT restart=true must NOT revive the ENDED session
    const initWithoutRestartRes = await server.fastify.inject({
      method: 'POST',
      url: '/api/v1/sessions/init',
      payload: {
        sessionId: endTestSessionId,
        role: 'teacher',
        teacherId: 'teacher_777',
        token: endTeacherJwt,
      },
    });
    assert.equal(initWithoutRestartRes.statusCode, 200);
    assert.equal(
      initWithoutRestartRes.json().data.status,
      'ENDED',
      'Ended classroom session must stay ENDED when teacher calls init without restart=true'
    );

    // 4. Calling /api/v1/sessions/init with teacher token AND restart=true revives the session to LIVE
    const initWithRestartRes = await server.fastify.inject({
      method: 'POST',
      url: '/api/v1/sessions/init',
      payload: {
        sessionId: endTestSessionId,
        role: 'teacher',
        teacherId: 'teacher_777',
        token: endTeacherJwt,
        restart: true,
      },
    });
    assert.equal(initWithRestartRes.statusCode, 200);
    assert.equal(
      initWithRestartRes.json().data.status,
      'LIVE',
      'Ended classroom session must transition back to LIVE when teacher explicitly passes restart=true'
    );

    // Clean up test session
    await RoomManager.endSession(endTestSessionId);
  });
});
