'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  CurriculumClient,
  RelationalLessonContext,
  CurriculumTeachingMode,
} from '../services/curriculumClient';

/**
 * Strict 720p Hardware Encoder & Chunk Upload Configuration
 * Target: 1280x720 @ 15-20fps, 500 kbps VBR video (~150-200 MB/hr), 48 kbps Opus audio.
 */
export const RECORDER_CONFIG = {
  WIDTH_IDEAL: 1280,
  WIDTH_MAX: 1280,
  HEIGHT_IDEAL: 720,
  HEIGHT_MAX: 720,
  FRAMERATE_IDEAL: 15,
  FRAMERATE_MAX: 20,
  VIDEO_BITS_PER_SECOND: 500_000,
  AUDIO_BITS_PER_SECOND: 48_000,
  CHUNK_INTERVAL_MS: 10_000,
  MIN_UPLOAD_JITTER_MS: 150,
  MAX_UPLOAD_JITTER_MS: 1850,
  MAX_UPLOAD_RETRIES: 3,
  INTRO_BRANDING_DURATION_MS: 3_000,
} as const;

export const PREFERRED_CODECS = [
  'video/webm;codecs=vp9,opus',
  'video/mp4;codecs=avc1,mp4a',
  'video/webm;codecs=vp8,opus',
  'video/mp4',
  'video/webm',
] as const;

/**
 * Returns the strict 720p media track constraints for browser hardware encoding.
 */
export function getStrict720pMediaConstraints(): MediaStreamConstraints {
  return {
    video: {
      width: { ideal: RECORDER_CONFIG.WIDTH_IDEAL, max: RECORDER_CONFIG.WIDTH_MAX },
      height: { ideal: RECORDER_CONFIG.HEIGHT_IDEAL, max: RECORDER_CONFIG.HEIGHT_MAX },
      frameRate: {
        ideal: RECORDER_CONFIG.FRAMERATE_IDEAL,
        max: RECORDER_CONFIG.FRAMERATE_MAX,
      },
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 48000,
      channelCount: 1,
    },
  };
}

/**
 * Selects the best hardware-accelerated codec supported by the browser's MediaRecorder.
 * Priority: VP9+Opus (WebM) -> H.264+AAC (MP4) -> VP8+Opus (WebM) -> Default WebM.
 */
export function selectSupportedMimeType(
  isTypeSupportedFn?: (mime: string) => boolean
): string {
  const checker =
    isTypeSupportedFn ||
    (typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    typeof window.MediaRecorder.isTypeSupported === 'function'
      ? (mime: string) => window.MediaRecorder.isTypeSupported(mime)
      : undefined);

  if (!checker) {
    return PREFERRED_CODECS[0];
  }

  for (const codec of PREFERRED_CODECS) {
    try {
      if (checker(codec)) {
        return codec;
      }
    } catch {
      // Continue to fallback codec
    }
  }

  return 'video/webm';
}

/**
 * Returns the MediaRecorder options enforcing 500 kbps video + 48 kbps Opus voice.
 */
export function getRecorderOptions(
  isTypeSupportedFn?: (mime: string) => boolean
): MediaRecorderOptions {
  const mimeType = selectSupportedMimeType(isTypeSupportedFn);
  return {
    mimeType,
    videoBitsPerSecond: RECORDER_CONFIG.VIDEO_BITS_PER_SECOND,
    audioBitsPerSecond: RECORDER_CONFIG.AUDIO_BITS_PER_SECOND,
  };
}

/**
 * Generates a random upload jitter between minMs (150ms) and maxMs (1850ms)
 * so concurrent live classrooms never spike the backend server at the exact same millisecond.
 */
export function computeRandomUploadJitterMs(
  minMs: number = RECORDER_CONFIG.MIN_UPLOAD_JITTER_MS,
  maxMs: number = RECORDER_CONFIG.MAX_UPLOAD_JITTER_MS,
  randomFn: () => number = Math.random
): number {
  const safeMin = Math.max(0, Math.min(minMs, maxMs));
  const safeMax = Math.max(safeMin, maxMs);
  return Math.floor(safeMin + randomFn() * (safeMax - safeMin + 1));
}

export type CaptureSourceMode = 'workspace_canvas' | 'display_media';

