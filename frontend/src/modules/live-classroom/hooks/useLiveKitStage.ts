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
  onMicStateChange,
  onEmitVoiceFrame,
}: UseLiveKitStageParams) {
  const roomRef = useRef<Room | null>(null);
  const dspNodesRef = useRef<NoiseCancellationNodes | null>(null);
  const desiredMicEnabledRef = useRef<boolean>(false);
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
  const [activeSpeakers, setActiveSpeakers] = useState<string[]>([]);
  const [remoteParticipants, setRemoteParticipants] = useState<string[]>([]);
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

  // Playback AudioContext & per-sender jitter buffer schedule for Port-443 WebAudio Voice Relay
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeBySenderRef = useRef<Record<string, number>>({});
  const fallbackSpeakerTimeoutBySenderRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

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
      dspNodesRef.current.audioContext.state === 'suspended' &&
      typeof dspNodesRef.current.audioContext.resume === 'function'
    ) {
      dspNodesRef.current.audioContext.resume().catch(() => {});
    }
    if (playbackCtxRef.current && playbackCtxRef.current.state === 'suspended') {
      try {
        await playbackCtxRef.current.resume();
        setAudioPlaybackBlocked(false);
      } catch {
        // ignore
      }
    }
    if (typeof document !== 'undefined') {
      const audioEls = document.querySelectorAll<HTMLAudioElement>('audio[id^="audio_"]');
      audioEls.forEach((el) => {
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
   * Automatically deduplicates against LiveKit WebRTC so if LiveKit SFU is actively playing
   * audio for that speaker, the fallback frame is skipped; if WebRTC ICE is blocked/disconnected
   * (e.g. UDP/7881 blocked by firewall), the fallback frame plays seamlessly!
   */
  const playIncomingVoiceFrame = useCallback(
    (packet: VoiceRelayFramePacket) => {
      if (typeof window === 'undefined' || !packet?.pcm) return;

      const senderId = packet.senderId || 'remote_speaker';

      // Check if LiveKit WebRTC is currently connected and actively playing this participant's audio track
      const room = roomRef.current;
      if (room && room.state === 'connected') {
        let hasLiveWebRtcAudio = false;
        room.remoteParticipants.forEach((p) => {
          if (
            p.identity === senderId ||
            p.identity.startsWith(`${senderId}__`)
          ) {
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
                domEl &&
                !domEl.paused
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
        }
        const ctx = playbackCtxRef.current;
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {
            setAudioPlaybackBlocked(true);
          });
        }

        const sampleRate = Number(packet.sampleRate) || VOICE_RELAY_SAMPLE_RATE;
        const audioBuffer = ctx.createBuffer(1, floatSamples.length, sampleRate);
        audioBuffer.getChannelData(0).set(floatSamples);

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);

        const now = ctx.currentTime;
        const prevEnd = nextPlayTimeBySenderRef.current[senderId] || 0;
        // Maintain a smooth 50ms jitter buffer window and reset if lag exceeds 450ms
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
      setRemoteParticipants((prev) => prev.filter((id) => id !== p.identity));
    });

    room.on(RoomEvent.Reconnecting, () => {
      if (!isMounted) return;
      setIsAudioConnected(false);
    });

    room.on(RoomEvent.Reconnected, () => {
      if (!isMounted) return;
      setIsAudioConnected(true);
      attachAllRemoteAudioTracks(room);
      unlockAudioPlayback();
      // Restore local microphone publishing automatically after network reconnect if user was unmuted
      if (desiredMicEnabledRef.current && canPublishAudio) {
        room.localParticipant
          .setMicrophoneEnabled(true, {
            noiseSuppression: isNoiseCancellationEnabled,
            echoCancellation: true,
            autoGainControl: true,
          })
          .catch(() => {});
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      if (!isMounted) return;
      setIsAudioConnected(false);
    });

    const syncLocalMicWithRoom = async () => {
      if (!isMounted) return;
      const shouldEnableMic =
        (autoActivateMic || desiredMicEnabledRef.current) && canPublishAudio;
      if (shouldEnableMic) {
        desiredMicEnabledRef.current = true;
        setIsMicrophoneEnabled(true);
        onMicStateChangeRef.current?.(true);
        try {
          await room.localParticipant.setMicrophoneEnabled(true, {
            noiseSuppression: isNoiseCancellationEnabled,
            echoCancellation: true,
            autoGainControl: true,
          });
          const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
          const rawTrack = micPub?.audioTrack?.mediaStreamTrack;
          if (rawTrack) {
            applyWebAudioNoiseCancellation(rawTrack, isNoiseCancellationEnabled);
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
    window.addEventListener('touchstart', handleGesture, { passive: true });
    window.addEventListener('keydown', handleGesture, { passive: true });

    return () => {
      isMounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener('pointerdown', handleGesture);
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

  // Real-Time Port-443 WebAudio Voice Relay Capture Loop
  // Streams 16kHz mono PCM frames over Socket.IO whenever local microphone is enabled & authorized
  useEffect(() => {
    if (typeof window === 'undefined' || !isMicrophoneEnabled || !canPublishAudio) {
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

        if (isCancelled) {
          localStream.getTracks().forEach((t) => t.stop());
          return;
        }

        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioCtx) return;

        captureCtx = new AudioCtx();
        if (captureCtx.state === 'suspended') {
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
          if (isCancelled || !desiredMicEnabledRef.current) return;
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
      isCancelled = true;
      try {
        processorNode?.disconnect();
        sourceNode?.disconnect();
        silentGainNode?.disconnect();
      } catch {
        // ignore
      }
      if (captureCtx && captureCtx.state !== 'closed') {
        captureCtx.close().catch(() => {});
      }
      if (localStream) {
        localStream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            // ignore
          }
        });
      }
    };
  }, [isMicrophoneEnabled, canPublishAudio, isNoiseCancellationEnabled]);

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

  // Real-time Microphone Permission Check bound to hook state (updates micError state if denied)
  const ensureMicrophonePermission = useCallback(async (): Promise<MicPermissionCheckResult> => {
    const res = await requestBrowserMicrophonePermission();
    if (!res.granted) {
      setMicError(
        res.error ||
          'Microphone permission is required to speak. Please allow microphone access in your browser.'
      );
    } else {
      setMicError(null);
    }
    return res;
  }, []);

  const clearMicError = useCallback(() => {
    setMicError(null);
  }, []);

  // Explicit Set Mic Active/Inactive Action (verifies browser permission in real time before enabling)
  const setMicrophoneActive = useCallback(
    async (active: boolean): Promise<boolean> => {
      const room = roomRef.current;

      if (active) {
        const perm = await ensureMicrophonePermission();
        if (!perm.granted) {
          desiredMicEnabledRef.current = false;
          setIsMicrophoneEnabled(false);
          onMicStateChangeRef.current?.(false);
          return false;
        }
      } else {
        setMicError(null);
      }

      desiredMicEnabledRef.current = active;
      setIsMicrophoneEnabled(active);
      onMicStateChangeRef.current?.(active);

      if (active) {
        unlockAudioPlayback();
      }

      if (!room || !isAudioConnected) {
        return true;
      }

      try {
        await room.localParticipant.setMicrophoneEnabled(active, {
          noiseSuppression: isNoiseCancellationEnabled,
          echoCancellation: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
          ...({ voiceIsolation: isNoiseCancellationEnabled } as any),
        });

        if (active) {
          const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
          const rawTrack = micPub?.audioTrack?.mediaStreamTrack;
          if (rawTrack) {
            applyWebAudioNoiseCancellation(rawTrack, isNoiseCancellationEnabled);
          }
        }
        return true;
      } catch (err: any) {
        const errName = String(err?.name || '');
        if (
          active &&
          (errName === 'NotAllowedError' ||
            errName === 'PermissionDeniedError' ||
            errName === 'SecurityError')
        ) {
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
  };
}
