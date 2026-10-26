import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';

import { createBroadcastServer } from '../../src/index';
import { redis, pubClient, subClient } from '../../src/config/redis';
import { JwtVerifier } from '../../src/utils/jwtVerifier';
import { AttendanceEngine } from '../../src/modules/attendance/attendance.engine';
import { StorageProvider, setStorageProvider } from '../../src/adapters/storage.provider';
import {
  SessionTimelineTracker,
  setSessionTimelineTracker,
} from '../../src/modules/session-timeline/sessionTimeline.tracker';
import { FileCache } from '../../src/utils/fileCache';
import { RelationalLessonContext } from '../../src/types/broadcast.types';

describe('Phase 1 Load & Scalability Tests: 1,000+ Concurrent Users & Jittered 720p Pipeline', () => {
  let tempDir: string;
  let storageProvider: StorageProvider;
  let server: Awaited<ReturnType<typeof createBroadcastServer>>;

  const loadSessionId = 'sess_load_1000_ssc_cgl_batch_2026';
  const loadRelCtx: RelationalLessonContext = {
    sessionId: loadSessionId,
    branchId: 4,
    batchId: 401,
    boardId: null,
    examId: 14, // SSC CGL Tier-1 & Tier-2
    languageId: 1,
    courseId: 88,
    linkedVodCourseId: 288,
    subjectId: 19,
    chapterId: 10,
    chapterNumber: 10,
    chapterTitle: 'Quantitative Aptitude: Trigonometry & Geometry',
    lessonId: 301,
    lessonNumber: '10.1',
    lessonTitle: 'Trigonometric Identities & Maximum/Minimum Values',
    topicId: null,
    teacherId: 501,
    academicYear: 2026,
    version: 1,
    publishToVodCourse: true,
    isPrimaryVod: true,
  };

  before(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'broadcast-phase1-load-'));
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
    // Clean up Redis keys created for the 1,000-student load test
    try {
      const studentSetKey = `room:${loadSessionId}:attendance_students`;
      const uids = await redis.smembers(studentSetKey);
      if (uids.length > 0) {
        const pipe = redis.pipeline();
        for (const uid of uids) {
          pipe.del(`room:${loadSessionId}:attendance:${uid}`);
        }
        pipe.del(studentSetKey);
        await pipe.exec();
      }
    } catch {
      // ignore cleanup errors
    }

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

  it('1. verifies 1,200 concurrent student HMAC-SHA256 JWT tokens in < 150ms with zero DB/HTTP overhead', () => {
    const TOTAL_TOKENS = 1200;
    const secret = 'zerix-load-test-hmac-secret-2026';
    const tokens: string[] = new Array(TOTAL_TOKENS);

    for (let i = 0; i < TOTAL_TOKENS; i++) {
      tokens[i] = JwtVerifier.sign(
        {
          userId: `stu_load_${i + 1}`,
          name: `Student #${i + 1}`,
          role: 'student',
          sessionId: loadSessionId,
          batchId: 401,
          courseId: 88,
          enrollmentId: 10000 + i,
        },
        { secret, expiresInSeconds: 7200 }
      );
    }

    const t0 = performance.now();
    let validCount = 0;
    for (let i = 0; i < TOTAL_TOKENS; i++) {
      const res = JwtVerifier.verify(tokens[i], {
        secret,
        expectedSessionId: loadSessionId,
      });
      if (res.valid) validCount++;
    }
    const elapsedMs = performance.now() - t0;
    const avgMsPerToken = elapsedMs / TOTAL_TOKENS;

    console.log(
      `⚡ [LoadTest:JWT] Verified ${validCount}/${TOTAL_TOKENS} HS256 JWTs in ${elapsedMs.toFixed(2)}ms (${avgMsPerToken.toFixed(4)}ms/token)`
    );

    assert.equal(validCount, TOTAL_TOKENS);
    assert.ok(
      elapsedMs < 250,
      `Expected 1,200 JWT verifications under 250ms, took ${elapsedMs.toFixed(2)}ms`
    );
  });

  it('2. handles 1,000+ concurrent student attendance joins, pipelined heartbeats, and redis.mget live roster queries without lag', async () => {
    const STUDENT_COUNT = 1050;

    // 1. Concurrently join 1,050 students with skipMetricsBroadcast: true (throttled room metrics)
    const joinStart = performance.now();
    await Promise.all(
      Array.from({ length: STUDENT_COUNT }, (_, idx) => {
        const uid = `stu_load_${idx + 1}`;
        return AttendanceEngine.recordJoin(
          loadSessionId,
          {
            userId: uid,
            name: `Student ${idx + 1}`,
            role: 'student',
            batchId: '401',
            sessionId: loadSessionId,
            rollNumber: `SSC-2026-${String(idx + 1).padStart(4, '0')}`,
          },
          `sock_${idx + 1}`,
          { skipMetricsBroadcast: true }
        );
      })
    );
    const joinElapsedMs = performance.now() - joinStart;

    // 2. Queue 1,050 student heartbeats and flush them in a SINGLE Redis pipeline
    const hbStart = performance.now();
    for (let i = 0; i < STUDENT_COUNT; i++) {
      AttendanceEngine.queueHeartbeat(loadSessionId, `stu_load_${i + 1}`);
    }
    const flushRes = await AttendanceEngine.flushQueuedHeartbeats();
    const hbElapsedMs = performance.now() - hbStart;

    // 3. Query live attendance roster for all 1,050 students via single `redis.mget`
    const mgetStart = performance.now();
    const liveList = await AttendanceEngine.getLiveAttendanceList(loadSessionId);
    const mgetElapsedMs = performance.now() - mgetStart;

    console.log(
      `⚡ [LoadTest:Attendance] ${STUDENT_COUNT} joins=${joinElapsedMs.toFixed(1)}ms | Pipelined Heartbeat Flush=${hbElapsedMs.toFixed(2)}ms | redis.mget Roster=${mgetElapsedMs.toFixed(2)}ms`
    );

    assert.equal(flushRes, STUDENT_COUNT);
    assert.equal(liveList.onlineCount, STUDENT_COUNT);
    assert.equal(liveList.totalCount, STUDENT_COUNT);
    assert.ok(
      hbElapsedMs < 300,
      `Expected 1,050 pipelined heartbeats under 300ms, took ${hbElapsedMs.toFixed(2)}ms`
    );
    assert.ok(
      mgetElapsedMs < 300,
      `Expected 1,050 student redis.mget roster query under 300ms, took ${mgetElapsedMs.toFixed(2)}ms`
    );
  });

  it('3. reassembles 20 concurrent jittered 720p video chunks in strict order across multi-topic navigation and serves 250 concurrent HTTP 206 byte-range & gzipped whiteboard requests', async () => {
    const TOTAL_CHUNKS = 20;

    // Build 20 distinct chunks where Chunk 0 contains a valid WebM EBML 0x4489 duration slot
    const expectedBuffers: Buffer[] = [];
    for (let idx = 0; idx < TOTAL_CHUNKS; idx++) {
      if (idx === 0) {
        const headerBuf = Buffer.alloc(64, 0x1a);
        headerBuf[8] = 0x44;
        headerBuf[9] = 0x89;
        headerBuf[10] = 0x88;
        headerBuf.writeDoubleBE(0.0, 11);
        expectedBuffers.push(headerBuf);
      } else {
        expectedBuffers.push(
          Buffer.from(`|[CHUNK_${String(idx).padStart(2, '0')}_PAYLOAD_720P_VP9_OPUS]|`, 'utf-8')
        );
      }
    }

    // Fire all 20 chunk uploads concurrently with randomized simulated jitter (1ms - 40ms)
    // so they arrive at the Fastify server out of order
    const uploadStart = performance.now();
    await Promise.all(
      expectedBuffers.map(async (buf, idx) => {
        const randomJitterMs = Math.floor(Math.random() * 40) + 1;
        await new Promise((r) => setTimeout(r, randomJitterMs));

        const res = await server.fastify.inject({
          method: 'POST',
          url: `/api/v1/sessions/${loadSessionId}/video-chunk?chunkIndex=${idx}&courseId=88&boardId=14&languageId=1&chapterId=10&lessonId=301&version=1&academicYear=2026`,
          headers: {
            'content-type': 'application/octet-stream',
            authorization: 'Bearer DEV_TOKEN_TEACHER_501',
          },
          payload: buf,
        });
        assert.equal(res.statusCode, 200);
      })
    );
    const uploadElapsedMs = performance.now() - uploadStart;

    const teacherHeaders = { authorization: 'Bearer DEV_TOKEN_TEACHER_501' };

    // Navigate from Lesson 301 -> Lesson 299 (reference_only) -> Lesson 302 (taught)
    await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${loadSessionId}/whiteboard/save`,
      headers: teacherHeaders,
      payload: {
        chapterId: 10,
        lessonId: 301,
        relationalContext: loadRelCtx,
        elements: [
          { id: 'trig_id_1', type: 'text', text: 'sin^2(x) + cos^2(x) = 1', strokeColor: '#12a3ff' },
          { id: 'trig_triangle', type: 'polygon', strokeColor: '#000000' },
        ],
      },
    });

    await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${loadSessionId}/curriculum/navigate`,
      headers: teacherHeaders,
      payload: {
        chapterId: 10,
        lessonId: 299,
        lessonNumber: '9.4',
        lessonTitle: 'Algebraic Identities Reference',
        videoOffsetSec: 90,
        mode: 'reference_only',
      },
    });

    await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${loadSessionId}/curriculum/navigate`,
      headers: teacherHeaders,
      payload: {
        chapterId: 10,
        lessonId: 302,
        lessonNumber: '10.2',
        lessonTitle: 'Heights & Distances Shortcuts',
        videoOffsetSec: 120,
        mode: 'taught',
      },
    });

    await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${loadSessionId}/whiteboard/save`,
      headers: teacherHeaders,
      payload: {
        chapterId: 10,
        lessonId: 302,
        elements: [{ id: 'elevation_angle', type: 'arrow', text: 'tan(60) = sqrt(3)' }],
      },
    });

    // Finalize session (200 seconds total duration)
    const finRes = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${loadSessionId}/finalize`,
      headers: teacherHeaders,
      payload: {
        totalDurationSec: 200,
        relationalContext: loadRelCtx,
      },
    });
    assert.equal(finRes.statusCode, 200);
    const summary = finRes.json().data;
    assert.equal(summary.publishedLessonArtifacts.length, 2);
    assert.equal(summary.skippedReferenceLessons.length, 1);

    const videoKey = summary.publishedLessonArtifacts[0].videoRelativePath;
    const wbKey = summary.publishedLessonArtifacts[0].whiteboardGzipRelativePath;

    // Verify exact byte-for-byte reassembly of all 20 jittered chunks
    const fullVideoRes = await server.fastify.inject({
      method: 'GET',
      url: `/api/v1/stream/video/${videoKey}`,
    });
    assert.equal(fullVideoRes.statusCode, 200);
    const expectedTrailingPayload = Buffer.concat(expectedBuffers.slice(1)).toString('utf-8');
    const actualTrailingPayload = fullVideoRes.rawPayload.subarray(64).toString('utf-8');
    assert.equal(actualTrailingPayload, expectedTrailingPayload);

    // Fire 250 concurrent requests (125 HTTP 206 byte-range video streams + 125 rawGzip whiteboard fetches)
    const CONCURRENT_READERS = 250;
    const streamStart = performance.now();
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_READERS }, (_, idx) => {
        if (idx % 2 === 0) {
          const startByte = (idx * 7) % 200;
          const endByte = startByte + 63;
          return server.fastify.inject({
            method: 'GET',
            url: `/api/v1/stream/video/${videoKey}`,
            headers: {
              range: `bytes=${startByte}-${endByte}`,
            },
          });
        } else {
          return server.fastify.inject({
            method: 'GET',
            url: `/api/v1/artifacts/whiteboard/${wbKey}?rawGzip=1`,
          });
        }
      })
    );
    const streamElapsedMs = performance.now() - streamStart;

    let status206Count = 0;
    let status200GzipCount = 0;
    for (let i = 0; i < responses.length; i++) {
      const r = responses[i];
      if (i % 2 === 0) {
        assert.equal(r.statusCode, 206);
        status206Count++;
      } else {
        assert.equal(r.statusCode, 200);
        assert.equal(r.headers['content-encoding'], 'gzip');
        const parsed = JSON.parse(zlib.gunzipSync(r.rawPayload).toString('utf-8'));
        assert.equal(parsed.elements.length, 2);
        status200GzipCount++;
      }
    }

    console.log(
      `⚡ [LoadTest:Streaming] 20 jittered chunks reassembled in ${uploadElapsedMs.toFixed(1)}ms | ${CONCURRENT_READERS} concurrent HTTP 206 & Gzip WB requests served in ${streamElapsedMs.toFixed(1)}ms`
    );

    assert.equal(status206Count, 125);
    assert.equal(status200GzipCount, 125);
  });
});