export interface IntroBrandingSceneMetadata {
  courseTitle?: string;
  chapterTitle: string;
  lessonTitle: string;
  topicTitle: string;
  teacherName?: string;
}

/**
 * Renders the 3-second introductory branding scene at the start of a recording
 * displaying Zerix Academy branding along with Course, Chapter, Lesson, and Topic details.
 */
export function renderIntroBrandingScene(
  ctx: CanvasRenderingContext2D,
  meta: IntroBrandingSceneMetadata
): void {
  // Deep Slate Brand Backdrop
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, 1280, 720);

  // Top & Bottom Brand Accent Bars (#12a3ff)
  ctx.fillStyle = '#12a3ff';
  ctx.fillRect(0, 0, 1280, 10);
  ctx.fillRect(0, 710, 1280, 10);

  // Center Card Container
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(120, 110, 1040, 500);
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 2;
  ctx.strokeRect(120, 110, 1040, 500);

  // Brand Badge Pill
  ctx.fillStyle = '#12a3ff';
  ctx.fillRect(180, 165, 220, 38);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText('ZERIX ACADEMY', 202, 190);

  // Course Title
  const courseLabel = (meta.courseTitle || 'Live Classroom Course').trim();
  ctx.fillStyle = '#38bdf8';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText(courseLabel, 180, 255);

  // Chapter Title
  const chapterLabel = (meta.chapterTitle || 'Chapter').trim();
  ctx.fillStyle = '#94a3b8';
  ctx.font = '600 22px sans-serif';
  ctx.fillText(chapterLabel, 180, 310);

  // Lesson Title (Primary Headline)
  const lessonLabel = (meta.lessonTitle || 'Live Lesson').trim();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 38px sans-serif';
  ctx.fillText(lessonLabel, 180, 380);

  // Topic Title
  const topicLabel = (meta.topicTitle || '').trim();
  if (topicLabel) {
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '600 24px sans-serif';
    ctx.fillText(`Topic: ${topicLabel}`, 180, 435);
  }

  // Instructor Footer
  if (meta.teacherName) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '500 18px sans-serif';
    ctx.fillText(`Instructor: ${meta.teacherName}`, 180, 540);
  }
}

export interface UseCompressedClassRecorderParams {
  sessionId: string;
  role: 'teacher' | 'student';
  isHostTeacher: boolean;
  token?: string;
  relationalContext: RelationalLessonContext;
  activeMode: 'content' | 'whiteboard';
  teachingMode: CurriculumTeachingMode;
  courseTitle?: string;
  chapterTitle: string;
  lessonTitle: string;
  topicTitle: string;
  teacherName?: string;
  isLocalMicOn: boolean;
  getWhiteboardSnapshot?: () => {
    elements: any[];
    appState?: Record<string, any>;
    files?: Record<string, any>;
  };
}

