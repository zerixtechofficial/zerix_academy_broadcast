import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';
import * as http from 'node:http';

import { JwtVerifier } from '../../src/utils/jwtVerifier';
import { FileCache } from '../../src/utils/fileCache';
import { StorageProvider, setStorageProvider } from '../../src/adapters/storage.provider';
import {
  SessionTimelineTracker,
  getSessionTimelineTracker,
} from '../../src/modules/session-timeline/sessionTimeline.tracker';
import { LaravelApiDataProvider } from '../../src/adapters/laravelApi.provider';
import { RelationalLessonContext } from '../../src/types/broadcast.types';
import { AudioStageController } from '../../src/modules/audio-stage/audio.controller';
import { AutoSaveService } from '../../src/modules/autosave/autosave.worker';
import { RoomManager } from '../../src/modules/room/room.manager';
import { WhiteboardEngine } from '../../src/modules/whiteboard/whiteboard.engine';
import { redis, pubClient, subClient } from '../../src/config/redis';

describe('Phase 1 Unit Tests: JWT Verifier, StorageProvider, and SessionTimelineTracker', () => {
  let tempDir: string;
  let storageProvider: StorageProvider;

  before(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'broadcast-phase1-unit-'));
    storageProvider = new StorageProvider({
      driver: 'local_disk',
      cacheDir: path.join(tempDir, 'storage_cache'),
      localFallbackDir: path.join(tempDir, 'local_r2'),
      publicCdnUrl: '',
    });
    setStorageProvider(storageProvider);
  });

  after(async () => {
    await AutoSaveService.close().catch(() => {});
    setStorageProvider(null);
    FileCache.invalidate();
    if (tempDir && fs.existsSync(tempDir)) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
    redis.disconnect();
    pubClient.disconnect();
    subClient.disconnect();
  });

  describe('1. JwtVerifier (Zero-DB HMAC-SHA256 Local Token Verification)', () => {
    const testSecret = 'zerix-unit-test-hmac-secret-2026';

    it('signs and verifies a valid HS256 student JWT with sub-millisecond latency', () => {
      const token = JwtVerifier.sign(
        {
          userId: 'stu_9001',
          name: 'Aarav Kumar',
          role: 'student',
          sessionId: 'batch_physics_101',
          batchId: 105,
          branchId: 4,
          courseId: 12,
          linkedVodCourseId: 212,
          enrollmentId: 5501,
        },
        { secret: testSecret, expiresInSeconds: 3600 }
      );

      assert.equal(JwtVerifier.looksLikeJwt(token), true);

      const t0 = performance.now();
      const result = JwtVerifier.verify(token, {
        secret: testSecret,
        expectedSessionId: 'batch_physics_101',
      });
      const elapsedMs = performance.now() - t0;

      assert.equal(result.valid, true);
      assert.equal(result.claims?.userId, 'stu_9001');
      assert.equal(result.claims?.role, 'student');
      assert.equal(result.claims?.batchId, 105);
      assert.equal(result.claims?.courseId, 12);
      assert.ok(elapsedMs < 5, `Expected verification under 5ms, took ${elapsedMs.toFixed(3)}ms`);
    });

    it('rejects a JWT with a tampered payload or wrong signature', () => {
      const token = JwtVerifier.sign(
        {
          userId: 'stu_9001',
          role: 'student',
          sessionId: 'batch_physics_101',
        },
        { secret: testSecret }
      );

      // Tamper with the payload segment (attempt privilege escalation to teacher)
      const parts = token.split('.');
      const forgedPayload = JwtVerifier.base64UrlEncode(
        JSON.stringify({
          userId: 'stu_9001',
          role: 'teacher',
          sessionId: 'batch_physics_101',
        })
      );
      const forgedToken = `${parts[0]}.${forgedPayload}.${parts[2]}`;

      const result = JwtVerifier.verify(forgedToken, { secret: testSecret });
      assert.equal(result.valid, false);
      assert.match(result.reason || '', /Invalid JWT cryptographic signature/);
    });

    it('rejects an expired JWT token', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const expiredToken = JwtVerifier.sign(
        {
          userId: 'stu_9002',
          role: 'student',
          sessionId: 'batch_physics_101',
          iat: nowSec - 7200,
          exp: nowSec - 60,
        },
        { secret: testSecret }
      );

      const result = JwtVerifier.verify(expiredToken, { secret: testSecret });
      assert.equal(result.valid, false);
      assert.match(result.reason || '', /expired/i);
    });

    it('rejects a valid JWT when attempting to join a different batch sessionId', () => {
      const tokenForBatchA = JwtVerifier.sign(
        {
          userId: 'stu_9003',
          role: 'student',
          sessionId: 'batch_ssc_cgl_101',
        },
        { secret: testSecret }
      );

      const result = JwtVerifier.verify(tokenForBatchA, {
        secret: testSecret,
        expectedSessionId: 'batch_banking_po_202',
      });
      assert.equal(result.valid, false);
      assert.match(result.reason || '', /sessionId mismatch/);
    });

    it('integrates with LaravelApiDataProvider.validateToken for signed classroom JWT tokens', async () => {
      const provider = new LaravelApiDataProvider('http://127.0.0.1:59999');
      const jwtToken = JwtVerifier.sign({
        userId: 'stu_jwt_77',
        name: 'Priya Singh',
        role: 'student',
        sessionId: 'batch_physics_101',
        batchId: '105',
      });

      const jwtUser = await provider.validateToken(jwtToken, 'batch_physics_101');
      assert.ok(jwtUser);
      assert.equal(jwtUser?.userId, 'stu_jwt_77');
      assert.equal(jwtUser?.role, 'student');

      const teacherToken = JwtVerifier.sign({
        userId: 'teacher_501',
        name: 'Prof. S. Verma',
        role: 'teacher',
        sessionId: 'batch_physics_101',
        batchId: '105',
      });
      const jwtTeacher = await provider.validateToken(teacherToken, 'batch_physics_101');
      assert.ok(jwtTeacher);
      assert.equal(jwtTeacher?.role, 'teacher');
    });
  });

  describe('2. StorageProvider (Deterministic Keys, Out-of-Order Video Chunks, Gzip Whiteboard & HTTP 206)', () => {
    const sampleContext: RelationalLessonContext = {
      sessionId: 'sess_unit_101',
      branchId: 4,
      batchId: 105,
      boardId: 2,
      languageId: 1,
      courseId: 12,
      linkedVodCourseId: 212,
      subjectId: 7,
      chapterId: 3,
      chapterNumber: 1,
      chapterTitle: 'Electricity & Circuit Dynamics',
      lessonId: 42,
      lessonNumber: '1.1',
      lessonTitle: 'Ohm Law & Resistivity',
      topicId: null,
      teacherId: 501,
      academicYear: 2026,
      version: 1,
      publishToVodCourse: true,
      isPrimaryVod: true,
    };

    it('generates exact deterministic storage keys for Academic and Competitive Exam hierarchies', () => {
      const videoKey = StorageProvider.buildLessonVideoKey(sampleContext, 'webm');
      const wbKey = StorageProvider.buildTopicWhiteboardKey(sampleContext);

      assert.equal(
        videoKey,
        'courses/course_12/board_2_lang_1/ch_3/lesson_42/v1_2026/video_720p.webm'
      );
      assert.equal(
        wbKey,
        'courses/course_12/board_2_lang_1/ch_3/lesson_42/v1_2026/whiteboard.json'
      );

      // Competitive exam context where boardId is null and examId is 14 (e.g. SSC CGL / NEET)
      const examVideoKey = StorageProvider.buildLessonVideoKey(
        {
          ...sampleContext,
          boardId: null,
          examId: 14,
          courseId: 99,
          chapterId: 8,
          lessonId: 108,
        },
        'webm'
      );
      assert.equal(
        examVideoKey,
        'courses/course_99/board_14_lang_1/ch_8/lesson_108/v1_2026/video_720p.webm'
      );
    });

    it('reassembles out-of-order video chunks (0, 2, 1, 3), ignores duplicates, and patches WebM duration header', async () => {
      const sessionId = 'sess_chunk_reassembly_test';

      // Construct a synthetic WebM header containing EBML Duration element [0x44, 0x89, 0x88, <8-byte float64>]
      const chunk0 = Buffer.alloc(32, 0x1a);
      chunk0[10] = 0x44;
      chunk0[11] = 0x89;
      chunk0[12] = 0x88; // Float64 indicator
      chunk0.writeDoubleBE(0.0, 13); // Initial 0ms duration in stream header

      const chunk1 = Buffer.from('CHUNK_1_PAYLOAD_AAAA', 'utf-8');
      const chunk2 = Buffer.from('CHUNK_2_PAYLOAD_BBBB', 'utf-8');
      const chunk3 = Buffer.from('CHUNK_3_PAYLOAD_CCCC', 'utf-8');

      // 1. Upload chunk 0
      const res0 = await storageProvider.appendVideoChunk(sessionId, chunk0, {
        chunkIndex: 0,
        relationalContext: sampleContext,
      });
      assert.equal(res0.nextExpectedChunkIndex, 1);
      assert.equal(res0.totalBytesWritten, chunk0.length);

      // 2. Upload chunk 2 BEFORE chunk 1 (simulating random network jitter)
      const res2 = await storageProvider.appendVideoChunk(sessionId, chunk2, {
        chunkIndex: 2,
        relationalContext: sampleContext,
      });
      assert.equal(res2.nextExpectedChunkIndex, 1, 'Should wait for chunk 1 before flushing chunk 2');
      assert.equal(res2.bufferedOutOfOrderCount, 1);
      assert.equal(res2.bytesAppended, 0);

      // 3. Upload chunk 1 -> should automatically flush both chunk 1 AND buffered chunk 2 in exact order!
      const res1 = await storageProvider.appendVideoChunk(sessionId, chunk1, {
        chunkIndex: 1,
        relationalContext: sampleContext,
      });
      assert.equal(res1.nextExpectedChunkIndex, 3);
      assert.equal(res1.bufferedOutOfOrderCount, 0);
      assert.equal(res1.bytesAppended, chunk1.length + chunk2.length);

      // 4. Retry duplicate chunk 1 -> must be idempotently ignored
      const dup1 = await storageProvider.appendVideoChunk(sessionId, chunk1, {
        chunkIndex: 1,
        relationalContext: sampleContext,
      });
      assert.equal(dup1.duplicateIgnored, true);
      assert.equal(dup1.bytesAppended, 0);

      // 5. Upload chunk 3
      const res3 = await storageProvider.appendVideoChunk(sessionId, chunk3, {
        chunkIndex: 3,
        relationalContext: sampleContext,
      });
      assert.equal(res3.nextExpectedChunkIndex, 4);

      // 6. Finalize recording with 45 seconds duration and verify EBML duration header + byte order
      const finalized = await storageProvider.finalizeVideoRecording(sessionId, sampleContext, {
        durationSec: 45,
      });

      assert.equal(
        finalized.totalBytes,
        chunk0.length + chunk1.length + chunk2.length + chunk3.length
      );
      assert.equal(finalized.chunksCount, 4);

      const finalBytes = await fs.promises.readFile(finalized.cachePath);
      const patchedDurationMs = finalBytes.readDoubleBE(13);
      assert.equal(patchedDurationMs, 45000, 'WebM EBML 0x4489 duration must be patched to 45000ms');

      const trailingText = finalBytes.subarray(chunk0.length).toString('utf-8');
      assert.equal(
        trailingText,
        'CHUNK_1_PAYLOAD_AAAACHUNK_2_PAYLOAD_BBBBCHUNK_3_PAYLOAD_CCCC',
        'Chunks must be assembled in strict 0 -> 1 -> 2 -> 3 order'
      );
    });

    it('strips Content Mode pen/laser strokes and compresses whiteboard.json with gzip + FileCache update', async () => {
      const wbKey = StorageProvider.buildTopicWhiteboardKey(sampleContext);
      const rawArtifact = {
        sessionId: sampleContext.sessionId,
        relationalContext: sampleContext,
        elements: [
          { id: 'wb_rect_1', type: 'rectangle', x: 10, y: 20, strokeColor: '#000000' },
          { id: 'wb_text_1', type: 'text', text: 'V = I * R', strokeColor: '#12a3ff' },
          // Content Mode and Laser elements that MUST be stripped:
          { id: 'content_pen_1', type: 'freedraw', mode: 'CONTENT', isContentAnnotation: true },
          { id: 'laser_1', type: 'laser', tool: 'LASER' },
          { id: 'deleted_1', type: 'ellipse', isDeleted: true },
        ],
        appState: { viewBackgroundColor: '#ffffff', gridSize: 20 },
        files: {},
      };

      const writeRes = await storageProvider.putGzippedWhiteboard(wbKey, rawArtifact);
      assert.ok(writeRes.gzippedBytes > 0);
      assert.ok(writeRes.uncompressedBytes > 0);

      // Verify FileCache was automatically populated for both .json and .json.gz
      assert.equal(FileCache.has(writeRes.cachePath), true);
      assert.equal(FileCache.has(`${writeRes.cachePath}.gz`), true);

      const loaded = await storageProvider.getGzippedWhiteboard(wbKey);
      assert.ok(loaded);
      assert.equal(
        loaded?.artifact.elements.length,
        2,
        'Only the 2 genuine Whiteboard elements must be stored; Content Mode & Laser strokes must be stripped'
      );
      assert.deepEqual(
        loaded?.artifact.elements.map((e: any) => e.id),
        ['wb_rect_1', 'wb_text_1']
      );

      // Verify gzipped buffer decompresses cleanly to the exact sanitized JSON
      const gunzippedJson = JSON.parse(zlib.gunzipSync(loaded!.gzippedBuffer).toString('utf-8'));
      assert.equal(gunzippedJson.elements.length, 2);
      assert.equal(gunzippedJson.relationalContext.lessonId, 42);
    });

    it('serves RFC 7233 HTTP 206 Partial Content byte ranges and rejects invalid ranges with 416', async () => {
      const videoKey = StorageProvider.buildLessonVideoKey(sampleContext, 'webm');

      // 1. Full stream (no Range header -> 200 OK)
      const fullRes = await storageProvider.createVideoByteRangeStream(videoKey);
      assert.equal(fullRes.statusCode, 200);
      assert.equal(fullRes.headers['Accept-Ranges'], 'bytes');
      fullRes.stream?.destroy();

      // 2. Partial byte range: bytes=0-15 -> 206 Partial Content (16 bytes)
      const rangeRes = await storageProvider.createVideoByteRangeStream(videoKey, 'bytes=0-15');
      assert.equal(rangeRes.statusCode, 206);
      assert.equal(rangeRes.headers['Content-Length'], 16);
      assert.match(String(rangeRes.headers['Content-Range']), /^bytes 0-15\/\d+$/);

      const chunks: Buffer[] = [];
      for await (const chunk of rangeRes.stream!) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rangeBytes = Buffer.concat(chunks);
      assert.equal(rangeBytes.length, 16);

      // 3. Out-of-bounds range -> 416 Range Not Satisfiable
      const invalidRange = await storageProvider.createVideoByteRangeStream(
        videoKey,
        'bytes=999999-1000005'
      );
      assert.equal(invalidRange.statusCode, 416);

      // 4. Non-existent video -> 404 Not Found
      const notFound = await storageProvider.createVideoByteRangeStream(
        'courses/course_999/non_existent.webm',
        'bytes=0-100'
      );
      assert.equal(notFound.statusCode, 404);
    });
  });

  describe('3. SessionTimelineTracker (Multi-Topic Teaching & Reference-Only Overwrite Protection)', () => {
    it('tracks multiple taught lessons in one continuous video and NEVER overwrites a reference-only lesson', async () => {
      const tracker = new SessionTimelineTracker();
      const sessionId = 'sess_multi_topic_protection';

      const baseContext: RelationalLessonContext = {
        sessionId,
        branchId: 4,
        batchId: 105,
        boardId: 2,
        languageId: 1,
        courseId: 12,
        linkedVodCourseId: 212,
        subjectId: 7,
        chapterId: 1,
        chapterNumber: 1,
        chapterTitle: 'Chapter 1: Electrostatics',
        lessonId: 101,
        lessonNumber: '1.1',
        lessonTitle: 'Coulomb Law',
        topicId: null,
        teacherId: 501,
        academicYear: 2026,
        version: 1,
        publishToVodCourse: true,
        isPrimaryVod: true,
      };

      // Pre-seed an existing Whiteboard artifact for old Lesson 99 (taught last week)
      const oldLesson99Context: RelationalLessonContext = {
        ...baseContext,
        lessonId: 99,
        lessonNumber: '0.9',
        lessonTitle: 'Vector Algebra Prerequisite (Taught Last Week)',
      };
      const oldLesson99WbKey = StorageProvider.buildTopicWhiteboardKey(oldLesson99Context);
      await storageProvider.putGzippedWhiteboard(oldLesson99WbKey, {
        sessionId: 'previous_week_session',
        relationalContext: oldLesson99Context,
        elements: [{ id: 'precious_old_diagram', type: 'rectangle', text: 'DO NOT OVERWRITE' }],
      });

      // Start today's session on Lesson 101 (0s -> 600s)
      tracker.ensureSession(sessionId, baseContext);
      await storageProvider.appendVideoChunk(
        sessionId,
        Buffer.from('VIDEO_DATA_PART_1_FOR_SESSION'),
        { chunkIndex: 0, relationalContext: baseContext }
      );
      tracker.recordVideoChunkUploaded(sessionId, 0, 29, baseContext);

      await tracker.saveTopicWhiteboard(sessionId, {
        lessonId: 101,
        elements: [{ id: 'l101_formula', type: 'text', text: 'F = k * q1 * q2 / r^2' }],
      });

      // At t=600s, teacher opens old Lesson 99 ONLY FOR REFERENCE (`mode: 'reference_only'`)
      tracker.navigateCurriculum({
        sessionId,
        chapterId: 1,
        lessonId: 99,
        lessonNumber: '0.9',
        lessonTitle: 'Vector Algebra Prerequisite (Taught Last Week)',
        videoOffsetSec: 600,
        mode: 'reference_only',
      });

      // Even if a whiteboard auto-save triggers while Lesson 99 is open in reference_only mode,
      // it MUST be skipped so Lesson 99's existing whiteboard.json is untouched!
      const refSaveAttempt = await tracker.saveTopicWhiteboard(sessionId, {
        lessonId: 99,
        elements: [{ id: 'accidental_scratch', type: 'freedraw' }],
      });
      assert.equal(refSaveAttempt.saved, false);
      assert.equal(refSaveAttempt.skippedAsReferenceOnly, true);

      // At t=690s (90 seconds later), teacher navigates to new Lesson 102 and teaches it until t=1500s
      tracker.navigateCurriculum({
        sessionId,
        chapterId: 1,
        lessonId: 102,
        lessonNumber: '1.2',
        lessonTitle: 'Electric Field Intensity',
        videoOffsetSec: 690,
        mode: 'taught',
      });

      await tracker.saveTopicWhiteboard(sessionId, {
        lessonId: 102,
        elements: [{ id: 'l102_diagram', type: 'arrow', text: 'E = F / q' }],
      });

      // At t=1500s, teacher briefly clicks Lesson 103 for 45 seconds (1500s -> 1545s) WITHOUT drawing anything
      tracker.navigateCurriculum({
        sessionId,
        chapterId: 1,
        lessonId: 103,
        lessonNumber: '1.3',
        lessonTitle: 'Electric Dipole (Previewed Briefly)',
        videoOffsetSec: 1500,
      });

      // Finalize session at t=1545s
      const summary = await tracker.finalizeSession(sessionId, {
        totalDurationSec: 1545,
      });

      // Verify:
      // 1. Lesson 101 (0-600s) and Lesson 102 (690-1500s) are published as 'taught'
      const publishedLessonIds = summary.publishedLessonArtifacts.map(
        (a) => a.relationalContext.lessonId
      );
      assert.deepEqual(publishedLessonIds, [101, 102]);
      assert.equal(summary.publishedLessonArtifacts[0].videoStartOffsetSec, 0);
      assert.equal(summary.publishedLessonArtifacts[0].videoEndOffsetSec, 600);
      assert.equal(summary.publishedLessonArtifacts[1].videoStartOffsetSec, 690);
      assert.equal(summary.publishedLessonArtifacts[1].videoEndOffsetSec, 1500);

      // 2. Lesson 99 (explicit reference_only) and Lesson 103 (45s < 180s with no WB edits) are in skippedReferenceLessons
      const skippedLessonIds = summary.skippedReferenceLessons.map((s) => s.lessonId);
      assert.deepEqual(skippedLessonIds, [99, 103]);

      // 3. Old Lesson 99's existing whiteboard.json still has its original 'precious_old_diagram' intact!
      const preservedLesson99Wb = await storageProvider.getGzippedWhiteboard(oldLesson99WbKey);
      assert.ok(preservedLesson99Wb);
      assert.equal(preservedLesson99Wb?.artifact.elements.length, 1);
      assert.equal(preservedLesson99Wb?.artifact.elements[0].id, 'precious_old_diagram');
    });
  });

  describe('4. P0-1: Dynamic Host Teacher Resolution vs Invited Co-Teachers (Laravel & Mock IDs)', () => {
    it('authorizes real Laravel numeric Host Teachers (e.g. userId "42" or "5") for Whiteboard & Host actions while restricting unapproved Co-Teachers', async () => {
      const sessionId = `sess_host_teacher_tdd_${Date.now()}`;

      // 1. Real Laravel Host Teacher with numeric ID "42" (signed via JWT)
      const laravelHostTeacher = {
        userId: '42',
        name: 'Prof. Verma (Laravel Host)',
        role: 'teacher' as const,
        batchId: '105',
        sessionId,
      };

      const isLaravelHost = await AudioStageController.isHostTeacher(sessionId, laravelHostTeacher, '42');
      assert.equal(isLaravelHost, true, 'Real Laravel teacher matching session teacherId must be Host Teacher');

      const canLaravelHostEditWb = await AudioStageController.canUserEditWhiteboard(sessionId, laravelHostTeacher);
      assert.equal(canLaravelHostEditWb, true, 'Real Laravel Host Teacher must have full Whiteboard edit access');

      // 2. Demo Co-Teacher "teacher_502" joining without whiteboard grant -> must NOT be host and cannot edit WB
      const demoCoTeacher = {
        userId: 'teacher_502',
        name: 'Prof. R.K. Verma (Co-Teacher)',
        role: 'teacher' as const,
        batchId: '105',
        sessionId,
        isCoTeacher: true,
      };

      const isDemoCoHost = await AudioStageController.isHostTeacher(sessionId, demoCoTeacher, '42');
      assert.equal(isDemoCoHost, false, 'Co-Teacher teacher_502 must not be treated as Host Teacher');

      await AudioStageController.inviteCoTeacher(sessionId, {
        teacherId: 'teacher_502',
        name: demoCoTeacher.name,
        canUseWhiteboard: false,
      });

      const canCoTeacherEditBeforeGrant = await AudioStageController.canUserEditWhiteboard(sessionId, demoCoTeacher);
      assert.equal(canCoTeacherEditBeforeGrant, false, 'Co-Teacher with canUseWhiteboard=false must be blocked from Whiteboard');

      // 3. Host grants Whiteboard access to Co-Teacher -> now allowed
      await AudioStageController.setCoTeacherWhiteboardAccess(sessionId, 'teacher_502', true);
      const canCoTeacherEditAfterGrant = await AudioStageController.canUserEditWhiteboard(sessionId, demoCoTeacher);
      assert.equal(canCoTeacherEditAfterGrant, true, 'Co-Teacher with canUseWhiteboard=true must be allowed to edit Whiteboard');

      // 4. Course/Batch Teacher (e.g. userId "5333") joining a session whose fallback teacherId was "1"
      // must STILL be recognized as the Primary Host Teacher with full Whiteboard access
      const batchCourseTeacher = {
        userId: '5333',
        name: 'Course Batch Teacher',
        role: 'teacher' as const,
        batchId: '105',
        sessionId,
      };
      const isBatchTeacherHost = await AudioStageController.isHostTeacher(sessionId, batchCourseTeacher, '1');
      assert.equal(isBatchTeacherHost, true, 'Any non-cohost course/batch teacher must be recognized as Host Teacher even if fallback sessionTeacherId was 1');
      const canBatchTeacherEditWb = await AudioStageController.canUserEditWhiteboard(sessionId, batchCourseTeacher);
      assert.equal(canBatchTeacherEditWb, true, 'Course/batch teacher must always have Whiteboard edit access');
    });
  });

  describe('5. P0-3: AutoSaveService.executeGraceFinalize Finalizes VOD Recording & Gzipped Whiteboard Artifacts', () => {
    it('finalizes the continuous 720p video stream and persists gzipped whiteboard.json when teacher grace timer expires', async () => {
      const sessionId = `sess_grace_vod_tdd_${Date.now()}`;
      await RoomManager.getOrInitRoom(sessionId);

      // Teacher uploads a 720p video chunk and draws on Whiteboard before disconnecting
      const chunk0 = Buffer.from('__GRACE_EXPIRY_VIDEO_CHUNK_0__', 'utf-8');
      await storageProvider.appendVideoChunk(sessionId, chunk0, {
        chunkIndex: 0,
        mimeType: 'video/webm',
        relationalContext: {
          courseId: 12,
          chapterId: 3,
          lessonId: 301,
        },
      });
      getSessionTimelineTracker().recordVideoChunkUploaded(sessionId, 0, chunk0.length, {
        courseId: 12,
        chapterId: 3,
        lessonId: 301,
      });

      await WhiteboardEngine.syncElements(sessionId, [
        {
          id: 'grace_wb_el_1',
          type: 'rectangle',
          version: 2,
          versionNonce: 101,
          isDeleted: false,
          x: 20,
          y: 30,
          width: 120,
          height: 80,
        },
      ]);

      // Simulate 5-minute grace window expiry
      await AutoSaveService.executeGraceFinalize(sessionId);

      // Verify VOD video stream was finalized and gzipped whiteboard artifact was persisted
      const videoState = storageProvider.getSessionVideoState(sessionId);
      assert.equal(videoState.finalized, true, 'Session video recording must be finalized on grace expiry');

      const wbKey = StorageProvider.buildTopicWhiteboardKey({
        sessionId,
        courseId: 12,
        chapterId: 3,
        lessonId: 301,
      });
      const savedWb = await storageProvider.getGzippedWhiteboard(wbKey);
      assert.ok(savedWb, 'Gzipped whiteboard.json must be persisted on grace expiry');
      assert.equal(savedWb?.artifact.elements.length, 1);
      assert.equal(savedWb?.artifact.elements[0].id, 'grace_wb_el_1');
    });
  });

  describe('6. P1-1, P1-2 & P1-3: Default Secret Alignment, Laravel Token Envelope Unwrapping & Lesson Content Blocks Normalization', () => {
    it('aligns default JWT & internal secrets with Laravel and unwraps Laravel API envelopes for validateToken, getCurriculumSidebar & getLessonContent', async () => {
      // P1-1: Default JWT secret matches Laravel BroadcastJwtService ('zerix_broadcast_shared_jwt_secret_2026')
      const prevJwtSecret = process.env.BROADCAST_JWT_SECRET;
      const prevLegacyJwt = process.env.JWT_SECRET;
      delete process.env.BROADCAST_JWT_SECRET;
      delete process.env.JWT_SECRET;

      try {
        assert.equal(
          JwtVerifier.getSecret(),
          'zerix_broadcast_shared_jwt_secret_2026',
          'Default JWT secret must match Laravel BroadcastJwtService'
        );

        // Token signed by Laravel's default secret verifies out of the box
        const laravelToken = JwtVerifier.sign(
          {
            userId: '42',
            name: 'Dr. H.C. Verma',
            role: 'teacher',
            sessionId: 'sess_p1_align_1',
            batchId: 105,
            courseId: 12,
          },
          { secret: 'zerix_broadcast_shared_jwt_secret_2026' }
        );
        const verifiedLaravel = JwtVerifier.verify(laravelToken, {
          expectedSessionId: 'sess_p1_align_1',
        });
        assert.equal(verifiedLaravel.valid, true);
        assert.equal(verifiedLaravel.claims?.userId, '42');
      } finally {
        if (prevJwtSecret !== undefined) process.env.BROADCAST_JWT_SECRET = prevJwtSecret;
        if (prevLegacyJwt !== undefined) process.env.JWT_SECRET = prevLegacyJwt;
      }

      // P1-2 & P1-3: Mock Laravel HTTP Server returning BaseController { success: true, data: ... } envelopes
      let capturedInternalSecretHeader = '';
      const mockServer = http.createServer((req, res) => {
        capturedInternalSecretHeader = String(req.headers['x-internal-secret'] || '');
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'POST' && req.url === '/api/internal/broadcast/auth/verify-token') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            const parsed = JSON.parse(body || '{}');
            if (parsed.token === 'valid_laravel_opaque_token') {
              res.end(
                JSON.stringify({
                  success: true,
                  message: 'Classroom JWT verified',
                  data: {
                    valid: true,
                    claims: {
                      userId: '42',
                      name: 'Dr. H.C. Verma',
                      role: 'teacher',
                      batchId: 105,
                      sessionId: 'sess_p1_align_1',
                    },
                  },
                })
              );
            } else {
              res.statusCode = 401;
              res.end(JSON.stringify({ success: false, data: { valid: false } }));
            }
          });
          return;
        }

        if (req.method === 'GET' && req.url === '/api/internal/broadcast/courses/12/curriculum') {
          res.end(
            JSON.stringify({
              success: true,
              data: {
                courseId: 12,
                courseName: 'Master Live Physics',
                chapters: [
                  {
                    chapterId: 4,
                    chapterNumber: 1,
                    chapterTitle: 'Electrostatics',
                    lessons: [
                      {
                        lessonId: 19,
                        lessonNumber: '1.1',
                        lessonTitle: 'Coulomb Law',
                        topics: [
                          {
                            topicId: 301,
                            topicTitle: 'Vector Form of Coulomb Law',
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            })
          );
          return;
        }

        if (req.method === 'GET' && req.url === '/api/internal/broadcast/lessons/19/content') {
          res.end(
            JSON.stringify({
              success: true,
              data: {
                lessonId: 19,
                chapterId: 4,
                title: 'Coulomb Law & Superposition',
                description: 'Fundamental electrostatic force between point charges.',
                topics: [
                  {
                    topicId: 301,
                    title: 'Statement of Coulomb Law',
                    contentHtml: '<p>Force is directly proportional to product of charges.</p>',
                    files: [],
                  },
                  {
                    topicId: 302,
                    title: 'Permittivity of Free Space',
                    contentHtml: '<p>Value of epsilon naught in SI units.</p>',
                    files: [],
                  },
                ],
              },
            })
          );
          return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ success: false }));
      });

      await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
      const address = mockServer.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${address.port}`;

      try {
        const provider = new LaravelApiDataProvider(baseUrl);

        // Verify P1-2: unwraps { success: true, data: { valid: true, claims: ... } }
        const authUser = await provider.validateToken('valid_laravel_opaque_token', 'sess_p1_align_1');
        assert.ok(authUser, 'validateToken must unwrap Laravel data envelope and map claims/user');
        assert.equal(authUser?.userId, '42');
        assert.equal(authUser?.role, 'teacher');
        assert.equal(authUser?.sessionId, 'sess_p1_align_1');
        assert.equal(
          capturedInternalSecretHeader,
          'zerix_internal_broadcast_secret_2026',
          'Default X-Internal-Secret header must match Laravel BroadcastJwtService'
        );

        // Mismatched sessionId must be rejected
        const wrongSessionUser = await provider.validateToken('valid_laravel_opaque_token', 'other_session_999');
        assert.equal(wrongSessionUser, null, 'Mismatched sessionId must be rejected by validateToken');

        // Verify P1-3a: Curriculum normalizes chapterTitle/lessonTitle/topicTitle -> title and string IDs
        const curriculum = await provider.getCurriculumSidebar('12');
        assert.ok(curriculum);
        assert.equal(curriculum?.chapters[0].chapterId, '4');
        assert.equal(curriculum?.chapters[0].title, 'Electrostatics');
        assert.equal(curriculum?.chapters[0].lessons[0].lessonId, '19');
        assert.equal(curriculum?.chapters[0].lessons[0].title, 'Coulomb Law');
        assert.equal(curriculum?.chapters[0].lessons[0].topics[0].topicId, '301');
        assert.equal(curriculum?.chapters[0].lessons[0].topics[0].title, 'Vector Form of Coulomb Law');

        // Verify P1-3b: Lesson content transforms topics -> blocks for VirtualContentStage.tsx
        const lessonContent = await provider.getLessonContent('19');
        assert.ok(lessonContent);
        assert.equal(lessonContent?.lessonId, '19');
        assert.equal(lessonContent?.chapterId, '4');
        assert.equal(lessonContent?.lessonTitle, 'Coulomb Law & Superposition');
        assert.ok(Array.isArray(lessonContent?.blocks), 'lessonContent.blocks must be an array');
        assert.ok((lessonContent?.blocks.length || 0) >= 2, 'lessonContent.blocks must contain transformed topic blocks');
        assert.ok(lessonContent?.blocks[0].blockId);
        assert.ok(lessonContent?.blocks[0].content);
      } finally {
        await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      }
    });
  });

  // ==========================================================================
  // 7. P1-4: Reject 2-Part Base64 Forged Tokens, .mock_sig_* Bypasses & Production Dev Tokens
  // ==========================================================================
  describe('7. P1-4: LaravelApiDataProvider Rejects Forged Base64 Tokens & Production Dev Tokens', () => {
    it('rejects 2-part forged base64 tokens, .mock_sig_* forged JWTs, and dev tokens in production', async () => {
      const provider = new LaravelApiDataProvider('http://127.0.0.1:59999');

      // 1. Forged 2-part token (header.payload without cryptographic signature)
      const forgedPayload = Buffer.from(
        JSON.stringify({ sub: 'teacher_501', name: 'Attacker', role: 'teacher' })
      ).toString('base64url');
      const twoPartForged = `eyJhbGciOiJIUzI1NiJ9.${forgedPayload}`;
      const twoPartResult = await provider.validateToken(twoPartForged, 'batch_physics_101');
      assert.equal(twoPartResult, null, '2-part base64 token without HMAC signature must be rejected');

      // 2. Forged 3-part token using legacy .mock_sig_teacher_101 suffix
      const threePartMockSigForged = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${forgedPayload}.mock_sig_teacher_101`;
      const threePartMockSigResult = await provider.validateToken(
        threePartMockSigForged,
        'batch_physics_101'
      );
      assert.equal(
        threePartMockSigResult,
        null,
        '3-part forged token with .mock_sig_teacher_101 suffix must be rejected'
      );

      // 3. Static DEV_TOKEN_* strings must always be rejected
      const prodDevTokenResult = await provider.validateToken(
        'DEV_TOKEN_TEACHER_501',
        'batch_physics_101'
      );
      assert.equal(
        prodDevTokenResult,
        null,
        'DEV_TOKEN_TEACHER_501 must be rejected'
      );
    });
  });

  // ==========================================================================
  // 8. P1-5: Video Chunk Out-of-Order OOM Protection, 4KB In-Place EBML Header Patch & Whiteboard Mutex
  // ==========================================================================
  describe('8. P1-5: Out-of-Order Video Chunk Cap, In-Place 4KB EBML Patching & Whiteboard Mutex', () => {
    it('caps out-of-order pendingChunks to prevent OOM DoS, patches WebM duration in-place via 4KB fd, and serializes concurrent WhiteboardEngine.syncElements', async () => {
      const oomSessionId = `sess_oom_guard_${Date.now()}`;

      // 1. Huge out-of-order chunkIndex gap (e.g. chunkIndex 999999 when expecting 0) must be rejected immediately
      await assert.rejects(
        async () => {
          await storageProvider.appendVideoChunk(oomSessionId, Buffer.from('malicious_chunk'), {
            chunkIndex: 999999,
          });
        },
        /Out-of-order video chunk/i,
        'Excessive out-of-order chunkIndex gap must be rejected to prevent OOM DoS'
      );

      // 2. In-place 4KB file-descriptor WebM EBML header patching without reading full file into RAM
      assert.equal(
        typeof (StorageProvider as any).patchWebmDurationHeaderInPlace,
        'function',
        'StorageProvider.patchWebmDurationHeaderInPlace must be implemented'
      );

      const inPlaceSessionId = `sess_inplace_webm_${Date.now()}`;
      const headerChunk = Buffer.alloc(64, 0x1a);
      headerChunk[10] = 0x44;
      headerChunk[11] = 0x89;
      headerChunk[12] = 0x88;
      headerChunk.writeDoubleBE(0.0, 13);

      await storageProvider.appendVideoChunk(inPlaceSessionId, headerChunk, { chunkIndex: 0 });
      await storageProvider.appendVideoChunk(
        inPlaceSessionId,
        Buffer.alloc(8192, 0x55),
        { chunkIndex: 1 }
      );

      const finalized = await storageProvider.finalizeVideoRecording(
        inPlaceSessionId,
        { sessionId: inPlaceSessionId, courseId: 12, chapterId: 3, lessonId: 42 },
        { durationSec: 125 }
      );
      const patchedHeaderSlice = Buffer.alloc(32);
      const fd = await fs.promises.open(finalized.cachePath, 'r');
      try {
        await fd.read(patchedHeaderSlice, 0, 32, 0);
      } finally {
        await fd.close();
      }
      assert.equal(
        patchedHeaderSlice.readDoubleBE(13),
        125000,
        'WebM EBML float64 duration must be patched in-place to 125000ms'
      );

      // 3. Concurrent WhiteboardEngine.syncElements on the same element ID must serialize without clobbering
      const { WhiteboardEngine } = await import('../../src/modules/whiteboard/whiteboard.engine');
      const wbSessionId = `sess_wb_mutex_${Date.now()}`;
      await WhiteboardEngine.clearElements(wbSessionId);

      await Promise.all([
        WhiteboardEngine.syncElements(wbSessionId, [
          { id: 'shared_el_1', type: 'rectangle', version: 1, versionNonce: 101, x: 10, y: 10 },
        ]),
        WhiteboardEngine.syncElements(wbSessionId, [
          { id: 'shared_el_1', type: 'rectangle', version: 1, versionNonce: 202, x: 50, y: 50 },
        ]),
      ]);

      const syncedElements = await WhiteboardEngine.getAllElements(wbSessionId);
      const targetEl = syncedElements.find((e) => e.id === 'shared_el_1');
      assert.ok(targetEl, 'Element must exist after concurrent syncElements');
      assert.ok(
        targetEl.version >= 2,
        'Serialized concurrent same-version updates must increment version to >= 2 without TOCTOU race'
      );
    });
  });

  // ==========================================================================
  // 9. P2-1: StorageProvider Path Traversal Hardening Against Encoded & Relative Traversal
  // ==========================================================================
  describe('9. P2-1: StorageProvider Path Traversal Hardening Against Encoded & Relative Traversal', () => {
    it('prevents URL-encoded %2e%2e, backslash, and relative ../ traversal payloads in resolveCachePath and getPublicUrl', () => {
      const cacheDir = path.resolve(storageProvider.getConfig().cacheDir);
      const resolvedPath = path.resolve(
        storageProvider.resolveCachePath('%2e%2e/%2e%2e/....//etc/passwd')
      );

      assert.equal(
        resolvedPath.startsWith(cacheDir + path.sep),
        true,
        `Resolved path "${resolvedPath}" must remain strictly inside cacheDir "${cacheDir}"`
      );
      assert.equal(
        resolvedPath.includes('..') || /%2e/i.test(resolvedPath),
        false,
        'Resolved cache path must not contain any raw or URL-encoded parent directory traversal segments'
      );

      const publicUrl = storageProvider.getPublicUrl('../../../etc/passwd');
      assert.equal(
        publicUrl.includes('..'),
        false,
        `getPublicUrl("${publicUrl}") must sanitize parent traversal segments`
      );
    });
  });

  // ==========================================================================
  // 10. Goal Deliverables: Comic Sans Default Font, Single-Device Join Enforcement & Independent Device Mics
  // ==========================================================================
  describe('10. Goal Deliverables: Comic Sans Injected Text, Single-Device Student Join Enforcement & Independent Device Mics', () => {
    it('sets Comic Sans (fontFamily: 5) on injected whiteboard text blocks', async () => {
      const sessionId = `sess_comic_sans_${Date.now()}`;
      const elements = await WhiteboardEngine.injectContentBlockAsExcalidraw(sessionId, {
        blockId: 'blk_comic_1',
        title: 'Ohm Law',
        content: 'V = I * R',
        type: 'concept',
      });
      const textEl = elements.find((e) => e.type === 'text');
      assert.ok(textEl, 'Injected elements must include a text element');
      assert.equal(
        textEl.fontFamily,
        5,
        'Default whiteboard injected text fontFamily must be 5 (Comic Sans)'
      );
    });

    it('enforces single-device join per student by default and allows multi-device when enabled by Host Teacher', async () => {
      const sessionId = `sess_single_dev_${Date.now()}`;

      // 1. First device (dev_phone_1) joins for student_101 -> allowed
      const firstJoin = await (AudioStageController as any).canStudentDeviceJoin(
        sessionId,
        'student_101',
        'dev_phone_1',
        'sock_1'
      );
      assert.equal(firstJoin.allowed, true, 'First device for student_101 must be allowed');

      // 2. Same device (dev_phone_1) reconnects -> allowed
      const sameDeviceRejoin = await (AudioStageController as any).canStudentDeviceJoin(
        sessionId,
        'student_101',
        'dev_phone_1',
        'sock_1b'
      );
      assert.equal(sameDeviceRejoin.allowed, true, 'Reconnecting from the same deviceId must be allowed');

      // 3. Second device (dev_tablet_2) tries to join for student_101 -> blocked!
      const secondDeviceJoin = await (AudioStageController as any).canStudentDeviceJoin(
        sessionId,
        'student_101',
        'dev_tablet_2',
        'sock_2'
      );
      assert.equal(
        secondDeviceJoin.allowed,
        false,
        'Second device for student_101 must be blocked by default'
      );
      assert.equal(secondDeviceJoin.activeDeviceId, 'dev_phone_1');

      // 4. Host Teacher enables multi-device access for student_101
      const multiList = await (AudioStageController as any).setStudentMultiDeviceAccess(
        sessionId,
        'student_101',
        true
      );
      assert.ok(
        multiList.includes('student_101'),
        'multiDeviceStudents list must include student_101 after Host enables it'
      );

      // 5. Now second device (dev_tablet_2) for student_101 is allowed!
      const secondDeviceAfterGrant = await (AudioStageController as any).canStudentDeviceJoin(
        sessionId,
        'student_101',
        'dev_tablet_2',
        'sock_2'
      );
      assert.equal(
        secondDeviceAfterGrant.allowed,
        true,
        'Second device for student_101 must be allowed after Host enables multi-device access'
      );
      assert.equal(secondDeviceAfterGrant.allowMultiDevice, true);

      // 6. Other students (student_102) remain restricted to 1 device
      await (AudioStageController as any).canStudentDeviceJoin(
        sessionId,
        'student_102',
        'dev_s102_a',
        'sock_3'
      );
      const otherStudentSecondDev = await (AudioStageController as any).canStudentDeviceJoin(
        sessionId,
        'student_102',
        'dev_s102_b',
        'sock_4'
      );
      assert.equal(
        otherStudentSecondDev.allowed,
        false,
        'student_102 must remain single-device restricted'
      );
    });

    it('mints distinct per-device LiveKit identities and isolates per-device mic mute state', async () => {
      const sessionId = `sess_indep_mic_${Date.now()}`;
      await (AudioStageController as any).setStudentMultiDeviceAccess(sessionId, 'student_101', true);
      await (AudioStageController as any).canStudentDeviceJoin(
        sessionId,
        'student_101',
        'dev_A',
        'sock_A'
      );
      await (AudioStageController as any).canStudentDeviceJoin(
        sessionId,
        'student_101',
        'dev_B',
        'sock_B'
      );

      // 1. Verify getJoinToken produces distinct LiveKit participant identities per device
      const tokenA = await AudioStageController.getJoinToken(
        sessionId,
        'student_101',
        'Rahul Verma',
        'student',
        true,
        'dev_A'
      );
      const tokenB = await AudioStageController.getJoinToken(
        sessionId,
        'student_101',
        'Rahul Verma',
        'student',
        true,
        'dev_B'
      );
      const payloadA = JSON.parse(
        Buffer.from(tokenA.token.split('.')[1], 'base64url').toString('utf8')
      );
      const payloadB = JSON.parse(
        Buffer.from(tokenB.token.split('.')[1], 'base64url').toString('utf8')
      );
      assert.equal(payloadA.sub, 'student_101__dev_A');
      assert.equal(payloadB.sub, 'student_101__dev_B');

      // 2. Grant mic to student_101 -> returns per-device tokens for both dev_A and dev_B
      const grantRes = await AudioStageController.grantStudentMic(sessionId, 'student_101', false);
      assert.equal(grantRes.success, true);
      assert.ok(
        (grantRes as any).deviceTokens?.dev_A && (grantRes as any).deviceTokens?.dev_B,
        'grantStudentMic must return distinct deviceTokens for all active devices of student_101'
      );

      // 3. Both dev_A and dev_B turn on their mics
      await (AudioStageController as any).setStudentDeviceMicState(
        sessionId,
        'student_101',
        'dev_A',
        true
      );
      await (AudioStageController as any).setStudentDeviceMicState(
        sessionId,
        'student_101',
        'dev_B',
        true
      );

      // 4. Student mutes ONLY dev_A -> dev_B must remain active and student_101 stays in activeStudentMics!
      const muteDevARes = await (AudioStageController as any).muteStudentDevice(
        sessionId,
        'student_101',
        'dev_A'
      );
      assert.equal(muteDevARes.anyDeviceMicActive, true, 'dev_B is still unmuted so anyDeviceMicActive must be true');
      const activeMicsAfterDevAMute = await AudioStageController.getActiveStudentMics(sessionId);
      assert.ok(
        activeMicsAfterDevAMute.includes('student_101'),
        'student_101 must remain in activeStudentMics while dev_B is still unmuted'
      );

      // 5. Now student also mutes dev_B -> anyDeviceMicActive becomes false
      const muteDevBRes = await (AudioStageController as any).muteStudentDevice(
        sessionId,
        'student_101',
        'dev_B'
      );
      assert.equal(muteDevBRes.anyDeviceMicActive, false, 'Both devices muted -> anyDeviceMicActive must be false');
    });
  });

  // ==========================================================================
  // 11. Non-Blocking Telegram Error Alerts, Service Watchdog & 11:00 PM Daily Health Report
  // ==========================================================================
  describe('11. Non-Blocking Telegram Error Alerts, Service Watchdog & 11:00 PM Daily Health Report', () => {
    it('sends messages via common sendTelegramMessage, dispatches non-blocking background error alerts with deduplication, and triggers daily report at 23:00 IST', async () => {
      const {
        TelegramMonitorService,
        sendTelegramMessage,
        notifyTelegramErrorAsync,
      } = await import('../../src/modules/monitoring/telegram.service');
      const { redis } = await import('../../src/config/redis');

      const capturedPayloads: Array<{ url: string; payload: Record<string, any> }> = [];
      TelegramMonitorService.clearDedupeCache();
      TelegramMonitorService.setTransport(async (url, payload) => {
        capturedPayloads.push({ url, payload });
        return {
          ok: true,
          status: 200,
          data: { ok: true, result: { message_id: 9000 + capturedPayloads.length } },
        };
      });

      try {
        // 1. Common sendTelegramMessage function
        const res1 = await sendTelegramMessage('<b>Test Common Function</b>', {
          parseMode: 'HTML',
        });
        assert.equal(res1.ok, true);
        assert.equal(capturedPayloads.length, 1);
        assert.equal(capturedPayloads[0].payload.chat_id, '-5264089817');
        assert.ok(capturedPayloads[0].url.includes('8624790281:'));

        // 2. Non-blocking notifyTelegramErrorAsync + deduplication cooldown
        notifyTelegramErrorAsync({
          source: 'Fastify HTTP Server',
          error: new Error('Database timeout in test'),
          context: { method: 'POST', url: '/api/v1/sessions/init', statusCode: 500 },
          dedupeKey: 'test_dedupe_err_1',
          cooldownMs: 60_000,
        });
        // Duplicate error immediately after should be suppressed by cooldown
        notifyTelegramErrorAsync({
          source: 'Fastify HTTP Server',
          error: new Error('Database timeout in test'),
          context: { method: 'POST', url: '/api/v1/sessions/init', statusCode: 500 },
          dedupeKey: 'test_dedupe_err_1',
          cooldownMs: 60_000,
        });

        await new Promise((r) => setTimeout(r, 40));
        assert.equal(
          capturedPayloads.length,
          2,
          'Duplicate error within cooldown window must be suppressed'
        );
        assert.ok(
          capturedPayloads[1].payload.text.includes('BROADCAST ERROR ALERT'),
          'Error alert must include BROADCAST ERROR ALERT header'
        );
        assert.ok(
          capturedPayloads[1].payload.text.includes('Database timeout in test'),
          'Error alert must include error message'
        );

        // 3. Daily 11:00 PM (23:00 IST) schedule evaluation
        // 2030-05-15T17:29:00.000Z is 22:59 IST -> should NOT trigger
        const at2259Ist = new Date('2030-05-15T17:29:00.000Z');
        const triggeredBefore = await TelegramMonitorService.evaluateDailyReportSchedule(at2259Ist);
        assert.equal(triggeredBefore, false, 'Must not trigger daily report at 22:59 IST');

        // 2030-05-15T17:30:00.000Z is 23:00 IST (11:00 PM IST) -> MUST trigger once
        await redis.del('monitor:daily_health_report:2030-05-15');
        const at2300Ist = new Date('2030-05-15T17:30:00.000Z');
        const triggeredAt11Pm = await TelegramMonitorService.evaluateDailyReportSchedule(at2300Ist);
        assert.equal(triggeredAt11Pm, true, 'Must trigger daily health report at 23:00 (11:00 PM) IST');

        // Second evaluation in the same 23:00 IST minute must not duplicate
        const triggeredAgainSameDay = await TelegramMonitorService.evaluateDailyReportSchedule(
          at2300Ist
        );
        assert.equal(
          triggeredAgainSameDay,
          false,
          'Must not send duplicate 11:00 PM report on the same calendar date'
        );
        await redis.del('monitor:daily_health_report:2030-05-15');
      } finally {
        TelegramMonitorService.setTransport(null);
        TelegramMonitorService.clearDedupeCache();
      }
    });
  });

  // ==========================================================================
  // 14. Course/Batch Teacher Host Resolution vs Explicit Co-Host Invite
  // ==========================================================================
  describe('14. Course/Batch Teacher Host Resolution vs Explicit Co-Host Invite', () => {
    it('recognizes any course/batch teacher as Host Teacher (with full whiteboard & content control) unless explicitly invited as a Co-Teacher', async () => {
      const hostSessionId = `sess_host_teacher_${Date.now()}`;

      // Even if a stale invited_teachers entry exists in Redis or sessionTeacherId defaulted to '1',
      // a regular course/batch teacher (e.g. userId = '5333', role = 'teacher') MUST be Host Teacher.
      await AudioStageController.inviteCoTeacher(hostSessionId, {
        teacherId: '5333',
        teacherName: 'Dr. Ramesh Kumar',
        canUseWhiteboard: false,
        isMuted: false,
        invitedAt: Date.now(),
        isOnline: true,
      });

      const courseTeacher = {
        userId: '5333',
        name: 'Dr. Ramesh Kumar',
        role: 'teacher' as const,
        sessionId: hostSessionId,
      };

      assert.equal(
        AudioStageController.isExplicitCoTeacher(courseTeacher),
        false,
        'Course/batch teacher without explicit Co-Host invite flags must NOT be treated as Co-Teacher'
      );

      const isHost = await AudioStageController.isHostTeacher(hostSessionId, courseTeacher, '1');
      assert.equal(
        isHost,
        true,
        'Course/batch teacher must be recognized as Host Teacher even if sessionTeacherId defaulted to 1'
      );

      // Explicit Co-Teacher invite (?cohost=1 / isCoTeacher: true) must be recognized as Co-Teacher, not Host
      const invitedCoTeacher = {
        userId: '8899',
        name: 'Co-Host Faculty',
        role: 'teacher' as const,
        sessionId: hostSessionId,
        isCoTeacher: true,
        isCoHostInvite: true,
      };
      assert.equal(
        AudioStageController.isExplicitCoTeacher(invitedCoTeacher),
        true,
        'Teacher with isCoTeacher/isCoHostInvite flag must be recognized as explicit Co-Teacher'
      );
      const isCoTeacherHost = await AudioStageController.isHostTeacher(
        hostSessionId,
        invitedCoTeacher,
        '5333'
      );
      assert.equal(
        isCoTeacherHost,
        false,
        'Explicit Co-Teacher must not override the Host Teacher'
      );
    });
  });

  // ==========================================================================
  // 15. Student Mic Grant Persistence Across Self-Mute/Unmute & Session/Course/Language Recording Storage
  // ==========================================================================
  describe('15. Student Mic Grant Persistence & Session/Course/Language Recording Storage', () => {
    it('preserves teacher mic grant across student self-mute/unmute cycles until teacher explicitly revokes', async () => {
      const micSessionId = `sess_student_mic_${Date.now()}`;
      const studentNumericId = '7042';
      const studentIdentity = 'student_7042';

      // Initially student does not have mic permission (allowStudentUnmute defaults to false)
      await AudioStageController.setAllowStudentUnmute(micSessionId, false);
      assert.equal(
        await AudioStageController.hasStudentMicPermission(micSessionId, studentNumericId),
        false
      );

      // 1. Teacher grants student mic using normalized identity (`student_7042`)
      await AudioStageController.grantStudentMic(micSessionId, studentIdentity);
      assert.equal(
        await AudioStageController.hasStudentMicPermission(micSessionId, studentNumericId),
        true,
        'Student with numeric userId must be recognized as having mic permission after teacher grant'
      );
      assert.equal(
        await AudioStageController.hasStudentMicPermission(micSessionId, studentIdentity),
        true
      );

      // 2. Student self-mutes (or client emits initial micActive: false state sync) via muteStudentDevice
      await AudioStageController.muteStudentDevice(micSessionId, studentIdentity);
      const activeMicsAfterSelfMute = await AudioStageController.getActiveStudentMics(micSessionId);
      assert.equal(
        activeMicsAfterSelfMute.includes(studentIdentity),
        false,
        'Active speaking badge set should clear when student self-mutes'
      );
      assert.equal(
        await AudioStageController.hasStudentMicPermission(micSessionId, studentNumericId),
        true,
        'Teacher mic grant MUST persist in granted_student_mics so student can unmute again without auto-muting'
      );

      // 3. Teacher explicitly revokes student mic via muteStudent -> permission is removed
      await AudioStageController.muteStudent(micSessionId, studentIdentity);
      assert.equal(
        await AudioStageController.hasStudentMicPermission(micSessionId, studentNumericId),
        false,
        'Teacher explicit muteStudent must revoke student mic permission'
      );
    });

    it('stores session recordings by Session, Course, and Language only when chapter/lesson/topic are omitted', async () => {
      const recSessionId = `sess_course_lang_${Date.now()}`;
      const sessionOnlyCtx = {
        sessionId: recSessionId,
        courseId: 15,
        languageId: 'en',
      };

      const expectedKey = StorageProvider.buildSessionCourseLanguageVideoKey(sessionOnlyCtx, 'webm');
      assert.equal(
        expectedKey,
        `sessions/session_${recSessionId}/course_15/lang_en/video_720p.webm`
      );

      const chunk0 = Buffer.alloc(32, 0x1a);
      chunk0[10] = 0x44;
      chunk0[11] = 0x89;
      chunk0[12] = 0x88;
      chunk0.writeDoubleBE(0.0, 13);

      const appendRes = await storageProvider.appendVideoChunk(recSessionId, chunk0, {
        chunkIndex: 0,
        relationalContext: sessionOnlyCtx,
      });
      assert.equal(appendRes.videoKey, expectedKey);

      const finalized = await storageProvider.finalizeVideoRecording(recSessionId, sessionOnlyCtx, {
        durationSec: 12,
      });
      assert.equal(finalized.key, expectedKey);
      assert.equal(finalized.totalBytes, chunk0.length);
    });
  });
});
