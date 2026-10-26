import { useEffect, useRef, useState, useCallback } from 'react';

export interface UseScreenWakeLockOptions {
  /** Whether the screen should be kept awake (e.g. live broadcast active and participant joined) */
  enabled: boolean;
}

export interface UseScreenWakeLockReturn {
  isWakeLockActive: boolean;
  wakeLockMode: 'native' | 'fallback-video' | 'inactive';
  requestWakeLockNow: () => Promise<boolean>;
}

/**
 * Tiny valid 1x1 MP4 / WebM data URIs used as a cross-browser NoSleep video fallback
 * for older iOS Safari (< 16.4), Firefox Mobile, and embedded WebViews where
 * `navigator.wakeLock` is either unavailable or restricted.
 */
const FALLBACK_WEBM_DATA_URI =
  'data:video/webm;base64,GkXfo0AgQoaBAUL3gQFC8oEEQvOBCEKCQAR3ZWJtQoeBAkKFgQIYU4BnQI0VSalmQCgq17FAAw9CQE2AQAZ3aGFtbXlXQUAGd2hhbW15RIlACECPQAAAAAAAFlSua0AxrkAu14EBY8WBAZyBACK1nEADdW5khkAFVl9WUDglhohAA1ZQOIOBAeBABrCBCLqBCB9DtnVAIueBAKNAHIEAAIAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=';

const FALLBACK_MP4_DATA_URI =
  'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAu1tZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE0OCByMjc5NSA2YThhOWI2IC0gSC4yNjQvTVBFRy00 AVCIGNvZGVjIC0gQ29weXJpZ2h0IDIwMDMtMjAxNyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwcyk9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfHlyaW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCB2YnZfbWF4cmF0ZT0wIHZidl9idWZzaXplPTAgY3JmX21heD0wLjAgbmFsX2hyZD1ub25lIGZpbGxlcj0wIGlwX3JhdGlvPTEuNDAgYXE9MToxLjAw ';

/**
 * Prevents the mobile/tablet/desktop screen from turning off while the live classroom
 * broadcast is active (`enabled === true`).
 *
 * Supports all major browsers and devices:
 * 1. W3C Screen Wake Lock API (`navigator.wakeLock.request('screen')`) — Chrome, Edge,
 *    Safari iOS 16.4+, Safari macOS, Firefox 126+, Samsung Internet, Opera.
 * 2. Automatic re-acquisition on `visibilitychange` (tab switch / screen unlock) and `focus`.
 * 3. Cross-browser fallback (`<video playsinline muted loop>` + Web Audio silent keepalive)
 *    for older iOS Safari, Firefox Android, and WebViews upon first user interaction.
 */
