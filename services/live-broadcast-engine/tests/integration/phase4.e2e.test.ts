import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { createBroadcastServer } from '../../src/index';
import { redis, pubClient, subClient } from '../../src/config/redis';
import { JwtVerifier } from '../../src/utils/jwtVerifier';
import { StorageProvider, setStorageProvider } from '../../src/adapters/storage.provider';
import { setSessionTimelineTracker, SessionTimelineTracker } from '../../src/modules/session-timeline/sessionTimeline.tracker';
import { FileCache } from '../../src/utils/fileCache';
import { RelationalLessonContext } from '../../src/types/broadcast.types';

import {
  findMatchingRecordedArtifact,
  resolveArtifactVideoUrl,
  resolveArtifactWhiteboardUrl,
  clampVideoSegmentOffset,
  normalizeWhiteboardRevisionPayload,
  type RecordedLessonArtifact,
} from '../../../../../ZERIXTECH/Projects/zerix-academy/frontend/src/modules/content/utils/broadcastRevisionUtils';

describe('Phase 4 End-to-End Cross-System Test: Broadcast Engine -> Laravel VOD Schema -> /learn Page Revision', () => {
  let tempDir: string;
  let storageProvider: StorageProvider;
  let server: Awaited<ReturnType<typeof createBroadcastServer>>;

  const sessionId = 'sess_e2e_phase4_neet_bio_2026';
  const baseRelCtx: RelationalLessonContext = {
    sessionId,
    branchId: 4,
    batchId: 105,
    boardId: 2,
    examId: 22,
    languageId: 1,
    courseId: 12,
    linkedVodCourseId: 212,
    subjectId: 9,
    chapterId: 4,
    chapterNumber: 4,
    chapterTitle: 'Cell Structure & Function',
    lessonId: 19,
    lessonNumber: '4.1',
    lessonTitle: 'Mitochondria & ATP Synthesis',
    topicId: 301,
    teacherId: 42,
    academicYear: 2026,
    version: 1,
    publishToVodCourse: true,
    isPrimaryVod: true,
  };

  before(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'broadcast-phase4-e2e-'));
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

  it('executes full lifecycle: multi-topic 720p recording -> gzipped whiteboard -> finalization -> /learn page HTTP 206 video segment & read-only whiteboard revision', async () => {
    const teacherToken = JwtVerifier.sign({
      userId: 501,
      role: 'teacher',
      sessionId,
      branchId: 4,
      batchId: 105,
      courseId: 12,
    });
    const teacherHeaders = { authorization: `Bearer ${teacherToken}` };

    // 1. Upload Chunk 0 & Chunk 1 while teaching Lesson 19 / Topic 301 (0s -> 180s)
    const chunk0 = Buffer.alloc(1024, 0x41);
    const chunk1 = Buffer.alloc(1024, 0x42);

    for (const [idx, buf] of [
      [0, chunk0],
      [1, chunk1],
    ] as const) {
      const chunkRes = await server.fastify.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessionId}/video-chunk`,
        headers: teacherHeaders,
        payload: {
          chunkIndex: idx,
          chunkBase64: buf.toString('base64'),
          relationalContext: baseRelCtx,
        },
      });
      assert.equal(chunkRes.statusCode, 200);
    }

    // 2. Save Teacher's Excalidraw Whiteboard for Lesson 19 (including a Content Mode stroke that MUST be stripped)
    const wbSaveRes = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/lessons/19/whiteboard`,
      headers: teacherHeaders,
      payload: {
        chapterId: 4,
        lessonId: 19,
        relationalContext: baseRelCtx,
        elements: [
          { id: 'mito_outer', type: 'ellipse', x: 100, y: 120, isDeleted: false },
          { id: 'f0_f1_text', type: 'text', x: 200, y: 160, text: 'ATP Synthase', isDeleted: false },
          { id: 'erased_draft', type: 'freedraw', x: 10, y: 10, isDeleted: true },
          { id: 'transient_content_pen', type: 'freedraw', mode: 'CONTENT', isContentAnnotation: true },
        ],
        appState: { viewBackgroundColor: '#ffffff' },
      },
    });
    assert.equal(wbSaveRes.statusCode, 200);
    assert.equal(wbSaveRes.json().data.saved, true);

    // 3. At 180s, Teacher briefly opens Lesson 20 / Topic 302 as reference_only (180s -> 240s)
    const navRefRes = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/curriculum/navigate`,
      headers: teacherHeaders,
      payload: {
        chapterId: 4,
        lessonId: 20,
        lessonNumber: '4.2',
        lessonTitle: 'Quick Reference Diagram',
        topicId: 302,
        videoOffsetSec: 180,
        mode: 'reference_only',
        relationalContext: {
          ...baseRelCtx,
          lessonId: 20,
          lessonNumber: '4.2',
          lessonTitle: 'Quick Reference Diagram',
          topicId: 302,
        },
      },
    });
    assert.equal(navRefRes.statusCode, 200);
    assert.equal(navRefRes.json().data.activeSegment.mode, 'reference_only');

    // 4. At 240s, Teacher switches to Lesson 21 / Topic 303 in taught mode (240s -> 540s)
    const navTaughtRes = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/curriculum/navigate`,
      headers: teacherHeaders,
      payload: {
        chapterId: 4,
        lessonId: 21,
        lessonNumber: '4.3',
        lessonTitle: 'Chloroplast & Thylakoid System',
        topicId: 303,
        videoOffsetSec: 240,
        mode: 'taught',
        relationalContext: {
          ...baseRelCtx,
          lessonId: 21,
          lessonNumber: '4.3',
          lessonTitle: 'Chloroplast & Thylakoid System',
          topicId: 303,
        },
      },
    });
    assert.equal(navTaughtRes.statusCode, 200);

    // Save Whiteboard for Lesson 21
    const wbSave21Res = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/lessons/21/whiteboard`,
      headers: teacherHeaders,
      payload: {
        chapterId: 4,
        lessonId: 21,
        relationalContext: {
          ...baseRelCtx,
          lessonId: 21,
          lessonNumber: '4.3',
          lessonTitle: 'Chloroplast & Thylakoid System',
          topicId: 303,
        },
        elements: [
          { id: 'thylakoid_stack', type: 'rectangle', x: 80, y: 90, isDeleted: false },
        ],
        appState: { viewBackgroundColor: '#ffffff' },
      },
    });
    assert.equal(wbSave21Res.statusCode, 200);

    // 5. Finalize continuous session at 540s
    const finalizeRes = await server.fastify.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/finalize`,
      headers: teacherHeaders,
      payload: {
        totalDurationSec: 540,
        relationalContext: baseRelCtx,
      },
    });
    assert.equal(finalizeRes.statusCode, 200);
    const finBody = finalizeRes.json();
    assert.equal(finBody.success, true);

    const summary = finBody.data;
    assert.equal(summary.publishedLessonArtifacts.length, 2);
    assert.equal(summary.skippedReferenceLessons.length, 1);
    assert.equal(summary.skippedReferenceLessons[0].lessonId, 20);

    // 6. Map finalized artifacts + skipped reference segment into `/api/v1/courses/12/recorded-artifacts` schema
    const laravelArtifacts: RecordedLessonArtifact[] = [
      ...summary.publishedLessonArtifacts.map((art: any, idx: number) => ({
        id: idx + 1,
        meetingId: sessionId,
        liveClassSessionId: 901,
        sourceLiveCourseId: 12,
        recordedVodCourseId: 212,
        batchId: 105,
        branchId: 4,
        boardId: 2,
        languageId: 1,
        subjectId: 9,
        chapterId: art.relationalContext.chapterId,
        lessonId: art.relationalContext.lessonId,
        lessonNumber: art.relationalContext.lessonNumber,
        topicId: art.relationalContext.topicId,
        teacherId: 42,
        academicYear: 2026,
        version: 1,
        segmentMode: 'taught' as const,
        videoRelativePath: art.videoRelativePath,
        videoMimeType: 'video/webm',
        videoSizeBytes: 2048,
        videoStartOffsetSec: art.videoStartOffsetSec,
        videoEndOffsetSec: art.videoEndOffsetSec,
        durationSeconds: art.videoEndOffsetSec - art.videoStartOffsetSec,
        whiteboardGzipRelativePath: art.whiteboardGzipRelativePath,
        whiteboardSizeBytes: 512,
        timelineMarkers: [],
        storageDriver: 'local_disk',
        publishToVodCourse: true,
        isPrimaryVod: true,
      })),
      {
        id: 99,
        meetingId: sessionId,
        liveClassSessionId: 901,
        sourceLiveCourseId: 12,
        recordedVodCourseId: 212,
        batchId: 105,
        branchId: 4,
        boardId: 2,
        languageId: 1,
        subjectId: 9,
        chapterId: 4,
        lessonId: 20,
        lessonNumber: '4.2',
        topicId: 302,
        teacherId: 42,
        academicYear: 2026,
        version: 1,
        segmentMode: 'reference_only' as const,
        videoRelativePath: summary.publishedLessonArtifacts[0].videoRelativePath,
        videoMimeType: 'video/webm',
        videoSizeBytes: 2048,
        videoStartOffsetSec: 180,
        videoEndOffsetSec: 240,
        durationSeconds: 60,
        whiteboardGzipRelativePath: null,
        whiteboardSizeBytes: 0,
        timelineMarkers: [],
        storageDriver: 'local_disk',
        publishToVodCourse: false,
        isPrimaryVod: false,
      },
    ];

    // 7. Verify `/learn` page behavior when Student opens Reference-Only Lesson 20 / Topic 302 -> null
    const refMatch = findMatchingRecordedArtifact(laravelArtifacts, {
      lessonId: 20,
      topicId: 302,
      languageId: 1,
    });
    assert.equal(refMatch, null);

    // 8. Verify `/learn` page behavior when Student opens Lesson 19 / Topic 301 -> [0s..180s]
    const lesson19Artifact = findMatchingRecordedArtifact(laravelArtifacts, {
      lessonId: 19,
      topicId: 301,
      languageId: 1,
    });
    assert.ok(lesson19Artifact);
    assert.equal(lesson19Artifact.videoStartOffsetSec, 0);
    assert.equal(lesson19Artifact.videoEndOffsetSec, 180);

    // 9. Verify `/learn` page behavior when Student opens Lesson 21 / Topic 303 -> [240s..540s]
    const lesson21Artifact = findMatchingRecordedArtifact(laravelArtifacts, {
      lessonId: 21,
      topicId: 303,
      languageId: 1,
    });
    assert.ok(lesson21Artifact);
    assert.equal(lesson21Artifact.videoStartOffsetSec, 240);
    assert.equal(lesson21Artifact.videoEndOffsetSec, 540);

    // Verify segment clamping on `/learn` video player for Lesson 21
    const initialClamp = clampVideoSegmentOffset(
      0,
      lesson21Artifact.videoStartOffsetSec,
      lesson21Artifact.videoEndOffsetSec
    );
    assert.equal(initialClamp.isBeforeSegmentStart, true);
    assert.equal(initialClamp.clampedTimeSec, 240);

    const endClamp = clampVideoSegmentOffset(
      540.5,
      lesson21Artifact.videoStartOffsetSec,
      lesson21Artifact.videoEndOffsetSec
    );
    assert.equal(endClamp.hasReachedSegmentEnd, true);
    assert.equal(endClamp.clampedTimeSec, 540);

    // 10. Verify `/learn` page resolved video URL streams HTTP 206 Partial Content from broadcast engine
    const fullVideoStreamUrl = resolveArtifactVideoUrl(lesson19Artifact);
    const streamPathOnly = new URL(fullVideoStreamUrl).pathname;
    const rangeRes = await server.fastify.inject({
      method: 'GET',
      url: streamPathOnly,
      headers: {
        range: 'bytes=0-127',
      },
    });
    assert.equal(rangeRes.statusCode, 206);
    assert.equal(rangeRes.headers['content-range'], 'bytes 0-127/2048');
    assert.equal(rangeRes.rawPayload.byteLength, 128);

    // 11. Verify `/learn` page resolved whiteboard URL returns decompressed Excalidraw JSON with Content Mode & deleted strokes removed
    const fullWbUrl = resolveArtifactWhiteboardUrl(lesson19Artifact);
    const wbPathOnly = new URL(fullWbUrl).pathname;
    const wbGetRes = await server.fastify.inject({
      method: 'GET',
      url: wbPathOnly,
    });
    assert.equal(wbGetRes.statusCode, 200);
    const normalizedWb = normalizeWhiteboardRevisionPayload(wbGetRes.json());
    assert.equal(normalizedWb.elements.length, 2, 'Only mito_outer and f0_f1_text should remain');
    assert.equal(normalizedWb.elements[0].id, 'mito_outer');
    assert.equal(normalizedWb.elements[1].id, 'f0_f1_text');
  });
});
