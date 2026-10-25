'use client';

import React from 'react';
import { Maximize2, Minimize2, ChevronUp, ChevronDown } from 'lucide-react';

export interface FloatingStageQuickBarProps {
  isTopNavVisible: boolean;
  isFullscreen: boolean;
  onToggleTopNav: () => void;
  onToggleFullscreen: () => void;
}

/**
 * Floating quick-access bar positioned in the top-right corner of the active stage.
 * Ensures both Teacher and Student (especially on mobile phones) can always:
 * 1. Show or Hide the Top Navigation Bar (in addition to tapping the canvas)
 * 2. Enter Full Screen or Exit Full Screen mode even when the Top Navigation Bar is hidden.
 */
export const FloatingStageQuickBar: React.FC<FloatingStageQuickBarProps> = ({
  isTopNavVisible,
  isFullscreen,
  onToggleTopNav,
  onToggleFullscreen,
}) => {
  return (
    <div
      data-testid="floating-stage-quickbar"
      data-prevent-nav-toggle="true"
      className="pointer-events-none absolute top-2 right-2 sm:top-2.5 sm:right-3 z-40 flex items-center gap-1 select-none"
    >
      <div className="pointer-events-auto flex items-center gap-0.5 sm:gap-1 bg-white/95 backdrop-blur-md border border-slate-200/90 shadow-md rounded-full p-0.5 sm:p-1 text-xs">
        {/* Show / Hide Top Nav Toggle */}
        <button
          type="button"
          data-testid="stage-toggle-topnav-btn"
          data-topnav-state={isTopNavVisible ? 'visible' : 'hidden'}
          aria-label={isTopNavVisible ? 'Hide Top Navigation Bar' : 'Show Top Navigation Bar'}
          onClick={(e) => {
            e.stopPropagation();
            onToggleTopNav();
          }}
          title={
            isTopNavVisible
              ? 'Hide Top Bar (or tap on canvas)'
              : 'Show Top Bar (or tap on canvas)'
          }
          className={`flex items-center gap-1 px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full font-semibold transition-all cursor-pointer whitespace-nowrap ${
            !isTopNavVisible
              ? 'bg-[#12a3ff] hover:bg-[#0d8de0] text-white shadow-2xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
          }`}
        >
          {isTopNavVisible ? (
            <>
              <ChevronUp className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
              <span className="text-[10px] sm:text-[11px]">Hide Bar</span>
            </>
          ) : (
            <>
              <ChevronDown className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
              <span className="text-[10px] sm:text-[11px]">Show Bar</span>
            </>
          )}
        </button>

        <div className="h-3.5 w-px bg-slate-200 shrink-0" />

        {/* Full Screen / Exit Full Screen Toggle */}
        <button
          type="button"
          data-testid="stage-fullscreen-btn"
          data-fullscreen-state={isFullscreen ? 'true' : 'false'}
          aria-label={isFullscreen ? 'Exit Full Screen' : 'Full Screen'}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFullscreen();
          }}
          title={isFullscreen ? 'Exit Full Screen Mode' : 'Enter Full Screen Mode'}
          className={`flex items-center gap-1 px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full font-semibold transition-all cursor-pointer whitespace-nowrap ${
            isFullscreen
              ? 'bg-slate-900 hover:bg-slate-800 text-white shadow-2xs'
              : 'text-slate-700 hover:text-slate-900 hover:bg-slate-100'
          }`}
        >
          {isFullscreen ? (
            <>
              <Minimize2 className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0 text-sky-400" />
              <span className="text-[10px] sm:text-[11px]">Exit Full Screen</span>
            </>
          ) : (
            <>
              <Maximize2 className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0 text-[#12a3ff]" />
              <span className="text-[10px] sm:text-[11px]">Full Screen</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};
