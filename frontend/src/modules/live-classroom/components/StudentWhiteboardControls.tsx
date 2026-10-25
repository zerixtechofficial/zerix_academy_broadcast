'use client';

import React from 'react';
import {
  Copy,
  Check,
  Sparkles,
  Compass,
  ZoomIn,
  ZoomOut,
  Radio,
} from 'lucide-react';

export interface StudentWhiteboardControlsProps {
  role: 'teacher' | 'student';
  isRoughPad: boolean;
  isEditable: boolean;
  followTeacher: boolean;
  studentZoomMultiplier: number;
  copiedToast: boolean;
  onToggleFollow: (follow: boolean) => void;
  onChangeZoomMultiplier: (updater: (prev: number) => number) => void;
  onCopyToRoughPad?: () => void;
  onSwitchToLiveBoard?: () => void;
}

/**
 * Mobile-first floating HUD controls for Student & Co-Teacher Whiteboard stages.
 * Engineered to stay single-line and compact on 320px–430px mobile screens without
 * overlapping Excalidraw's bottom toolbars or the top-right Fullscreen quick bar.
 */
export const StudentWhiteboardControls: React.FC<StudentWhiteboardControlsProps> = ({
  role,
  isRoughPad,
  isEditable,
  followTeacher,
  studentZoomMultiplier,
  copiedToast,
  onToggleFollow,
  onChangeZoomMultiplier,
  onCopyToRoughPad,
  onSwitchToLiveBoard,
}) => {
  // 1. Student Personal Rough Pad Badge (Top-Left / Top-Center)
  if (isRoughPad) {
    return (
      <div
        data-prevent-nav-toggle="true"
        data-testid="roughpad-controls"
        className="pointer-events-none absolute top-2 left-2 sm:top-2.5 sm:left-3 z-30 max-w-[calc(100vw-1rem)] select-none"
      >
        <div className="pointer-events-auto max-w-full min-w-0 flex items-center flex-nowrap whitespace-nowrap gap-1.5 sm:gap-2 bg-white/95 backdrop-blur-md border border-slate-200/90 shadow-md rounded-full px-2.5 sm:px-3.5 py-1 text-[11px] sm:text-xs text-slate-700 overflow-x-auto no-scrollbar">
          <Sparkles className="w-3.5 h-3.5 text-[#12a3ff] shrink-0" />
          <span className="font-semibold text-slate-800 truncate">
            <span className="hidden sm:inline">My Personal Rough Pad</span>
            <span className="sm:hidden">Rough Pad</span>
          </span>
          <span className="text-slate-400 hidden lg:inline">•</span>
          <span className="hidden lg:inline text-slate-500">
            Private to you
          </span>
          {onSwitchToLiveBoard && (
            <>
              <div className="h-3.5 w-px bg-slate-200 shrink-0" />
              <button
                type="button"
                data-testid="roughpad-back-to-live-btn"
                onClick={onSwitchToLiveBoard}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-50 hover:bg-[#12a3ff] text-[#12a3ff] hover:text-white border border-sky-200 font-semibold transition-colors shrink-0 cursor-pointer"
              >
                <Radio className="w-3 h-3 shrink-0" />
                <span>Live Board</span>
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // 2. Co-Teacher View-Only Badge
  if (role === 'teacher' && !isEditable) {
    return (
      <div
        data-prevent-nav-toggle="true"
        data-testid="coteacher-wb-readonly-badge"
        className="pointer-events-none absolute top-2 left-2 sm:top-2.5 sm:left-3 z-30 max-w-[calc(100vw-1rem)] select-none"
      >
        <div className="pointer-events-auto max-w-full min-w-0 flex items-center flex-nowrap whitespace-nowrap gap-1.5 bg-amber-50/95 backdrop-blur-md border border-amber-200 shadow-md rounded-full px-3 py-1 text-[11px] sm:text-xs text-amber-800 font-semibold overflow-x-auto no-scrollbar">
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
          <span className="truncate">
            <span className="hidden sm:inline">
              Co-Teacher View Mode — Request Host Teacher to Enable Whiteboard Access
            </span>
            <span className="sm:hidden">Co-Teacher View Only</span>
          </span>
        </div>
      </div>
    );
  }

  // 3. Student Live Whiteboard: Show single "Follow Teacher" button at the bottom ONLY when student moved canvas (!followTeacher)
  if (role === 'student') {
    if (followTeacher) {
      return null;
    }

    return (
      <div
        data-prevent-nav-toggle="true"
        data-testid="student-whiteboard-controls"
        className={`pointer-events-none fixed left-1/2 -translate-x-1/2 z-50 flex items-center select-none animate-in fade-in slide-in-from-bottom-3 duration-200 ${
          isEditable ? 'bottom-16 sm:bottom-20' : 'bottom-6'
        }`}
      >
        <button
          type="button"
          data-testid="follow-teacher-btn"
          onClick={() => {
            onToggleFollow(true);
            onChangeZoomMultiplier(() => 1.0);
          }}
          className="pointer-events-auto flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#12a3ff] hover:bg-[#0d8de0] active:scale-95 text-white text-xs sm:text-sm font-semibold shadow-xl ring-2 ring-white/90 transition-all cursor-pointer"
        >
          <Compass className="w-4 h-4 shrink-0" />
          <span>Follow Teacher</span>
        </button>
      </div>
    );
  }

  return null;
};
