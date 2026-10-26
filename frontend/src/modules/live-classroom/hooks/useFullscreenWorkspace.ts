'use client';

import { useState, useEffect, useCallback } from 'react';

export interface UseFullscreenWorkspaceResult {
  isFullscreen: boolean;
  isTopNavVisible: boolean;
  setTopNavVisible: React.Dispatch<React.SetStateAction<boolean>>;
  toggleTopNav: () => void;
  enterFullscreen: () => Promise<void>;
  exitFullscreen: () => Promise<void>;
  toggleFullscreen: () => Promise<void>;
}

/**
 * Manages full-screen mode (Native Browser Fullscreen API + Mobile/iOS CSS Fullscreen fallback)
 * and top navigation bar visibility (tap-on-screen / button toggle for immersive mobile & desktop view).
 */
export function useFullscreenWorkspace(
  containerRef?: React.RefObject<HTMLElement | null>
): UseFullscreenWorkspaceResult {
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isTopNavVisible, setTopNavVisible] = useState<boolean>(true);

  const getNativeFullscreenElement = useCallback((): Element | null => {
    if (typeof document === 'undefined') return null;
    const doc = document as any;
    return (
      doc.fullscreenElement ||
      doc.webkitFullscreenElement ||
      doc.mozFullScreenElement ||
      doc.msFullscreenElement ||
      null
    );
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleFullscreenChange = () => {
      const activeEl = getNativeFullscreenElement();
      setIsFullscreen(Boolean(activeEl));
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, [getNativeFullscreenElement]);

  const enterFullscreen = useCallback(async () => {
    if (typeof document === 'undefined') return;
    const targetEl = (containerRef?.current || document.documentElement) as any;

    try {
      if (targetEl.requestFullscreen) {
        await targetEl.requestFullscreen();
        setIsFullscreen(true);
        return;
      }
      if (targetEl.webkitRequestFullscreen) {
        await targetEl.webkitRequestFullscreen();
        setIsFullscreen(true);
        return;
      }
      if (targetEl.mozRequestFullScreen) {
        await targetEl.mozRequestFullScreen();
        setIsFullscreen(true);
        return;
      }
      if (targetEl.msRequestFullscreen) {
        await targetEl.msRequestFullscreen();
        setIsFullscreen(true);
        return;
      }
    } catch {
      // Fallback for iOS Safari / embedded webviews / restricted headless contexts
    }
    setIsFullscreen(true);
  }, [containerRef]);

  const exitFullscreen = useCallback(async () => {
    if (typeof document === 'undefined') return;
    const doc = document as any;

    try {
      if (getNativeFullscreenElement()) {
        if (doc.exitFullscreen) {
          await doc.exitFullscreen();
        } else if (doc.webkitExitFullscreen) {
          await doc.webkitExitFullscreen();
        } else if (doc.mozCancelFullScreen) {
          await doc.mozCancelFullScreen();
        } else if (doc.msExitFullscreen) {
          await doc.msExitFullscreen();
        }
      }
    } catch {
      // Ignore errors when exiting fallback pseudo-fullscreen
    }
    setIsFullscreen(false);
    setTopNavVisible(true);
  }, [getNativeFullscreenElement]);

  const toggleFullscreen = useCallback(async () => {
    if (isFullscreen || Boolean(getNativeFullscreenElement())) {
      await exitFullscreen();
    } else {
      await enterFullscreen();
    }
  }, [isFullscreen, getNativeFullscreenElement, enterFullscreen, exitFullscreen]);

  const toggleTopNav = useCallback(() => {
    setTopNavVisible((prev) => !prev);
  }, []);

  return {
    isFullscreen,
    isTopNavVisible,
    setTopNavVisible,
    toggleTopNav,
    enterFullscreen,
    exitFullscreen,
    toggleFullscreen,
  };
}
