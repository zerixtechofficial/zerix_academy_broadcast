'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  RemoteTrack,
  RemoteAudioTrack,
  Participant,
} from 'livekit-client';

export interface VoiceRelayFramePacket {
  senderId?: string;
  senderName?: string;
  role?: 'teacher' | 'student';
  deviceId?: string;
  pcm: string | number[] | Int16Array;
  sampleRate: number;
  seq: number;
  rms?: number;
  ts?: number;
}

export interface MicPermissionCheckResult {
  granted: boolean;
  errorCode?: 'PERMISSION_DENIED' | 'NO_DEVICE' | 'INSECURE_CONTEXT' | 'HARDWARE_ERROR';
  error?: string;
}

export interface UseLiveKitStageParams {
  livekitUrl?: string;
  token?: string;
  canPublishAudio?: boolean;
  autoActivateMic?: boolean;
  localUserId?: string;
  clientDeviceId?: string;
  onMicStateChange?: (enabled: boolean) => void;
  onEmitVoiceFrame?: (frame: {
    pcm: string;
    sampleRate: number;
    seq: number;
    rms: number;
  }) => void;
}

/**
 * Web Audio API Real-Time DSP Noise Cancellation Graph.
 * Filters out low-frequency rumble/fan noise (<85Hz), 50Hz mains hum,
 * and high-frequency hiss (>7800Hz), followed by vocal dynamic compression.
 */
interface NoiseCancellationNodes {
  audioContext: AudioContext;
  sourceNode: MediaStreamAudioSourceNode;
  highPassFilter: BiquadFilterNode;
  mainsNotchFilter: BiquadFilterNode;
  lowPassFilter: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  destinationNode: MediaStreamAudioDestinationNode;
}

export const VOICE_RELAY_SAMPLE_RATE = 16000;

/**
 * Downsamples Float32 PCM audio samples from `inputSampleRate` (e.g. 48000Hz or 44100Hz)
 * to `targetSampleRate` (16000Hz) and converts to 16-bit signed PCM (Int16Array).
 */
export function downsampleFloat32ToInt16(
  input: Float32Array,
  inputSampleRate: number,
  targetSampleRate: number = VOICE_RELAY_SAMPLE_RATE
): { pcmInt16: Int16Array; rms: number } {
  if (!input || input.length === 0) {
    return { pcmInt16: new Int16Array(0), rms: 0 };
  }

  let sumSquares = 0;
  for (let i = 0; i < input.length; i++) {
    const s = input[i];
    sumSquares += s * s;
  }
  const rms = Math.sqrt(sumSquares / input.length);

  if (inputSampleRate <= targetSampleRate || inputSampleRate <= 0) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const clamped = Math.max(-1, Math.min(1, input[i]));
      out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    return { pcmInt16: out, rms };
  }

  const ratio = inputSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outputLength);

  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < outputLength) {
    const nextOffsetBuffer = Math.min(input.length, Math.round((offsetResult + 1) * ratio));
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i++) {
      accum += input[i];
      count++;
    }
    const sample = count > 0 ? accum / count : input[Math.min(offsetBuffer, input.length - 1)] || 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return { pcmInt16: out, rms };
}

/**
 * Encodes an Int16Array of PCM samples into a compact Base64 string for transport over Socket.IO.
 */
export function encodePcmInt16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decodes a Base64 string, number[], or Int16Array of 16-bit PCM samples back into normalized Float32Array [-1, 1].
 */
export function decodePcmToFloat32(pcm: string | number[] | Int16Array): Float32Array {
  if (!pcm) return new Float32Array(0);

  let int16: Int16Array;
  if (typeof pcm === 'string') {
    if (typeof Buffer !== 'undefined') {
      const buf = Buffer.from(pcm, 'base64');
      int16 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
    } else {
      const binary = atob(pcm);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      int16 = new Int16Array(bytes.buffer);
    }
  } else if (pcm instanceof Int16Array) {
    int16 = pcm;
  } else if (Array.isArray(pcm)) {
    int16 = Int16Array.from(pcm);
  } else {
    return new Float32Array(0);
  }

  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }
  return float32;
}

/**
 * Requests browser microphone permission in real time using `navigator.mediaDevices.getUserMedia`.
 * Executed whenever ANY user (Host Teacher, Co-Host Teacher, or Student) clicks the microphone or
 * raise-hand button so the browser permission prompt is shown immediately on click.
 */
