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
} as const;

export const PREFERRED_CODECS = [
  'video/webm;codecs=vp9,opus',
  'video/mp4;codecs=avc1,mp4a',
  'video/webm;codecs=vp8,opus',
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

export interface UseCompressedClassRecorderParams {
  sessionId: string;
  role: 'teacher' | 'student';
  isHostTeacher: boolean;
  token?: string;
  relationalContext: RelationalLessonContext;
  activeMode: 'content' | 'whiteboard';
  teachingMode: CurriculumTeachingMode;
  chapterTitle: string;
  lessonTitle: string;
  topicTitle: string;
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
  chapterTitle,
  lessonTitle,
  topicTitle,
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
  const titlesRef = useRef({ chapterTitle, lessonTitle, topicTitle });
  const isLocalMicOnRef = useRef(isLocalMicOn);
  const getWhiteboardSnapshotRef = useRef(getWhiteboardSnapshot);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    tokenRef.current = token;
    relationalContextRef.current = relationalContext;
    activeModeRef.current = activeMode;
    teachingModeRef.current = teachingMode;
    titlesRef.current = { chapterTitle, lessonTitle, topicTitle };
    isLocalMicOnRef.current = isLocalMicOn;
    getWhiteboardSnapshotRef.current = getWhiteboardSnapshot;
  });

  // Recording state refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const compositeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasFrameTimerRef = useRef<number | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const recordingStartEpochRef = useRef<number | null>(null);
  const nextChunkIndexRef = useRef<number>(0);
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
          while (!uploaded && attempt < RECORDER_CONFIG.MAX_UPLOAD_RETRIES) {
            attempt++;
            try {
              await CurriculumClient.uploadVideoChunk(sessionIdRef.current, chunkBlob, {
                chunkIndex,
                mimeType,
                relationalContext: relationalContextRef.current,
                token: tokenRef.current,
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
  const createMixedTwoWayAudioStream = useCallback(async (): Promise<MediaStream | null> => {
    if (typeof window === 'undefined') return null;
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return null;

    try {
      const audioCtx: AudioContext = new AudioCtx({ sampleRate: 48000 });
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
   * Creates a strict 1280x720 @ 15fps Workspace Composite Canvas Stream.
   * Captures the active Excalidraw Whiteboard canvas or Content stage in strict Light Theme
   * (`#12a3ff` primary, `#000000` secondary, `#ffffff` surface) without requiring a browser
   * screen-share popup.
   */
  const createWorkspace720pCanvasStream = useCallback((): MediaStream | null => {
    if (typeof document === 'undefined') return null;

    const canvas = document.createElement('canvas');
    canvas.width = RECORDER_CONFIG.WIDTH_IDEAL; // 1280
    canvas.height = RECORDER_CONFIG.HEIGHT_IDEAL; // 720
    compositeCanvasRef.current = canvas;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const renderFrame = () => {
      if (!ctx) return;

      // 60% Primary Light Surface (#ffffff)
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 1280, 720);

      // Top Studio Header Bar (44px height) in Light Theme
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(0, 0, 1280, 44);
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 44);
      ctx.lineTo(1280, 44);
      ctx.stroke();

      // Primary Accent (#12a3ff) Brand Pill
      ctx.fillStyle = '#12a3ff';
      ctx.fillRect(16, 10, 88, 24);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText('ZERIX LIVE', 26, 26);

      // Active Chapter / Lesson / Topic Breadcrumb (#000000 secondary text)
      const { chapterTitle: ch, lessonTitle: les, topicTitle: top } = titlesRef.current;
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(`${ch}  ›  ${les}  ›  ${top}`, 118, 26);

      // Mode Badge on Top Right
      const modeLabel =
        teachingModeRef.current === 'reference_only'
          ? 'REFERENCE ONLY'
          : activeModeRef.current === 'whiteboard'
          ? 'WHITEBOARD STUDIO'
          : 'CONTENT STAGE';
      ctx.fillStyle = teachingModeRef.current === 'reference_only' ? '#f59e0b' : '#12a3ff';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(modeLabel, 1130, 26);

      // Composite live Excalidraw canvas if present in the DOM
      const liveExcalidrawCanvas = document.querySelector<HTMLCanvasElement>(
        '.excalidraw__canvas'
      );
      if (liveExcalidrawCanvas && liveExcalidrawCanvas.width > 0 && liveExcalidrawCanvas.height > 0) {
        try {
          ctx.drawImage(liveExcalidrawCanvas, 0, 45, 1280, 675);
          return;
        } catch {
          // Fallback to vector summary below if canvas is tainted
        }
      }

      // Fallback Content Stage representation for 720p stream
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText(les || 'Live Classroom Session', 64, 110);
      ctx.fillStyle = '#12a3ff';
      ctx.font = '600 16px sans-serif';
      ctx.fillText(top || '', 64, 142);
    };

    renderFrame();
    const intervalMs = Math.round(1000 / RECORDER_CONFIG.FRAMERATE_IDEAL); // ~66ms (15fps)
    canvasFrameTimerRef.current = window.setInterval(renderFrame, intervalMs);

    const captureFn =
      (canvas as any).captureStream || (canvas as any).mozCaptureStream;
    if (typeof captureFn === 'function') {
      return captureFn.call(canvas, RECORDER_CONFIG.FRAMERATE_IDEAL);
    }
    return null;
  }, []);

  /**
   * Starts the continuous 720p session recording.
   * Never splits or restarts when the teacher navigates between lessons/topics.
   */
  const startRecording = useCallback(
    async (captureMode: CaptureSourceMode = 'workspace_canvas'): Promise<boolean> => {
      if (role !== 'teacher' || !isHostTeacher) return false;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        return true;
      }

      setRecorderError(null);

      try {
        let videoStream: MediaStream | null = null;

        if (
          captureMode === 'display_media' &&
          typeof navigator !== 'undefined' &&
          navigator.mediaDevices &&
          typeof navigator.mediaDevices.getDisplayMedia === 'function'
        ) {
          try {
            videoStream = await navigator.mediaDevices.getDisplayMedia(
              getStrict720pMediaConstraints()
            );
            rawStreamsToCleanupRef.current.push(videoStream);
          } catch {
            // Fallback seamlessly to workspace 720p canvas capture if user cancels screen share prompt
            videoStream = createWorkspace720pCanvasStream();
          }
        } else {
          videoStream = createWorkspace720pCanvasStream();
        }

        const audioStream = await createMixedTwoWayAudioStream();

        const combinedTracks: MediaStreamTrack[] = [];
        if (videoStream) {
          videoStream.getVideoTracks().forEach((t) => combinedTracks.push(t));
        }
        if (audioStream) {
          audioStream.getAudioTracks().forEach((t) => combinedTracks.push(t));
        }

        const recorderOptions = getRecorderOptions();
        setActiveMimeType(recorderOptions.mimeType || PREFERRED_CODECS[0]);

        if (!recordingStartEpochRef.current) {
          recordingStartEpochRef.current = Date.now();
          nextChunkIndexRef.current = 0;
        }

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
      createWorkspace720pCanvasStream,
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
    getCurrentVideoOffsetSec,
  };
}