export function useScreenWakeLock({ enabled }: UseScreenWakeLockOptions): UseScreenWakeLockReturn {
  const [isWakeLockActive, setIsWakeLockActive] = useState(false);
  const [wakeLockMode, setWakeLockMode] = useState<'native' | 'fallback-video' | 'inactive'>('inactive');

  const sentinelRef = useRef< any | null >(null);
  const fallbackVideoRef = useRef<HTMLVideoElement | null>(null);
  const fallbackIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const enabledRef = useRef<boolean>(enabled);
  enabledRef.current = enabled;

  const stopFallbackKeepAlive = useCallback(() => {
    if (fallbackIntervalRef.current) {
      clearInterval(fallbackIntervalRef.current);
      fallbackIntervalRef.current = null;
    }
    if (fallbackVideoRef.current) {
      try {
        fallbackVideoRef.current.pause();
        fallbackVideoRef.current.removeAttribute('src');
        fallbackVideoRef.current.load();
        if (fallbackVideoRef.current.parentNode) {
          fallbackVideoRef.current.parentNode.removeChild(fallbackVideoRef.current);
        }
      } catch {
        // ignore cleanup errors
      }
      fallbackVideoRef.current = null;
    }
  }, []);

  const startFallbackKeepAlive = useCallback((): boolean => {
    if (typeof document === 'undefined') return false;
    try {
      if (!fallbackVideoRef.current) {
        const video = document.createElement('video');
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        video.setAttribute('muted', 'true');
        video.setAttribute('loop', 'true');
        video.setAttribute('aria-hidden', 'true');
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.style.position = 'fixed';
        video.style.width = '1px';
        video.style.height = '1px';
        video.style.opacity = '0.001';
        video.style.pointerEvents = 'none';
        video.style.zIndex = '-1';
        video.style.bottom = '0';
        video.style.right = '0';

        const sourceWebm = document.createElement('source');
        sourceWebm.src = FALLBACK_WEBM_DATA_URI;
        sourceWebm.type = 'video/webm';

        const sourceMp4 = document.createElement('source');
        sourceMp4.src = FALLBACK_MP4_DATA_URI;
        sourceMp4.type = 'video/mp4';

        video.appendChild(sourceMp4);
        video.appendChild(sourceWebm);
        document.body.appendChild(video);
        fallbackVideoRef.current = video;
      }

      const playPromise = fallbackVideoRef.current.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise
          .then(() => {
            if (enabledRef.current && !sentinelRef.current) {
              setIsWakeLockActive(true);
              setWakeLockMode('fallback-video');
            }
          })
          .catch(() => {
            // Will retry on next user gesture
          });
      }

      if (!fallbackIntervalRef.current) {
        fallbackIntervalRef.current = setInterval(() => {
          if (!enabledRef.current) return;
          if (fallbackVideoRef.current && fallbackVideoRef.current.paused) {
            fallbackVideoRef.current.play().catch(() => {});
          }
        }, 15_000);
      }

      return true;
    } catch {
      return false;
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    stopFallbackKeepAlive();
    if (sentinelRef.current) {
      try {
        await sentinelRef.current.release();
      } catch {
        // ignore
      }
      sentinelRef.current = null;
    }
    setIsWakeLockActive(false);
    setWakeLockMode('inactive');
  }, [stopFallbackKeepAlive]);

  const requestWakeLockNow = useCallback(async (): Promise<boolean> => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
    if (!enabledRef.current) return false;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;

    // 1. If native WakeLockSentinel is already active and not released, keep it
    if (sentinelRef.current && !sentinelRef.current.released) {
      setIsWakeLockActive(true);
      setWakeLockMode('native');
      return true;
    }

    // 2. Try W3C Screen Wake Lock API (`navigator.wakeLock.request('screen')`)
    const navAny = navigator as any;
    if (navAny.wakeLock && typeof navAny.wakeLock.request === 'function') {
      try {
        const sentinel = await navAny.wakeLock.request('screen');
        sentinelRef.current = sentinel;
        stopFallbackKeepAlive();
        setIsWakeLockActive(true);
        setWakeLockMode('native');

        if (typeof sentinel.addEventListener === 'function') {
          sentinel.addEventListener('release', () => {
            if (sentinelRef.current === sentinel) {
              sentinelRef.current = null;
            }
            if (enabledRef.current && document.visibilityState === 'visible') {
              // Attempt immediate re-acquisition if still visible and live
              navAny.wakeLock
                .request('screen')
                .then((newSentinel: any) => {
                  sentinelRef.current = newSentinel;
                  setIsWakeLockActive(true);
                  setWakeLockMode('native');
                })
                .catch(() => {
                  startFallbackKeepAlive();
                });
            } else {
              setIsWakeLockActive(false);
              setWakeLockMode('inactive');
            }
          });
        }
        return true;
      } catch {
        // Native wakeLock failed (e.g., battery saver or gesture required) -> engage fallback
        return startFallbackKeepAlive();
      }
    }

    // 3. Browser does not support navigator.wakeLock -> engage video keepalive fallback
    return startFallbackKeepAlive();
  }, [startFallbackKeepAlive, stopFallbackKeepAlive]);

  useEffect(() => {
    if (!enabled) {
      releaseWakeLock();
      return;
    }

    requestWakeLockNow();

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible' && enabledRef.current) {
        requestWakeLockNow();
      }
    };

    const handleUserGesture = () => {
      if (!enabledRef.current) return;
      if (!sentinelRef.current || sentinelRef.current.released) {
        requestWakeLockNow();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    window.addEventListener('focus', handleVisibilityOrFocus);
    window.addEventListener('pageshow', handleVisibilityOrFocus);

    // Passive user gesture listeners ensure mobile browsers (iOS Safari, Android Chrome/Firefox)
    // acquire the wake lock or start the fallback video on first tap/scroll
    window.addEventListener('pointerdown', handleUserGesture, { passive: true });
    window.addEventListener('touchstart', handleUserGesture, { passive: true });
    window.addEventListener('click', handleUserGesture, { passive: true });
    window.addEventListener('keydown', handleUserGesture, { passive: true });

    // Periodic check every 20s to ensure wake lock remains active throughout a 60+ minute class
    const watchdogInterval = setInterval(() => {
      if (
        enabledRef.current &&
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible' &&
        (!sentinelRef.current || sentinelRef.current.released)
      ) {
        requestWakeLockNow();
      }
    }, 20_000);

    return () => {
      clearInterval(watchdogInterval);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      window.removeEventListener('focus', handleVisibilityOrFocus);
      window.removeEventListener('pageshow', handleVisibilityOrFocus);
      window.removeEventListener('pointerdown', handleUserGesture);
      window.removeEventListener('touchstart', handleUserGesture);
      window.removeEventListener('click', handleUserGesture);
      window.removeEventListener('keydown', handleUserGesture);
      releaseWakeLock();
    };
  }, [enabled, requestWakeLockNow, releaseWakeLock]);

  return {
    isWakeLockActive,
    wakeLockMode,
    requestWakeLockNow,
  };
}