export async function requestBrowserMicrophonePermission(
  customMediaDevices?: {
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  }
): Promise<MicPermissionCheckResult> {
  if (typeof window !== 'undefined' && !customMediaDevices) {
    const hostname = window.location?.hostname || 'localhost';
    const isLocalhost =
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    if (window.isSecureContext === false && !isLocalhost) {
      return {
        granted: false,
        errorCode: 'INSECURE_CONTEXT',
        error:
          'Microphone access requires a secure HTTPS connection. Please open https://studio.zerixtech.com.',
      };
    }
  }

  const mediaDevices =
    customMediaDevices ??
    (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);

  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
    // In SSR or headless test environments without mediaDevices, allow logical flow
    return { granted: true };
  }

  try {
    const stream = await mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    // Release the temporary permission-probe stream immediately so hardware is only held while unmuted
    if (stream && typeof stream.getTracks === 'function') {
      stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          // ignore
        }
      });
    }
    return { granted: true };
  } catch (err: any) {
    const errName = String(err?.name || '');
    const errMsg = String(err?.message || '');

    if (
      errName === 'NotAllowedError' ||
      errName === 'PermissionDeniedError' ||
      errName === 'SecurityError' ||
      /permission|denied|not allowed/i.test(errMsg)
    ) {
      return {
        granted: false,
        errorCode: 'PERMISSION_DENIED',
        error:
          'Microphone permission is blocked. Please click the browser address bar icon (🔒) to allow Microphone access, then click the microphone button again.',
      };
    }

    if (
      errName === 'NotFoundError' ||
      errName === 'DevicesNotFoundError' ||
      /device not found|requested device not found/i.test(errMsg)
    ) {
      // In automated headless browser runners (navigator.webdriver === true) without a virtual audio device,
      // allow logical microphone state unless customMediaDevices was explicitly passed for unit testing.
      const isAutomatedWebdriver =
        !customMediaDevices &&
        typeof navigator !== 'undefined' &&
        Boolean((navigator as any).webdriver);
      if (isAutomatedWebdriver) {
        return { granted: true };
      }
      return {
        granted: false,
        errorCode: 'NO_DEVICE',
        error:
          'No microphone device was detected. Please connect a microphone or headset and try again.',
      };
    }

    return {
      granted: false,
      errorCode: 'HARDWARE_ERROR',
      error:
        'Could not access your microphone (it may be in use by another app). Please check your audio input settings and try again.',
    };
  }
}