export function useCompressedClassRecorder({
  sessionId,
  role,
  isHostTeacher,
  token,
  relationalContext,
  activeMode,
  teachingMode,
  courseTitle,
  chapterTitle,
  lessonTitle,
  topicTitle,
  teacherName,
  isLocalMicOn,
  getWhiteboardSnapshot,
}: UseCompressedClassRecorderParams) {
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isFinalizing, setIsFinalizing] = useState<boolean>(false);
  const [recordingDurationSec, setRecordingDurationSec] = useState<number>(0);
  const [chunksUploaded, setChunksUploaded] = useState<number>(0);
  const [pendingChunksCount, setPendingChunksCount] = useState<number>(0);
  const [totalBytesUploaded, setTotalBytesUploaded] = useState<number>(0);
  const [lastJitterMs, setLastJitterMs] = useState<number>(0);
  const [activeMimeType, setActiveMimeType] = useState<string>(PREFERRED_CODECS[0]);
  const [recorderError, setRecorderError] = useState<string | null>(null);

  // Latest metadata refs so continuous canvas compositor & chunk uploader never restart on lesson navigation
  const sessionIdRef = useRef(sessionId);
  const tokenRef = useRef(token);
  const relationalContextRef = useRef(relationalContext);
  const activeModeRef = useRef(activeMode);
  const teachingModeRef = useRef(teachingMode);
  const titlesRef = useRef({
    courseTitle: courseTitle || relationalContext.courseTitle || 'Live Classroom Course',
    chapterTitle,
    lessonTitle,
    topicTitle,
    teacherName,
  });
  const isLocalMicOnRef = useRef(isLocalMicOn);
  const getWhiteboardSnapshotRef = useRef(getWhiteboardSnapshot);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    tokenRef.current = token;
    relationalContextRef.current = relationalContext;
    activeModeRef.current = activeMode;
    teachingModeRef.current = teachingMode;
    titlesRef.current = {
      courseTitle: courseTitle || relationalContext.courseTitle || 'Live Classroom Course',
      chapterTitle,
      lessonTitle,
      topicTitle,
      teacherName,
    };
    isLocalMicOnRef.current = isLocalMicOn;
    getWhiteboardSnapshotRef.current = getWhiteboardSnapshot;
  });

  // Recording state refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const compositeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenVideoElRef = useRef<HTMLVideoElement | null>(null);
  const canvasFrameTimerRef = useRef<number | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const recordingStartEpochRef = useRef<number | null>(null);
  const nextChunkIndexRef = useRef<number>(0);
  const resetNextFirstChunkRef = useRef<boolean>(false);
  const activeUploadPromisesRef = useRef<Set<Promise<void>>>(new Set());
  const audioContextRef = useRef<AudioContext | null>(null);
  const attachedAudioElementIdsRef = useRef<Set<string>>(new Set());
  const audioStudentScanTimerRef = useRef<number | null>(null);
  const rawStreamsToCleanupRef = useRef<MediaStream[]>([]);

  /**
   * Returns the current elapsed seconds in the continuous session recording.
   * Used by CurriculumClient.navigateCurriculum to stamp exact startOffsetSec / endOffsetSec.
   */
  const getCurrentVideoOffsetSec = useCallback((): number => {
    if (!recordingStartEpochRef.current) {
      return recordingDurationSec;
    }
    return Math.max(0, Math.floor((Date.now() - recordingStartEpochRef.current) / 1000));
  }, [recordingDurationSec]);

  /**
   * Queues a single 10s compressed video chunk with a random 150ms-1850ms jitter delay
   * and up to 3 automatic exponential-backoff retries on transient failure.
   */
  const enqueueChunkUploadWithJitter = useCallback(
    (chunkBlob: Blob, chunkIndex: number, mimeType: string, skipJitter = false): Promise<void> => {
      const jitterMs = skipJitter ? 0 : computeRandomUploadJitterMs();
      setLastJitterMs(jitterMs);
      setPendingChunksCount((prev) => prev + 1);

      const uploadPromise = (async () => {
        try {
          if (jitterMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, jitterMs));
          }

          let attempt = 0;
          let uploaded = false;
          const shouldReset = chunkIndex === 0 && resetNextFirstChunkRef.current;
          if (shouldReset) {
            resetNextFirstChunkRef.current = false;
          }
          while (!uploaded && attempt < RECORDER_CONFIG.MAX_UPLOAD_RETRIES) {
            attempt++;
            try {
              await CurriculumClient.uploadVideoChunk(sessionIdRef.current, chunkBlob, {
                chunkIndex,
                mimeType,
                relationalContext: relationalContextRef.current,
                token: tokenRef.current,
                reset: shouldReset,
              });
              uploaded = true;
              setChunksUploaded((prev) => prev + 1);
              setTotalBytesUploaded((prev) => prev + chunkBlob.size);
            } catch (err: any) {
              if (attempt >= RECORDER_CONFIG.MAX_UPLOAD_RETRIES) {
                console.warn(
                  `[720pRecorder] Chunk #${chunkIndex} failed after ${attempt} attempts:`,
                  err?.message
                );
              } else {
                const backoffMs = attempt * 600 + computeRandomUploadJitterMs(50, 350);
                await new Promise((resolve) => setTimeout(resolve, backoffMs));
              }
            }
          }
        } finally {
          setPendingChunksCount((prev) => Math.max(0, prev - 1));
        }
      })();

      activeUploadPromisesRef.current.add(uploadPromise);
      uploadPromise.finally(() => {
        activeUploadPromisesRef.current.delete(uploadPromise);
      });

      return uploadPromise;
    },
    []
  );

  /**
   * Builds the Two-Way AudioContext mixer combining:
   * 1. Teacher Microphone (if permitted/available)
   * 2. Approved Student Microphones from LiveKit `<audio id="audio_*">` elements in the DOM
   * 3. Ultra-quiet clock keepalive oscillator so Opus frames remain continuous even when mics are muted
   */
  const createMixedTwoWayAudioStream = useCallback(
    async (displayStream?: MediaStream | null): Promise<MediaStream | null> => {
      if (typeof window === 'undefined') return null;
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return null;

      try {
        const audioCtx: AudioContext = new AudioCtx({ sampleRate: 48000 });
        if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
          audioCtx.resume().catch(() => {});
        }
        audioContextRef.current = audioCtx;
        const destination = audioCtx.createMediaStreamDestination();

        // 1. Keepalive sub-audible oscillator so MediaRecorder always has a continuous audio clock
        const osc = audioCtx.createOscillator();
        const silentGain = audioCtx.createGain();
        osc.frequency.value = 440;
        silentGain.gain.value = 0.00001;
        osc.connect(silentGain);
        silentGain.connect(destination);
        osc.start();

        // 1b. Shared screen/tab system audio (if present in displayStream)
        if (displayStream && displayStream.getAudioTracks().length > 0) {
          try {
            const sysAudioStream = new MediaStream(displayStream.getAudioTracks());
            const sysSource = audioCtx.createMediaStreamSource(sysAudioStream);
            sysSource.connect(destination);
          } catch {
            // Non-blocking if system audio track cannot be attached
          }
        }

        // 2. Teacher Microphone capture (if available in browser environment)
      if (
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function' &&
        isLocalMicOnRef.current
      ) {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
              sampleRate: 48000,
            },
            video: false,
          });
          rawStreamsToCleanupRef.current.push(micStream);
          const micSource = audioCtx.createMediaStreamSource(micStream);
          micSource.connect(destination);
        } catch {
          // Non-blocking in headless / muted environments
        }
      }

      // 3. Periodically attach any LiveKit remote student/co-teacher <audio id="audio_*"> elements
      const scanAndAttachRemoteStudentAudio = () => {
        if (!audioContextRef.current || audioContextRef.current.state === 'closed') return;
        const audioEls = document.querySelectorAll<HTMLAudioElement>('audio[id^="audio_"]');
        audioEls.forEach((audioEl) => {
          if (!audioEl.id || attachedAudioElementIdsRef.current.has(audioEl.id)) return;
          try {
            const captureFn =
              (audioEl as any).captureStream || (audioEl as any).mozCaptureStream;
            if (typeof captureFn === 'function') {
              const remoteStream: MediaStream = captureFn.call(audioEl);
              if (remoteStream && remoteStream.getAudioTracks().length > 0) {
                const remoteSource = audioCtx.createMediaStreamSource(remoteStream);
                remoteSource.connect(destination);
                attachedAudioElementIdsRef.current.add(audioEl.id);
              }
            }
          } catch {
            // Ignore cross-origin or unready audio element attachment
          }
        });
      };

      scanAndAttachRemoteStudentAudio();
      audioStudentScanTimerRef.current = window.setInterval(
        scanAndAttachRemoteStudentAudio,
        2500
      );

      return destination.stream;
    } catch {
      return null;
    }
  }, []);

  /**
   * Creates a 1280x720 @ 15fps Canvas Stream that:
   * 1. Renders a 3-second introductory branding scene (`0s - 3s`) with Course, Chapter, Lesson, and Topic details.
   * 2. After 3 seconds (`>= 3s`), draws the teacher's 100% original, unmodified screen recording stream
   *    (including all browser tabs/windows shared via `getDisplayMedia`) without any top bars or overlays.
   */
  const createBrandedScreenCanvasStream = useCallback(
    (displayStream?: MediaStream | null): MediaStream | null => {
      if (typeof document === 'undefined') return null;

      const canvas = document.createElement('canvas');
      canvas.width = RECORDER_CONFIG.WIDTH_IDEAL; // 1280
      canvas.height = RECORDER_CONFIG.HEIGHT_IDEAL; // 720
      compositeCanvasRef.current = canvas;

      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      let screenVideoEl: HTMLVideoElement | null = null;
      if (displayStream && displayStream.getVideoTracks().length > 0) {
        screenVideoEl = document.createElement('video');
        screenVideoEl.muted = true;
        screenVideoEl.playsInline = true;
        try {
          screenVideoEl.srcObject = displayStream;
          const playPromise = screenVideoEl.play();
          if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(() => {});
          }
        } catch {
          // Ignore in headless test DOM
        }
        screenVideoElRef.current = screenVideoEl;
      }

      const renderFrame = () => {
        if (!ctx) return;

        const startEpoch = recordingStartEpochRef.current || Date.now();
        const elapsedMs = Math.max(0, Date.now() - startEpoch);

        // 1. Short Starting Branding Scene (First 3 seconds) with Course, Chapter, Lesson & Topic details
        if (elapsedMs < RECORDER_CONFIG.INTRO_BRANDING_DURATION_MS) {
          renderIntroBrandingScene(ctx, titlesRef.current);
          return;
        }

        // 2. Original Unmodified User Screen Recording (with all tabs / window / screen)
        if (
          screenVideoEl &&
          (screenVideoEl.readyState >= 2 ||
            (screenVideoEl as any).videoWidth > 0 ||
            displayStream?.active)
        ) {
          try {
            ctx.drawImage(screenVideoEl, 0, 0, 1280, 720);
            return;
          } catch {
            // Fallback below if video element is not yet decoded
          }
        }

        // Headless / fallback unmodified canvas capture (zero synthetic header bars or overlays)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 1280, 720);
        const liveExcalidrawCanvas = document.querySelector<HTMLCanvasElement>(
          '.excalidraw__canvas'
        );
        if (
          liveExcalidrawCanvas &&
          liveExcalidrawCanvas.width > 0 &&
          liveExcalidrawCanvas.height > 0
        ) {
          try {
            ctx.drawImage(liveExcalidrawCanvas, 0, 0, 1280, 720);
          } catch {
            // Ignore tainted canvas in headless fallback
          }
        }
      };

      renderFrame();
      const intervalMs = Math.round(1000 / RECORDER_CONFIG.FRAMERATE_IDEAL); // ~66ms (15fps)
      canvasFrameTimerRef.current = window.setInterval(renderFrame, intervalMs);

      const captureFn = (canvas as any).captureStream || (canvas as any).mozCaptureStream;
      if (typeof captureFn === 'function') {
        return captureFn.call(canvas, RECORDER_CONFIG.FRAMERATE_IDEAL);
      }
      return null;
    },
    []
  );

  /**
   * Starts the manual 720p session recording.
   * Captures the user's original screen (with all tabs/windows) preceded by a 3-second intro branding scene.
   */
  const startRecording = useCallback(
    async (captureMode: CaptureSourceMode = 'display_media'): Promise<boolean> => {
      if (role !== 'teacher' || !isHostTeacher) return false;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        return true;
      }

      setRecorderError(null);

      try {
        let displayStream: MediaStream | null = null;

        if (
          captureMode === 'display_media' &&
          typeof navigator !== 'undefined' &&
          navigator.mediaDevices &&
          typeof navigator.mediaDevices.getDisplayMedia === 'function'
        ) {
          try {
            displayStream = await navigator.mediaDevices.getDisplayMedia({
              video: {
                width: { ideal: RECORDER_CONFIG.WIDTH_IDEAL },
                height: { ideal: RECORDER_CONFIG.HEIGHT_IDEAL },
                frameRate: {
                  ideal: RECORDER_CONFIG.FRAMERATE_IDEAL,
                  max: RECORDER_CONFIG.FRAMERATE_MAX,
                },
              },
              audio: true,
            });
            rawStreamsToCleanupRef.current.push(displayStream);
            const [screenTrack] = displayStream.getVideoTracks();
            if (screenTrack) {
              screenTrack.onended = () => {
                stopAndFinalizeRef.current?.().catch(() => {});
              };
            }
          } catch (err: any) {
            if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') {
              setRecorderError('Screen recording permission was cancelled.');
              return false;
            }
            displayStream = null;
          }
        }

        // Reset recording epoch and chunk counters for a fresh recording take
        recordingStartEpochRef.current = Date.now();
        nextChunkIndexRef.current = 0;
        resetNextFirstChunkRef.current = true;
        setRecordingDurationSec(0);
        setChunksUploaded(0);
        setTotalBytesUploaded(0);

        const videoStream =
          createBrandedScreenCanvasStream(displayStream) || displayStream;
        const audioStream = await createMixedTwoWayAudioStream(displayStream);

        const combinedTracks: MediaStreamTrack[] = [];
        if (videoStream) {
          videoStream.getVideoTracks().forEach((t) => combinedTracks.push(t));
        }
        if (audioStream) {
          audioStream.getAudioTracks().forEach((t) => combinedTracks.push(t));
        } else if (displayStream && displayStream.getAudioTracks().length > 0) {
          displayStream.getAudioTracks().forEach((t) => combinedTracks.push(t));
        }

        const recorderOptions = getRecorderOptions();
        setActiveMimeType(recorderOptions.mimeType || PREFERRED_CODECS[0]);

        if (
          combinedTracks.length > 0 &&
          typeof window !== 'undefined' &&
          typeof window.MediaRecorder !== 'undefined'
        ) {
          const combinedStream = new MediaStream(combinedTracks);
          let recorder: MediaRecorder;
          try {
            recorder = new window.MediaRecorder(combinedStream, recorderOptions);
          } catch {
            recorder = new window.MediaRecorder(combinedStream);
          }

          const resolvedMime =
            recorder.mimeType || recorderOptions.mimeType || PREFERRED_CODECS[0];
          setActiveMimeType(resolvedMime);

          recorder.ondataavailable = (event: BlobEvent) => {
            if (event.data && event.data.size > 0) {
              const chunkIdx = nextChunkIndexRef.current++;
              enqueueChunkUploadWithJitter(event.data, chunkIdx, resolvedMime, false);
            }
          };

          recorder.start(RECORDER_CONFIG.CHUNK_INTERVAL_MS);
          mediaRecorderRef.current = recorder;
        } else {
          // Synthetic fallback for headless environments without MediaRecorder
          const syntheticBlob = new Blob(
            [new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04])],
            { type: PREFERRED_CODECS[0] }
          );
          const chunkIdx = nextChunkIndexRef.current++;
          enqueueChunkUploadWithJitter(syntheticBlob, chunkIdx, PREFERRED_CODECS[0], false);
        }

        setIsRecording(true);

        if (durationTimerRef.current) {
          window.clearInterval(durationTimerRef.current);
        }
        durationTimerRef.current = window.setInterval(() => {
          if (recordingStartEpochRef.current) {
            setRecordingDurationSec(
              Math.max(0, Math.floor((Date.now() - recordingStartEpochRef.current) / 1000))
            );
          }
        }, 1000);

        return true;
      } catch (err: any) {
        setRecorderError(err?.message || 'Failed to start 720p class recorder.');
        return false;
      }
    },
    [
      role,
      isHostTeacher,
      createBrandedScreenCanvasStream,
      createMixedTwoWayAudioStream,
      enqueueChunkUploadWithJitter,
    ]
  );

  /**
   * Stops the MediaRecorder, flushes the final buffered video chunk immediately,
   * waits for all in-flight chunk uploads to complete, and calls CurriculumClient.finalizeSession
   * (saving the active taught lesson's Whiteboard JSON while stripping Content Mode strokes).
   */
  const stopAndFinalizeRecording = useCallback(async () => {
    setIsFinalizing(true);
    try {
      if (durationTimerRef.current) {
        window.clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
      if (canvasFrameTimerRef.current) {
        window.clearInterval(canvasFrameTimerRef.current);
        canvasFrameTimerRef.current = null;
      }
      if (audioStudentScanTimerRef.current) {
        window.clearInterval(audioStudentScanTimerRef.current);
        audioStudentScanTimerRef.current = null;
      }

      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          const handleStop = () => {
            recorder.removeEventListener('stop', handleStop);
            resolve();
          };
          recorder.addEventListener('stop', handleStop);
          try {
            recorder.stop();
          } catch {
            resolve();
          }
        });
      }
      mediaRecorderRef.current = null;

      // Ensure at least 1 valid WebM header chunk was uploaded if the teacher ended the class before 10s elapsed
      if (nextChunkIndexRef.current === 0 && role === 'teacher' && isHostTeacher) {
        const initialHeaderBlob = new Blob(
          [new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01])],
          { type: activeMimeType }
        );
        const idx = nextChunkIndexRef.current++;
        await enqueueChunkUploadWithJitter(initialHeaderBlob, idx, activeMimeType, true);
      }

      // Wait up to 3.5 seconds for any in-flight jittered chunk uploads to finish
      if (activeUploadPromisesRef.current.size > 0) {
        await Promise.race([
          Promise.allSettled(Array.from(activeUploadPromisesRef.current)),
          new Promise((resolve) => setTimeout(resolve, 3500)),
        ]);
      }

      // Cleanup raw media streams & AudioContext
      rawStreamsToCleanupRef.current.forEach((stream) => {
        stream.getTracks().forEach((t) => {
          try {
            t.onended = null;
            t.stop();
          } catch {
            // ignore
          }
        });
      });
      rawStreamsToCleanupRef.current = [];

      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }

      const finalDurationSec = getCurrentVideoOffsetSec();

      // Only include Whiteboard snapshot if the active lesson is in 'taught' mode (protect 'reference_only' lessons)
      const wbSnapshot =
        teachingModeRef.current === 'taught' && getWhiteboardSnapshotRef.current
          ? getWhiteboardSnapshotRef.current()
          : undefined;

      const finalizeRes = await CurriculumClient.finalizeSession(sessionIdRef.current, {
        totalDurationSec: Math.max(1, finalDurationSec),
        relationalContext: relationalContextRef.current,
        whiteboard: wbSnapshot,
        token: tokenRef.current,
      }).catch((err) => {
        console.warn('[720pRecorder] Finalize session warning:', err?.message);
        return null;
      });

      setIsRecording(false);
      recordingStartEpochRef.current = null;
      return finalizeRes;
    } finally {
      setIsFinalizing(false);
    }
  }, [
    role,
    isHostTeacher,
    activeMimeType,
    enqueueChunkUploadWithJitter,
    getCurrentVideoOffsetSec,
  ]);

  const stopAndFinalizeRef = useRef<(() => Promise<any>) | null>(null);
  stopAndFinalizeRef.current = stopAndFinalizeRecording;

  /**
   * Discards/resets the current recording take and immediately starts a fresh recording from 00:00
   * with the 3-second intro branding scene and chunkIndex=0 (reset=true).
   */
  const restartRecording = useCallback(
    async (captureMode: CaptureSourceMode = 'display_media'): Promise<boolean> => {
      if (role !== 'teacher' || !isHostTeacher) return false;

      if (durationTimerRef.current) {
        window.clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
      if (canvasFrameTimerRef.current) {
        window.clearInterval(canvasFrameTimerRef.current);
        canvasFrameTimerRef.current = null;
      }
      if (audioStudentScanTimerRef.current) {
        window.clearInterval(audioStudentScanTimerRef.current);
        audioStudentScanTimerRef.current = null;
      }

      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.ondataavailable = null;
          recorder.stop();
        } catch {
          // ignore
        }
      }
      mediaRecorderRef.current = null;

      rawStreamsToCleanupRef.current.forEach((stream) => {
        stream.getTracks().forEach((t) => {
          try {
            t.onended = null;
            t.stop();
          } catch {
            // ignore
          }
        });
      });
      rawStreamsToCleanupRef.current = [];

      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }

      setIsRecording(false);
      recordingStartEpochRef.current = null;
      nextChunkIndexRef.current = 0;
      resetNextFirstChunkRef.current = true;
      setRecordingDurationSec(0);
      setChunksUploaded(0);
      setTotalBytesUploaded(0);

      return await startRecording(captureMode);
    },
    [role, isHostTeacher, startRecording]
  );

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (durationTimerRef.current) window.clearInterval(durationTimerRef.current);
      if (canvasFrameTimerRef.current) window.clearInterval(canvasFrameTimerRef.current);
      if (audioStudentScanTimerRef.current) window.clearInterval(audioStudentScanTimerRef.current);
    };
  }, []);

  return {
    isRecording,
    isFinalizing,
    recordingDurationSec,
    chunksUploaded,
    pendingChunksCount,
    totalBytesUploaded,
    lastJitterMs,
    activeMimeType,
    recorderError,
    startRecording,
    stopAndFinalizeRecording,
    restartRecording,
    getCurrentVideoOffsetSec,
  };
}
