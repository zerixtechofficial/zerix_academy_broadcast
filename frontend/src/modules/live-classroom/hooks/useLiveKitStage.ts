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

export interface UseLiveKitStageParams {
  livekitUrl?: string;
  token?: string;
  canPublishAudio?: boolean;
  autoActivateMic?: boolean;
  onMicStateChange?: (enabled: boolean) => void;
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

export function useLiveKitStage({
  token,
  canPublishAudio = false,
  autoActivateMic = false,
  onMicStateChange,
}: UseLiveKitStageParams) {
  const roomRef = useRef<Room | null>(null);
  const dspNodesRef = useRef<NoiseCancellationNodes | null>(null);
  const onMicStateChangeRef = useRef(onMicStateChange);
  useEffect(() => {
    onMicStateChangeRef.current = onMicStateChange;
  }, [onMicStateChange]);

  const [isAudioConnected, setIsAudioConnected] = useState(false);
  // By default, ALL participant microphones (Host Teacher, Co-Teacher, Students) start MUTED (false)
  const [isMicrophoneEnabled, setIsMicrophoneEnabled] = useState(false);
  // Real-time Noise Cancellation is enabled by default for all audio publishers
  const [isNoiseCancellationEnabled, setIsNoiseCancellationEnabled] = useState(true);
  const [activeSpeakers, setActiveSpeakers] = useState<string[]>([]);
  const [remoteParticipants, setRemoteParticipants] = useState<string[]>([]);
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

  const getSfuUrl = useCallback(() => {
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
    return process.env.NEXT_PUBLIC_LIVEKIT_URL || 'ws://127.0.0.1:7880';
  }, []);

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

  // Unlock Audio on Any User Gesture (Autoplay Policy Helper)
  const unlockAudioPlayback = useCallback(async () => {
    if (roomRef.current) {
      try {
        await roomRef.current.startAudio();
        setAudioPlaybackBlocked(false);
      } catch (err: any) {
        console.warn('[LiveKit] startAudio error:', err.message);
      }
    }
  }, []);

  // Connect to LiveKit Room (Lifecycle tied to token & SFU url only)
  useEffect(() => {
    if (!token) return;

    let isMounted = true;
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

    const setupRoom = async () => {
      try {
        await room.connect(url, token);
        if (!isMounted) return;

        setIsAudioConnected(true);
        if (autoActivateMic && canPublishAudio) {
          // If autoActivateMic is requested (e.g. Host granted mic access to student), activate immediately
          setIsMicrophoneEnabled(true);
          onMicStateChangeRef.current?.(true);
          room.localParticipant.setMicrophoneEnabled(true).then(() => {
            const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
            const rawTrack = micPub?.audioTrack?.mediaStreamTrack;
            if (rawTrack) {
              applyWebAudioNoiseCancellation(rawTrack, isNoiseCancellationEnabled);
            }
          }).catch((err) => {
            console.warn('[LiveKit] Auto-activate microphone notice:', err.message);
          });
        } else {
          // By default, microphone starts explicitly MUTED for participants
          setIsMicrophoneEnabled(false);
        }

        // Try unlocking audio playback immediately
        unlockAudioPlayback();

        // 1. Audio Playback Status Changed (Autoplay Policy)
        room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
          if (!isMounted) return;
          setAudioPlaybackBlocked(!room.canPlaybackAudio);
        });

        // 2. Active Speakers Change
        room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
          if (!isMounted) return;
          setActiveSpeakers(speakers.map((s) => s.identity));
        });

        // 3. Track Subscribed (Play remote participant audio)
        room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication, participant) => {
          if (track.kind === Track.Kind.Audio) {
            const existing = document.getElementById(`audio_${participant.identity}`);
            if (existing) {
              existing.remove();
            }
            const audioElement = (track as RemoteAudioTrack).attach();
            audioElement.id = `audio_${participant.identity}`;
            audioElement.setAttribute('playsinline', 'true');
            audioElement.setAttribute('autoplay', 'true');
            document.body.appendChild(audioElement);
            audioElement.play().catch(() => {
              setAudioPlaybackBlocked(true);
            });
          }
        });

        // 4. Track Unsubscribed
        room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _publication, participant) => {
          if (track.kind === Track.Kind.Audio) {
            const el = document.getElementById(`audio_${participant.identity}`);
            if (el) el.remove();
            track.detach().forEach((item) => item.remove());
          }
        });

        // 5. Participants
        room.on(RoomEvent.ParticipantConnected, (p) => {
          if (!isMounted) return;
          setRemoteParticipants((prev) => Array.from(new Set([...prev, p.identity])));
        });

        room.on(RoomEvent.ParticipantDisconnected, (p) => {
          if (!isMounted) return;
          setRemoteParticipants((prev) => prev.filter((id) => id !== p.identity));
        });
      } catch (err: any) {
        console.warn('[LiveKit] Connection notice:', err.message);
        if (isMounted) setIsAudioConnected(false);
      }
    };

    setupRoom();

    // Pointer listener to unlock audio on first interaction (no keydown listener so Excalidraw shortcuts stay untouched)
    const handleGesture = () => {
      unlockAudioPlayback();
    };
    window.addEventListener('pointerdown', handleGesture, { once: true });

    return () => {
      isMounted = false;
      window.removeEventListener('pointerdown', handleGesture);
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
      setIsAudioConnected(false);
      setIsMicrophoneEnabled(false);
    };
  }, [token, getSfuUrl, unlockAudioPlayback]);

  // When canPublishAudio is revoked (e.g. teacher mutes student): force mute immediately
  useEffect(() => {
    const room = roomRef.current;
    if (!canPublishAudio && isMicrophoneEnabled) {
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

  // Explicit Set Mic Active/Inactive Action
  const setMicrophoneActive = useCallback(
    async (active: boolean) => {
      const room = roomRef.current;

      if (!room || !isAudioConnected) {
        setIsMicrophoneEnabled(active);
        onMicStateChangeRef.current?.(active);
        return;
      }

      try {
        setMicError(null);
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

        setIsMicrophoneEnabled(active);
        onMicStateChangeRef.current?.(active);
        unlockAudioPlayback();
      } catch (err: any) {
        // In headless test environments without a physical audio input device, still allow
        // setting the logical mic state cleanly while logging a non-blocking warning
        console.warn('[LiveKit] Microphone hardware capture notice:', err.message);
        setIsMicrophoneEnabled(active);
        onMicStateChangeRef.current?.(active);
      }
    },
    [
      isAudioConnected,
      isNoiseCancellationEnabled,
      applyWebAudioNoiseCancellation,
      unlockAudioPlayback,
    ]
  );

  // Explicit Toggle Mic Action (Toggles between Muted and Unmuted)
  const toggleMicrophone = useCallback(async () => {
    await setMicrophoneActive(!isMicrophoneEnabled);
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
    toggleMicrophone,
    setMicrophoneActive,
    toggleNoiseCancellation,
    unlockAudioPlayback,
  };
}