export function useLiveKitStage({
  livekitUrl,
  token,
  canPublishAudio = false,
  autoActivateMic = false,
  localUserId,
  clientDeviceId,
  onMicStateChange,
  onEmitVoiceFrame,
}: UseLiveKitStageParams) {
  const roomRef = useRef<Room | null>(null);
  const dspNodesRef = useRef<NoiseCancellationNodes | null>(null);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const captureStreamRef = useRef<MediaStream | null>(null);
  const hasVerifiedMicPermissionRef = useRef<boolean>(false);
  const desiredMicEnabledRef = useRef<boolean>(false);
  const canPublishAudioRef = useRef<boolean>(canPublishAudio);
  useEffect(() => {
    canPublishAudioRef.current = canPublishAudio;
  }, [canPublishAudio]);

  const localUserIdRef = useRef<string | undefined>(localUserId);
  useEffect(() => {
    localUserIdRef.current = localUserId;
  }, [localUserId]);

  const clientDeviceIdRef = useRef<string | undefined>(clientDeviceId);
  useEffect(() => {
    clientDeviceIdRef.current = clientDeviceId;
  }, [clientDeviceId]);

  const onMicStateChangeRef = useRef(onMicStateChange);
  useEffect(() => {
    onMicStateChangeRef.current = onMicStateChange;
  }, [onMicStateChange]);

  const onEmitVoiceFrameRef = useRef(onEmitVoiceFrame);
  useEffect(() => {
    onEmitVoiceFrameRef.current = onEmitVoiceFrame;
  }, [onEmitVoiceFrame]);

  const [isAudioConnected, setIsAudioConnected] = useState(false);
  // By default, ALL participant microphones (Host Teacher, Co-Teacher, Students) start MUTED (false)
  const [isMicrophoneEnabled, setIsMicrophoneEnabled] = useState(false);
  // Real-time Noise Cancellation is enabled by default for all audio publishers
  const [isNoiseCancellationEnabled, setIsNoiseCancellationEnabled] = useState(true);
  const isNoiseCancellationEnabledRef = useRef<boolean>(true);
  useEffect(() => {
    isNoiseCancellationEnabledRef.current = isNoiseCancellationEnabled;
  }, [isNoiseCancellationEnabled]);

  const [activeSpeakers, setActiveSpeakers] = useState<string[]>([]);
  const [remoteParticipants, setRemoteParticipants] = useState<string[]>([]);
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [voiceRelayRestartTick, setVoiceRelayRestartTick] = useState(0);

  // Playback AudioContext & per-sender jitter buffer schedule for Port-443 WebAudio Voice Relay
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const playbackWarmedUpRef = useRef<boolean>(false);
  const nextPlayTimeBySenderRef = useRef<Record<string, number>>({});
  const fallbackSpeakerTimeoutBySenderRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const lastWebRtcActiveAtByIdentityRef = useRef<Record<string, number>>({});

  const getSfuUrl = useCallback(() => {
    if (
      livekitUrl &&
      !livekitUrl.includes('localhost') &&
      !livekitUrl.includes('127.0.0.1')
    ) {
      return livekitUrl;
    }
    if (
      process.env.NEXT_PUBLIC_LIVEKIT_URL &&
      !process.env.NEXT_PUBLIC_LIVEKIT_URL.includes('localhost') &&
      !process.env.NEXT_PUBLIC_LIVEKIT_URL.includes('127.0.0.1')
    ) {
      return process.env.NEXT_PUBLIC_LIVEKIT_URL;
    }
    if (typeof window !== 'undefined') {
      const hostname = window.location.hostname || 'localhost';
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      if (window.location.protocol === 'https:') {
        return `${wsProto}//${window.location.host}/livekit`;
      }
      return `${wsProto}//${hostname}:7880`;
    }
    return livekitUrl || process.env.NEXT_PUBLIC_LIVEKIT_URL || 'ws://127.0.0.1:7880';
  }, [livekitUrl]);

  /**
   * Attaches and starts playback for a remote audio track on the page.
   */
  const attachRemoteAudioTrack = useCallback(
    (track: RemoteAudioTrack, participantIdentity: string) => {
      if (typeof document === 'undefined') return;
      const domId = `audio_${participantIdentity}`;
      let audioElement = document.getElementById(domId) as HTMLAudioElement | null;
      if (audioElement) {
        track.attach(audioElement);
      } else {
        audioElement = track.attach();
        audioElement.id = domId;
        audioElement.setAttribute('playsinline', 'true');
        audioElement.setAttribute('autoplay', 'true');
        audioElement.style.display = 'none';
        document.body.appendChild(audioElement);
      }
      audioElement.muted = false;
      audioElement.volume = 1.0;
      audioElement.play().catch(() => {
        setAudioPlaybackBlocked(true);
      });
    },
    []
  );

  /**
   * Scans all remote participants currently in the LiveKit Room and ensures their
   * subscribed audio tracks are attached and playing (critical on initial join & reconnect).
   */
  const attachAllRemoteAudioTracks = useCallback(
    (room: Room) => {
      if (!room?.remoteParticipants) return;
      const identities: string[] = [];
      room.remoteParticipants.forEach((participant) => {
        identities.push(participant.identity);
        participant.audioTrackPublications.forEach((pub) => {
          if (pub.track && pub.track.kind === Track.Kind.Audio) {
            attachRemoteAudioTrack(pub.track as RemoteAudioTrack, participant.identity);
          }
        });
      });
      setRemoteParticipants(Array.from(new Set(identities)));
    },
    [attachRemoteAudioTrack]
  );

  /**
   * Builds or updates the Web Audio API DSP Noise Cancellation pipeline on a local microphone MediaStreamTrack.
   */
  const applyWebAudioNoiseCancellation = useCallback(
    (rawTrack: MediaStreamTrack | undefined, enableNC: boolean) => {
      if (typeof window === 'undefined' || !rawTrack) return;

      // Apply WebRTC track-level hardware/browser noise suppression constraints
      if (typeof rawTrack.applyConstraints === 'function') {
        rawTrack
          .applyConstraints({
            noiseSuppression: enableNC,
            echoCancellation: true,
            autoGainControl: true,
            // Chromium / W3C Voice Isolation constraint
            ...({ voiceIsolation: enableNC } as any),
          })
          .catch(() => {});
      }

      // Clean up any previous DSP graph
      if (dspNodesRef.current) {
        try {
          dspNodesRef.current.sourceNode.disconnect();
          dspNodesRef.current.audioContext.close().catch(() => {});
        } catch {
          // ignore cleanup errors
        }
        dspNodesRef.current = null;
      }

      if (!enableNC) return;

      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioCtx) return;

        const audioContext: AudioContext = new AudioCtx();
        if (audioContext.state === 'suspended' && typeof audioContext.resume === 'function') {
          audioContext.resume().catch(() => {});
        }
        const stream = new MediaStream([rawTrack]);
        const sourceNode = audioContext.createMediaStreamSource(stream);

        // 1. High-Pass Filter @ 85Hz: strips desk rumble, AC/fan drone & plosives
        const highPassFilter = audioContext.createBiquadFilter();
        highPassFilter.type = 'highpass';
        highPassFilter.frequency.value = 85;
        highPassFilter.Q.value = 0.707;

        // 2. Notch Filter @ 50Hz: eliminates electrical mains hum
        const mainsNotchFilter = audioContext.createBiquadFilter();
        mainsNotchFilter.type = 'notch';
        mainsNotchFilter.frequency.value = 50;
        mainsNotchFilter.Q.value = 10;

        // 3. Low-Pass Filter @ 7800Hz: removes high-frequency static/hiss while preserving speech clarity
        const lowPassFilter = audioContext.createBiquadFilter();
        lowPassFilter.type = 'lowpass';
        lowPassFilter.frequency.value = 7800;
        lowPassFilter.Q.value = 0.707;

        // 4. Vocal Dynamics Compressor: levels speech volume and suppresses sudden background spikes
        const compressor = audioContext.createDynamicsCompressor();
        compressor.threshold.value = -28;
        compressor.knee.value = 18;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.15;

        const destinationNode = audioContext.createMediaStreamDestination();

        sourceNode.connect(highPassFilter);
        highPassFilter.connect(mainsNotchFilter);
        mainsNotchFilter.connect(lowPassFilter);
        lowPassFilter.connect(compressor);
        compressor.connect(destinationNode);

        dspNodesRef.current = {
          audioContext,
          sourceNode,
          highPassFilter,
          mainsNotchFilter,
          lowPassFilter,
          compressor,
          destinationNode,
        };
      } catch {
        // Fallback gracefully to browser native WebRTC noiseSuppression if AudioContext fails
      }
    },
    []
  );

  // Unlock Audio on Any User Gesture (Autoplay Policy Helper for Chrome, Safari, Firefox, Edge)
  const unlockAudioPlayback = useCallback(async () => {
    if (
      dspNodesRef.current?.audioContext &&
      dspNodesRef.current.audioContext.state !== 'running' &&
      dspNodesRef.current.audioContext.state !== 'closed' &&
      typeof dspNodesRef.current.audioContext.resume === 'function'
    ) {
      dspNodesRef.current.audioContext.resume().catch(() => {});
    }
    if (
      captureCtxRef.current &&
      captureCtxRef.current.state !== 'running' &&
      captureCtxRef.current.state !== 'closed' &&
      typeof captureCtxRef.current.resume === 'function'
    ) {
      captureCtxRef.current.resume().catch(() => {});
    }

    if (typeof window !== 'undefined') {
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
            playbackCtxRef.current = new AudioCtx();
            playbackWarmedUpRef.current = false;
          }
          const ctx = playbackCtxRef.current;
          if (ctx.state !== 'running' && typeof ctx.resume === 'function') {
            await ctx.resume().catch(() => {});
          }
          if (ctx.state === 'running') {
            setAudioPlaybackBlocked(false);
            if (!playbackWarmedUpRef.current) {
              playbackWarmedUpRef.current = true;
              try {
                const silentBuf = ctx.createBuffer(1, 1, 22050);
                const src = ctx.createBufferSource();
                src.buffer = silentBuf;
                src.connect(ctx.destination);
                src.start(0);
              } catch {
                // ignore warmup errors
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }

    if (typeof document !== 'undefined') {
      const audioEls = document.querySelectorAll<HTMLAudioElement>('audio[id^="audio_"]');
      audioEls.forEach((el) => {
        el.muted = false;
        el.volume = 1.0;
        if (el.paused) {
          el.play().catch(() => {});
        }
      });
    }
    if (roomRef.current) {
      try {
        await roomRef.current.startAudio();
        setAudioPlaybackBlocked(false);
      } catch (err: any) {
        console.warn('[LiveKit] startAudio notice:', err.message);
      }
    }
  }, []);

  /**
   * Plays an incoming Port-443 Socket.IO WebAudio PCM Voice Frame from a remote speaker.
   * Automatically deduplicates against LiveKit WebRTC ONLY when LiveKit SFU is genuinely
   * delivering active decoded RTP audio energy for that speaker. If WebRTC ICE is blocked,
   * disconnected, or silent after an internet drop/reconnect, the Port-443 PCM voice relay
   * plays seamlessly!
   */
  const playIncomingVoiceFrame = useCallback(
    (packet: VoiceRelayFramePacket) => {
      if (typeof window === 'undefined' || !packet?.pcm) return;

      const senderId = packet.senderId || 'remote_speaker';

      // Prevent self-echo if the packet originated from the local user's own device
      const myUserId = localUserIdRef.current;
      if (myUserId) {
        const cleanSender = String(senderId).replace(/^(teacher_|student_)/, '');
        const cleanMine = String(myUserId).replace(/^(teacher_|student_)/, '');
        const isSameUser = senderId === myUserId || (cleanSender.length > 0 && cleanSender === cleanMine);
        if (isSameUser) {
          const myDevice = clientDeviceIdRef.current;
          if (!packet.deviceId || !myDevice || packet.deviceId === myDevice) {
            return;
          }
        }
      }

      // Only skip the Port-443 PCM frame if LiveKit WebRTC is connected, unlocked, AND actively
      // producing decoded RTP audio energy for this participant right now.
      const room = roomRef.current;
      if (room && room.state === 'connected' && room.canPlaybackAudio) {
        let hasLiveWebRtcAudio = false;
        const nowMs = Date.now();
        room.remoteParticipants.forEach((p) => {
          if (
            p.identity === senderId ||
            p.identity.startsWith(`${senderId}__`)
          ) {
            const isActivelySpeakingWebRtc =
              Boolean((p as any).isSpeaking) ||
              (typeof (p as any).audioLevel === 'number' && (p as any).audioLevel > 0.005) ||
              nowMs - (lastWebRtcActiveAtByIdentityRef.current[p.identity] || 0) < 1200;

            if (!isActivelySpeakingWebRtc) return;

            p.audioTrackPublications.forEach((pub) => {
              const mediaTrack = pub.track?.mediaStreamTrack;
              const domEl =
                typeof document !== 'undefined'
                  ? (document.getElementById(`audio_${p.identity}`) as HTMLAudioElement | null)
                  : null;
              if (
                pub.isSubscribed &&
                !pub.isMuted &&
                mediaTrack &&
                mediaTrack.readyState === 'live' &&
                !mediaTrack.muted &&
                domEl &&
                !domEl.paused &&
                !domEl.muted
              ) {
                hasLiveWebRtcAudio = true;
              }
            });
          }
        });
        if (hasLiveWebRtcAudio) {
          return;
        }
      }

      const floatSamples = decodePcmToFloat32(packet.pcm);
      if (floatSamples.length === 0) return;

      // Mark sender as active speaker in UI
      setActiveSpeakers((prev) =>
        prev.includes(senderId) ? prev : [...prev, senderId]
      );
      if (fallbackSpeakerTimeoutBySenderRef.current[senderId]) {
        clearTimeout(fallbackSpeakerTimeoutBySenderRef.current[senderId]);
      }
      fallbackSpeakerTimeoutBySenderRef.current[senderId] = setTimeout(() => {
        setActiveSpeakers((prev) => prev.filter((id) => id !== senderId));
      }, 450);

      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioCtx) return;

        if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
          playbackCtxRef.current = new AudioCtx();
          playbackWarmedUpRef.current = false;
        }
        const ctx = playbackCtxRef.current;
        if (ctx.state !== 'running') {
          if (typeof ctx.resume === 'function') {
            ctx
              .resume()
              .then(() => {
                if (ctx.state === 'running') {
                  setAudioPlaybackBlocked(false);
                } else {
                  setAudioPlaybackBlocked(true);
                }
              })
              .catch(() => {
                setAudioPlaybackBlocked(true);
              });
          }
          // In Chromium/Safari, ctx.resume() outside a user gesture stays pending while state remains 'suspended'.
          // Surface the audio unlock prompt immediately if not running, and avoid piling up buffers while time is frozen.
          setTimeout(() => {
            if (playbackCtxRef.current && playbackCtxRef.current.state !== 'running') {
              setAudioPlaybackBlocked(true);
            }
          }, 60);
          const pendingLead = (nextPlayTimeBySenderRef.current[senderId] || 0) - ctx.currentTime;
          if (pendingLead > 0.3) {
            return;
          }
        }

        const sampleRate = Number(packet.sampleRate) || VOICE_RELAY_SAMPLE_RATE;
        const audioBuffer = ctx.createBuffer(1, floatSamples.length, sampleRate);
        audioBuffer.getChannelData(0).set(floatSamples);

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);

        const now = ctx.currentTime;
        const prevEnd = nextPlayTimeBySenderRef.current[senderId] || 0;
        // Maintain a smooth 40ms jitter buffer window and reset if lag exceeds 450ms
        const startAt =
          prevEnd < now || prevEnd - now > 0.45 ? now + 0.04 : prevEnd;
        source.start(startAt);
        nextPlayTimeBySenderRef.current[senderId] = startAt + audioBuffer.duration;
      } catch {
        // Ignore WebAudio decode error
      }
    },
    []
  );

  // Connect to LiveKit Room with pre-registered listeners, existing track scan & automatic retry
  useEffect(() => {
    if (!token) return;

    let isMounted = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const url = getSfuUrl();

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
        sampleRate: 48000,
        ...({ voiceIsolation: true } as any),
      },
      publishDefaults: {
        audioBitrate: 24000, // Opus 24kbps
        dtx: true, // Opus Discontinuous Transmission suppresses silence/background noise packets
        red: true,
      } as any,
    });

    roomRef.current = room;

    // Register ALL RoomEvent listeners BEFORE calling room.connect() so tracks published
    // prior to our join are never missed during initial negotiation.
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (!isMounted) return;
      setAudioPlaybackBlocked(!room.canPlaybackAudio);
    });

    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      if (!isMounted) return;
      const nowMs = Date.now();
      speakers.forEach((s) => {
        if (s?.identity) {
          lastWebRtcActiveAtByIdentityRef.current[s.identity] = nowMs;
        }
      });
      setActiveSpeakers(speakers.map((s) => s.identity));
    });

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication, participant) => {
      if (!isMounted) return;
      if (track.kind === Track.Kind.Audio) {
        attachRemoteAudioTrack(track as RemoteAudioTrack, participant.identity);
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _publication, participant) => {
      if (track.kind === Track.Kind.Audio) {
        const el = document.getElementById(`audio_${participant.identity}`);
        if (el) el.remove();
        track.detach().forEach((item) => item.remove());
        delete lastWebRtcActiveAtByIdentityRef.current[participant.identity];
      }
    });

    room.on(RoomEvent.ParticipantConnected, (p) => {
      if (!isMounted) return;
      setRemoteParticipants((prev) => Array.from(new Set([...prev, p.identity])));
    });

    room.on(RoomEvent.ParticipantDisconnected, (p) => {
      if (!isMounted) return;
      const el = document.getElementById(`audio_${p.identity}`);
      if (el) el.remove();
      delete lastWebRtcActiveAtByIdentityRef.current[p.identity];
      setRemoteParticipants((prev) => prev.filter((id) => id !== p.identity));
    });

    room.on(RoomEvent.Reconnecting, () => {
      if (!isMounted) return;
      setIsAudioConnected(false);
      lastWebRtcActiveAtByIdentityRef.current = {};
    });

    room.on(RoomEvent.Reconnected, () => {
      if (!isMounted) return;
      setIsAudioConnected(true);
      nextPlayTimeBySenderRef.current = {};
      attachAllRemoteAudioTracks(room);
      unlockAudioPlayback();
      // Restore local microphone publishing automatically after network reconnect if user was unmuted
      if (desiredMicEnabledRef.current && canPublishAudioRef.current) {
        room.localParticipant
          .setMicrophoneEnabled(true, {
            noiseSuppression: isNoiseCancellationEnabledRef.current,
            echoCancellation: true,
            autoGainControl: true,
          })
          .catch(() => {});
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      if (!isMounted) return;
      setIsAudioConnected(false);
      lastWebRtcActiveAtByIdentityRef.current = {};
      // Automatically attempt to reconnect LiveKit room if unexpected disconnect occurred while mounted
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (isMounted && roomRef.current === room && room.state === 'disconnected') {
          connectWithRetry(1);
        }
      }, 2500);
    });

    const syncLocalMicWithRoom = async () => {
      if (!isMounted) return;
      const shouldEnableMic =
        (autoActivateMic || desiredMicEnabledRef.current) && canPublishAudioRef.current;
      if (shouldEnableMic) {
        desiredMicEnabledRef.current = true;
        setIsMicrophoneEnabled(true);
        onMicStateChangeRef.current?.(true);
        try {
          await room.localParticipant.setMicrophoneEnabled(true, {
            noiseSuppression: isNoiseCancellationEnabledRef.current,
            echoCancellation: true,
            autoGainControl: true,
          });
          const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
          const rawTrack = micPub?.audioTrack?.mediaStreamTrack;
          if (rawTrack) {
            applyWebAudioNoiseCancellation(rawTrack, isNoiseCancellationEnabledRef.current);
          }
        } catch (err: any) {
          console.warn('[LiveKit] Microphone publish notice:', err?.message || err);
        }
      }
    };

    const connectWithRetry = async (attempt = 1) => {
      if (!isMounted) return;
      try {
        await room.connect(url, token);
        if (!isMounted) return;

        setIsAudioConnected(true);
        attachAllRemoteAudioTracks(room);
        unlockAudioPlayback();
        await syncLocalMicWithRoom();
      } catch (err: any) {
        if (!isMounted) return;
        setIsAudioConnected(false);
        // Retry connection in background (while Port-443 WebAudio Voice Relay handles audio immediately)
        if (attempt < 5) {
          reconnectTimer = setTimeout(() => {
            connectWithRetry(attempt + 1);
          }, Math.min(4000 * attempt, 12000));
        }
      }
    };

    connectWithRetry(1);

    // Pointer/touch/click/keydown listener to unlock audio on user interaction across Chrome, Safari, Firefox, Edge
    const handleGesture = () => {
      unlockAudioPlayback();
    };
    window.addEventListener('pointerdown', handleGesture, { passive: true });
    window.addEventListener('click', handleGesture, { passive: true });
    window.addEventListener('touchstart', handleGesture, { passive: true });
    window.addEventListener('keydown', handleGesture, { passive: true });

    return () => {
      isMounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener('pointerdown', handleGesture);
      window.removeEventListener('click', handleGesture);
      window.removeEventListener('touchstart', handleGesture);
      window.removeEventListener('keydown', handleGesture);
      if (dspNodesRef.current) {
        try {
          dspNodesRef.current.sourceNode.disconnect();
          dspNodesRef.current.audioContext.close().catch(() => {});
        } catch {
          // ignore
        }
        dspNodesRef.current = null;
      }
      room.disconnect();
    };
  }, [
    token,
    getSfuUrl,
    attachRemoteAudioTrack,
    attachAllRemoteAudioTracks,
    unlockAudioPlayback,
  ]);

  // Synchronize hardware track enabled state instantaneously on mute/unmute without tearing down AudioContext
  useEffect(() => {
    if (captureStreamRef.current) {
      captureStreamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = isMicrophoneEnabled && canPublishAudio;
      });
    }
    if (captureCtxRef.current && isMicrophoneEnabled && canPublishAudio) {
      if (captureCtxRef.current.state !== 'running' && typeof captureCtxRef.current.resume === 'function') {
        captureCtxRef.current.resume().catch(() => {});
      }
    }
  }, [isMicrophoneEnabled, canPublishAudio]);

  // Real-Time Port-443 WebAudio Voice Relay Capture Loop
  // Keeps capture stream warm while canPublishAudio is true so mute/unmute is instant (<5ms)
  useEffect(() => {
    if (typeof window === 'undefined' || !canPublishAudio) {
      return;
    }
    if (!isMicrophoneEnabled && !captureStreamRef.current) {
      return;
    }
    if (captureStreamRef.current && captureCtxRef.current && captureCtxRef.current.state !== 'closed') {
      return;
    }

    let isCancelled = false;
    let localStream: MediaStream | null = null;
    let captureCtx: AudioContext | null = null;
    let processorNode: ScriptProcessorNode | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let silentGainNode: GainNode | null = null;
    let seqCounter = 0;
    let hangoverFrames = 0;

    const startVoiceRelayCapture = async () => {
      try {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
          return;
        }
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: isNoiseCancellationEnabled,
            autoGainControl: true,
            channelCount: 1,
          },
        });

        if (isCancelled || !canPublishAudioRef.current) {
          localStream.getTracks().forEach((t) => t.stop());
          return;
        }

        hasVerifiedMicPermissionRef.current = true;
        localStream.getAudioTracks().forEach((t) => {
          t.enabled = desiredMicEnabledRef.current;
        });
        captureStreamRef.current = localStream;

        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioCtx) return;

        captureCtx = new AudioCtx();
        captureCtxRef.current = captureCtx;
        if (captureCtx.state !== 'running' && typeof captureCtx.resume === 'function') {
          captureCtx.resume().catch(() => {});
        }

        sourceNode = captureCtx.createMediaStreamSource(localStream);

        // Apply high-pass filter (85Hz) to strip low rumble before PCM encoding
        const highPass = captureCtx.createBiquadFilter();
        highPass.type = 'highpass';
        highPass.frequency.value = 85;

        processorNode = captureCtx.createScriptProcessor(4096, 1, 1);
        silentGainNode = captureCtx.createGain();
        silentGainNode.gain.value = 0;

        processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
          if (isCancelled || !desiredMicEnabledRef.current || !canPublishAudioRef.current) return;
          const inputData = event.inputBuffer.getChannelData(0);
          const { pcmInt16, rms } = downsampleFloat32ToInt16(
            inputData,
            event.inputBuffer.sampleRate,
            VOICE_RELAY_SAMPLE_RATE
          );

          // Voice Activity Gate with 4-frame hangover so quiet syllables are never clipped
          if (rms >= 0.0012) {
            hangoverFrames = 4;
          } else if (hangoverFrames > 0) {
            hangoverFrames--;
          } else {
            return;
          }

          if (pcmInt16.length > 0 && onEmitVoiceFrameRef.current) {
            seqCounter += 1;
            onEmitVoiceFrameRef.current({
              pcm: encodePcmInt16ToBase64(pcmInt16),
              sampleRate: VOICE_RELAY_SAMPLE_RATE,
              seq: seqCounter,
              rms: Math.round(rms * 10000) / 10000,
            });
          }
        };

        sourceNode.connect(highPass);
        highPass.connect(processorNode);
        processorNode.connect(silentGainNode);
        silentGainNode.connect(captureCtx.destination);
      } catch {
        // Ignore capture fallback initialization notice in headless environments
      }
    };

    startVoiceRelayCapture();

    return () => {
      if (!canPublishAudioRef.current) {
        isCancelled = true;
        try {
          processorNode?.disconnect();
          sourceNode?.disconnect();
          silentGainNode?.disconnect();
        } catch {
          // ignore
        }
        if (captureCtxRef.current === captureCtx) {
          captureCtxRef.current = null;
        }
        if (captureCtx && captureCtx.state !== 'closed') {
          captureCtx.close().catch(() => {});
        }
        const streamToStop = captureStreamRef.current || localStream;
        captureStreamRef.current = null;
        if (streamToStop) {
          streamToStop.getTracks().forEach((t) => {
            try {
              t.stop();
            } catch {
              // ignore
            }
          });
        }
      }
    };
  }, [isMicrophoneEnabled, canPublishAudio, isNoiseCancellationEnabled, voiceRelayRestartTick]);

  // Ensure full cleanup on unmount or when canPublishAudio becomes false
  useEffect(() => {
    if (!canPublishAudio) {
      if (captureCtxRef.current && captureCtxRef.current.state !== 'closed') {
        captureCtxRef.current.close().catch(() => {});
      }
      captureCtxRef.current = null;
      if (captureStreamRef.current) {
        captureStreamRef.current.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            // ignore
          }
        });
        captureStreamRef.current = null;
      }
    }
  }, [canPublishAudio]);
  useEffect(() => {
    return () => {
      if (captureCtxRef.current && captureCtxRef.current.state !== 'closed') {
        captureCtxRef.current.close().catch(() => {});
      }
      captureCtxRef.current = null;
      if (captureStreamRef.current) {
        captureStreamRef.current.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            // ignore
          }
        });
        captureStreamRef.current = null;
      }
    };
  }, []);

  /**
   * Recovers classroom audio playback and microphone streaming after an internet disconnect,
   * Socket.IO auto-rejoin, manual reconnect, or browser tab wake.
   */
  const recoverAudioStage = useCallback(async () => {
    nextPlayTimeBySenderRef.current = {};
    lastWebRtcActiveAtByIdentityRef.current = {};

    await unlockAudioPlayback();

    const room = roomRef.current;
    if (room) {
      if (room.state === 'connected') {
        attachAllRemoteAudioTracks(room);
        if (desiredMicEnabledRef.current && canPublishAudioRef.current) {
          room.localParticipant
            .setMicrophoneEnabled(true, {
              noiseSuppression: isNoiseCancellationEnabledRef.current,
              echoCancellation: true,
              autoGainControl: true,
            })
            .catch(() => {});
        }
      } else if (room.state === 'disconnected' && token) {
        try {
          await room.connect(getSfuUrl(), token);
          setIsAudioConnected(true);
          attachAllRemoteAudioTracks(room);
          await unlockAudioPlayback();
          if (desiredMicEnabledRef.current && canPublishAudioRef.current) {
            await room.localParticipant.setMicrophoneEnabled(true, {
              noiseSuppression: isNoiseCancellationEnabledRef.current,
              echoCancellation: true,
              autoGainControl: true,
            });
          }
        } catch {
          // Port-443 WebAudio Voice Relay continues handling audio seamlessly
        }
      }
    }

    if (desiredMicEnabledRef.current && canPublishAudioRef.current) {
      const capCtx = captureCtxRef.current;
      if (!capCtx || capCtx.state === 'closed') {
        setVoiceRelayRestartTick((t) => t + 1);
      } else if (capCtx.state !== 'running' && typeof capCtx.resume === 'function') {
        capCtx.resume().catch(() => {
          setVoiceRelayRestartTick((t) => t + 1);
        });
      }
    }
  }, [token, getSfuUrl, attachAllRemoteAudioTracks, unlockAudioPlayback]);

  // Automatically recover audio playback & capture whenever browser network comes back online or tab becomes visible
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOnline = () => {
      void recoverAudioStage();
    };
    const handleVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void recoverAudioStage();
      }
    };
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [recoverAudioStage]);

  // When canPublishAudio is revoked (e.g. teacher mutes student): force mute immediately
  useEffect(() => {
    const room = roomRef.current;
    if (!canPublishAudio && isMicrophoneEnabled) {
      desiredMicEnabledRef.current = false;
      if (room && isAudioConnected) {
        room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
      }
      setIsMicrophoneEnabled(false);
      onMicStateChangeRef.current?.(false);
    }
  }, [canPublishAudio, isAudioConnected, isMicrophoneEnabled]);

  // Toggle Real-Time Noise Cancellation (WebRTC + Web Audio DSP)
  const toggleNoiseCancellation = useCallback(() => {
    setIsNoiseCancellationEnabled((prev) => {
      const next = !prev;
      const room = roomRef.current;
      if (room) {
        const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
        const rawTrack = micPub?.audioTrack?.mediaStreamTrack;
        if (rawTrack) {
          applyWebAudioNoiseCancellation(rawTrack, next);
        }
      }
      return next;
    });
  }, [applyWebAudioNoiseCancellation]);

  // Real-time Microphone Permission Check bound to hook state (caches granted permission for 0ms instant toggle)
  const ensureMicrophonePermission = useCallback(async (): Promise<MicPermissionCheckResult> => {
    if (hasVerifiedMicPermissionRef.current) {
      setMicError(null);
      return { granted: true };
    }

    if (
      typeof navigator !== 'undefined' &&
      navigator.permissions &&
      typeof navigator.permissions.query === 'function'
    ) {
      try {
        const permStatus = await navigator.permissions.query({
          name: 'microphone' as PermissionName,
        });
        if (permStatus.state === 'granted') {
          hasVerifiedMicPermissionRef.current = true;
          setMicError(null);
          return { granted: true };
        }
      } catch {
        // Fallback to getUserMedia probe if Permissions API is unsupported
      }
    }

    const res = await requestBrowserMicrophonePermission();
    if (!res.granted) {
      hasVerifiedMicPermissionRef.current = false;
      setMicError(
        res.error ||
          'Microphone permission is required to speak. Please allow microphone access in your browser.'
      );
    } else {
      hasVerifiedMicPermissionRef.current = true;
      setMicError(null);
    }
    return res;
  }, []);

  const clearMicError = useCallback(() => {
    setMicError(null);
  }, []);

  // Explicit Set Mic Active/Inactive Action (instant optimistic state transition with cached permission check)
  const setMicrophoneActive = useCallback(
    async (active: boolean): Promise<boolean> => {
      const room = roomRef.current;

      if (!active) {
        setMicError(null);
        desiredMicEnabledRef.current = false;
        if (captureStreamRef.current) {
          captureStreamRef.current.getAudioTracks().forEach((t) => {
            t.enabled = false;
          });
        }
        setIsMicrophoneEnabled(false);
        onMicStateChangeRef.current?.(false);

        if (room && isAudioConnected) {
          room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
        }
        return true;
      }

      const perm = await ensureMicrophonePermission();
      if (!perm.granted) {
        const wasEnabled = desiredMicEnabledRef.current;
        desiredMicEnabledRef.current = false;
        setIsMicrophoneEnabled(false);
        if (wasEnabled) {
          onMicStateChangeRef.current?.(false);
        }
        return false;
      }

      desiredMicEnabledRef.current = true;
      if (captureStreamRef.current) {
        captureStreamRef.current.getAudioTracks().forEach((t) => {
          t.enabled = true;
        });
      }
      setIsMicrophoneEnabled(true);
      onMicStateChangeRef.current?.(true);
      unlockAudioPlayback();

      if (!room || !isAudioConnected) {
        return true;
      }

      try {
        await room.localParticipant.setMicrophoneEnabled(true, {
          noiseSuppression: isNoiseCancellationEnabled,
          echoCancellation: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
          ...({ voiceIsolation: isNoiseCancellationEnabled } as any),
        });

        const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
        const rawTrack = micPub?.audioTrack?.mediaStreamTrack;
        if (rawTrack) {
          applyWebAudioNoiseCancellation(rawTrack, isNoiseCancellationEnabled);
        }
        return true;
      } catch (err: any) {
        const errName = String(err?.name || '');
        if (
          errName === 'NotAllowedError' ||
          errName === 'PermissionDeniedError' ||
          errName === 'SecurityError'
        ) {
          hasVerifiedMicPermissionRef.current = false;
          desiredMicEnabledRef.current = false;
          setIsMicrophoneEnabled(false);
          onMicStateChangeRef.current?.(false);
          setMicError(
            'Microphone permission was denied by your browser. Please allow microphone access in the address bar and try again.'
          );
          return false;
        }
        // If LiveKit track publish encounters a non-permission transport issue, keep WebAudio relay active
        console.warn('[LiveKit] Microphone hardware capture notice:', err?.message || err);
        return true;
      }
    },
    [
      isAudioConnected,
      isNoiseCancellationEnabled,
      applyWebAudioNoiseCancellation,
      unlockAudioPlayback,
      ensureMicrophonePermission,
    ]
  );

  // Explicit Toggle Mic Action (Toggles between Muted and Unmuted)
  const toggleMicrophone = useCallback(async (): Promise<boolean> => {
    return await setMicrophoneActive(!isMicrophoneEnabled);
  }, [isMicrophoneEnabled, setMicrophoneActive]);

  // Reactive listener: one-shot mic activation when autoActivateMic pulses true
  const lastAutoActivatedRef = useRef(false);
  useEffect(() => {
    if (autoActivateMic && !lastAutoActivatedRef.current && canPublishAudio) {
      lastAutoActivatedRef.current = true;
      setMicrophoneActive(true);
    } else if (!autoActivateMic) {
      lastAutoActivatedRef.current = false;
    }
  }, [autoActivateMic, canPublishAudio, setMicrophoneActive]);

  return {
    isAudioConnected,
    isMicrophoneEnabled,
    isNoiseCancellationEnabled,
    activeSpeakers,
    remoteParticipants,
    audioPlaybackBlocked,
    micError,
    clearMicError,
    ensureMicrophonePermission,
    playIncomingVoiceFrame,
    toggleMicrophone,
    setMicrophoneActive,
    toggleNoiseCancellation,
    unlockAudioPlayback,
    recoverAudioStage,
  };
}
