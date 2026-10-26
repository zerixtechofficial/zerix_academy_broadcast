'use client';

import React, { useState } from 'react';
import {
  ActiveMode,
  AudioStageState,
  StudentAttendanceSummary,
} from '../hooks/useBroadcastSocket';
import {
  PanelLeftClose,
  PanelLeftOpen,
  BookOpen,
  PenTool,
  NotebookPen,
  Users,
  UserPlus,
  ShieldCheck,
  Mic,
  MicOff,
  Hand,
  Compass,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Volume2,
  VolumeX,
  CheckCircle2,
  AlertTriangle,
  X,
  Clock,
  RefreshCw,
  Trash2,
  GraduationCap,
  Copy,
  Check,
  Link2,
  Maximize2,
  Minimize2,
  LogOut,
} from 'lucide-react';

export interface BatchOption {
  sessionId: string;
  batchId: string;
  name: string;
  subject: string;
  teacherName: string;
}

interface TopModeNavbarProps {
  role: 'teacher' | 'student';
  userId: string;
  userName: string;
  teacherName: string;
  isHostTeacher?: boolean;
  canEditWhiteboard?: boolean;
  chapterTitle: string;
  lessonTitle: string;
  topicTitle: string;
  activeMode: ActiveMode;
  studentTab?: 'live';
  isSidebarCollapsed: boolean;
  isConnected: boolean;
  participantsCount: number;
  audioStage: AudioStageState;
  attendanceList: StudentAttendanceSummary[];
  followTeacher: boolean;
  studentZoomMultiplier: number;
  isLocalMicOn: boolean;
  isNoiseCancellationEnabled: boolean;
  hasRaisedHand: boolean;
  hasStudentMicGrant: boolean;
  batches: BatchOption[];
  selectedSessionId: string;
  onToggleSidebar: () => void;
  onSwitchMode: (mode: ActiveMode) => void;
  onSwitchStudentTab?: (tab: 'live') => void;
  onToggleFollow: (follow: boolean) => void;
  onChangeZoomMultiplier: (updater: (prev: number) => number) => void;
  onToggleLocalMic: () => void;
  onToggleNoiseCancellation: () => void;
  onRaiseHand: () => void;
  onLowerHand: () => void;
  onGrantStudentMic: (
    studentId: string,
    studentName: string,
    cb?: (res: { ok: boolean; message?: string }) => void
  ) => void;
  onRevokeStudentMic: (studentId: string) => void;
  onMuteAllStudents: () => void;
  onToggleAllowStudentUnmute?: (allow: boolean) => void;
  onInviteCoTeacher: (teacherId: string, name: string, canUseWhiteboard: boolean) => void;
  onToggleCoTeacherWhiteboard: (teacherId: string, canUseWhiteboard: boolean) => void;
  onRemoveCoTeacher: (teacherId: string) => void;
  onGrantWhiteboardAccess: (targetUserId: string) => void;
  onRevokeWhiteboardAccess: (targetUserId: string) => void;
  onToggleStudentMultiDevice?: (studentId: string, allow: boolean) => void;
  onSwitchRole: (role: 'teacher' | 'student', teacherId?: string) => void;
  onSelectBatch: (sessionId: string) => void;
  onSimulateDisconnect: () => void;
  isTopNavVisible?: boolean;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onToggleTopNav?: () => void;
  onLeaveMeeting?: () => void;
  onEndClass?: () => void;
  isContentToolboxVisible?: boolean;
  onToggleContentToolbox?: () => void;
  teachingMode?: 'taught' | 'reference_only';
  onToggleTeachingMode?: () => void;
  isRecording?: boolean;
  recordingDurationSec?: number;
  chunksUploaded?: number;
  onToggleRecording?: () => void;
  coHostInviteToken?: string;
  onRefreshCoHostInviteToken?: (canUseWhiteboard: boolean) => Promise<string | undefined>;
}

export const TopModeNavbar: React.FC<TopModeNavbarProps> = ({
  role,
  userId,
  userName,
  teacherName,
  isHostTeacher = true,
  canEditWhiteboard = false,
  chapterTitle,
  lessonTitle,
  topicTitle,
  activeMode,
  studentTab = 'live',
  isSidebarCollapsed,
  isConnected,
  participantsCount,
  audioStage,
  attendanceList,
  followTeacher,
  studentZoomMultiplier,
  isLocalMicOn,
  isNoiseCancellationEnabled,
  hasRaisedHand,
  hasStudentMicGrant,
  selectedSessionId,
  onToggleSidebar,
  onSwitchMode,
  onSwitchStudentTab,
  onToggleFollow,
  onChangeZoomMultiplier,
  onToggleLocalMic,
  onToggleNoiseCancellation,
  onRaiseHand,
  onLowerHand,
  onGrantStudentMic,
  onRevokeStudentMic,
  onMuteAllStudents,
  onToggleAllowStudentUnmute,
  onInviteCoTeacher,
  onToggleCoTeacherWhiteboard,
  onRemoveCoTeacher,
  onGrantWhiteboardAccess,
  onRevokeWhiteboardAccess,
  onToggleStudentMultiDevice,
  isTopNavVisible = true,
  isFullscreen = false,
  onToggleFullscreen,
  onLeaveMeeting,
  onEndClass,
  isContentToolboxVisible = true,
  onToggleContentToolbox,
  teachingMode = 'taught',
  onToggleTeachingMode,
  isRecording = false,
  recordingDurationSec = 0,
  chunksUploaded = 0,
  onToggleRecording,
  coHostInviteToken = '',
  onRefreshCoHostInviteToken,
}: TopModeNavbarProps) => {
  const [isUsersDrawerOpen, setIsUsersDrawerOpen] = useState(false);
  const [isLeaveModalOpen, setIsLeaveModalOpen] = useState(false);
  const [activeDrawerTab, setActiveDrawerTab] = useState<'student' | 'teacher'>('student');
  const [micValidationError, setMicValidationError] = useState<string | null>(null);
  const [inviteWithWhiteboard, setInviteWithWhiteboard] = useState<boolean>(true);
  const [isCoHostLinkCopied, setIsCoHostLinkCopied] = useState<boolean>(false);

  const buildCoHostInviteUrl = (inviteToken?: string) => {
    const baseUrl =
      typeof window !== 'undefined'
        ? `${window.location.origin}${window.location.pathname}`
        : 'https://studio.zerixtech.com/';
    const tok = inviteToken || coHostInviteToken;
    return `${baseUrl}?role=teacher&cohost=1&sessionId=${encodeURIComponent(selectedSessionId)}${
      tok ? `&token=${encodeURIComponent(tok)}` : ''
    }`;
  };

  const coHostInviteUrl = buildCoHostInviteUrl(coHostInviteToken);

  const handleCopyCoHostLink = async () => {
    let latestToken = coHostInviteToken;
    if (onRefreshCoHostInviteToken) {
      try {
        const refreshed = await onRefreshCoHostInviteToken(inviteWithWhiteboard);
        if (refreshed) {
          latestToken = refreshed;
        }
      } catch {
        // Fallback to existing coHostInviteToken
      }
    }
    const urlToCopy = buildCoHostInviteUrl(latestToken);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(urlToCopy);
      } else {
        const tempInput = document.createElement('textarea');
        tempInput.value = urlToCopy;
        tempInput.style.position = 'fixed';
        tempInput.style.opacity = '0';
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand('copy');
        document.body.removeChild(tempInput);
      }
    } catch {
      // Clipboard fallback in headless/non-secure contexts
    }
    setIsCoHostLinkCopied(true);
    window.setTimeout(() => {
      setIsCoHostLinkCopied(false);
    }, 2000);
  };

  const activeMicsCount = audioStage.activeStudentMics.length;
  const maxMics = audioStage.maxAllowedStudentMics || 10;
  const raisedHandsCount = audioStage.raisedHands.length;
  const invitedTeachers = audioStage.invitedTeachers || [];
  const whiteboardEditors = audioStage.whiteboardEditors || [];
  const multiDeviceStudents = audioStage.multiDeviceStudents || [];

  const handleApproveMic = (studentId: string, studentName: string) => {
    setMicValidationError(null);
    onGrantStudentMic(studentId, studentName, (res) => {
      if (!res.ok && res.message) {
        setMicValidationError(res.message);
      }
    });
  };

  // 1-click "Mute Oldest Speaker & Approve" when Max 10 Student Mics limit is reached
  const handleReplaceOldestSpeakerAndApprove = (
    studentId: string,
    studentName: string
  ) => {
    if (audioStage.activeStudentMics.length > 0) {
      const sorted = [...audioStage.activeStudentMics].sort(
        (a, b) => a.grantedAt - b.grantedAt
      );
      const oldest = sorted[0];
      if (oldest) {
        onRevokeStudentMic(oldest.studentId);
      }
    }
    window.setTimeout(() => {
      handleApproveMic(studentId, studentName);
    }, 80);
  };

  const formatClockTime = (ts?: number | null) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <>
      <header
        data-testid="top-mode-navbar"
        data-visible="true"
        className="sticky top-0 z-40 h-12 sm:h-14 max-h-[56px] w-full bg-white border-b border-slate-200 px-1.5 sm:px-3 flex items-center justify-between gap-1 sm:gap-2 shrink-0 select-none transition-all duration-200"
      >
        {/* LEFT: Sidebar Toggle + Compact Breadcrumb Title */}
        <div className="flex items-center gap-1 sm:gap-2.5 min-w-0 sm:flex-1">
          <button
            type="button"
            data-testid="sidebar-toggle-btn"
            onClick={onToggleSidebar}
            className="p-1.5 sm:p-2 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors shrink-0"
            title={isSidebarCollapsed ? 'Expand Curriculum Sidebar' : 'Collapse Sidebar'}
          >
            {isSidebarCollapsed ? (
              <PanelLeftOpen className="w-4 h-4" />
            ) : (
              <PanelLeftClose className="w-4 h-4" />
            )}
          </button>

          <div className="h-4 w-px bg-slate-200 shrink-0 hidden sm:block" />

          <div className="min-w-0 hidden sm:flex items-center gap-1.5 text-xs">
            <span className="font-medium text-slate-500 truncate hidden md:inline max-w-[160px]">
              {chapterTitle.replace(/^Chapter\s+\d+:\s*/i, '')}
            </span>
            <span className="text-slate-300 hidden md:inline">/</span>
            <span className="font-semibold text-slate-900 truncate max-w-[180px] lg:max-w-[280px]">
              {topicTitle || lessonTitle}
            </span>
          </div>
        </div>

        {/* CENTER: Segmented Mode Switcher Pill (Content & Whiteboard Only — Student Rough Pad Removed) */}
        <div className="flex items-center bg-slate-100 p-0.5 sm:p-1 rounded-xl border border-slate-200/80 shrink-0">
          {/* Content Mode Tab (Icon Only on Mobile, Text on Laptop/Desktop) */}
          <button
            type="button"
            data-testid="mode-btn-content"
            disabled={role === 'student' && activeMode !== 'content'}
            onClick={() => {
              onSwitchStudentTab?.('live');
              if (role === 'teacher') onSwitchMode('content');
            }}
            title="Content Mode"
            className={`flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-3 py-1 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-semibold transition-all ${
              activeMode === 'content'
                ? 'bg-white text-[#12a3ff] shadow-xs border border-slate-200/60'
                : role === 'teacher'
                ? 'text-slate-600 hover:text-slate-900'
                : 'text-slate-400 cursor-default'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden sm:inline">Content</span>
          </button>

          {/* Whiteboard Mode Tab (Icon Only on Mobile, Text on Laptop/Desktop) */}
          <button
            type="button"
            data-testid="mode-btn-whiteboard"
            disabled={role === 'student' && activeMode !== 'whiteboard'}
            onClick={() => {
              onSwitchStudentTab?.('live');
              if (role === 'teacher') onSwitchMode('whiteboard');
            }}
            title="Whiteboard Mode"
            className={`flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-3 py-1 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-semibold transition-all ${
              activeMode === 'whiteboard'
                ? 'bg-white text-[#12a3ff] shadow-xs border border-slate-200/60'
                : role === 'teacher'
                ? 'text-slate-600 hover:text-slate-900'
                : 'text-slate-400 cursor-default'
            }`}
          >
            <PenTool className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden sm:inline">Whiteboard</span>
          </button>
        </div>

        {/* RIGHT: Minimalist Controls + 720p Recorder + Teaching/Ref Mode + Fullscreen + Users + Leave */}
        <div className="flex items-center justify-end gap-1 sm:gap-2 sm:flex-1 min-w-0">
          {/* Teacher Multi-Topic Mode Toggle: Teaching Mode vs Reference-Only (Protects Old VOD & WB) */}
          {role === 'teacher' && isHostTeacher && onToggleTeachingMode && (
            <button
              type="button"
              data-testid="teaching-mode-toggle-btn"
              data-teaching-mode={teachingMode}
              onClick={onToggleTeachingMode}
              title={
                teachingMode === 'reference_only'
                  ? 'Reference-Only Mode Active: Old VOD & Whiteboard are protected from overwrite. Click to switch back to Teaching Mode.'
                  : 'Teaching Mode Active: Lesson timeline & Whiteboard will be saved to VOD. Click to switch to Reference-Only Mode.'
              }
              className={`hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-all shrink-0 cursor-pointer ${
                teachingMode === 'reference_only'
                  ? 'bg-amber-50 hover:bg-amber-100 text-amber-800 border-amber-200'
                  : 'bg-sky-50 hover:bg-sky-100 text-[#12a3ff] border-sky-200'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  teachingMode === 'reference_only' ? 'bg-amber-500' : 'bg-[#12a3ff]'
                }`}
              />
              <span>
                {teachingMode === 'reference_only' ? 'Ref Only (Protected)' : 'Teaching Mode'}
              </span>
            </button>
          )}

          {/* Student Reference-Only Indicator Badge */}
          {role === 'student' && teachingMode === 'reference_only' && (
            <span
              data-testid="student-ref-only-badge"
              className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-[11px] font-semibold shrink-0"
              title="Teacher opened this lesson for quick reference only"
            >
              Ref Topic
            </span>
          )}

          {/* Teacher 720p Hardware Encoder Status Pill */}
          {role === 'teacher' && isHostTeacher && onToggleRecording && (
            <button
              type="button"
              data-testid="recorder-status-pill"
              data-recording={isRecording ? 'true' : 'false'}
              onClick={onToggleRecording}
              title={
                isRecording
                  ? `720p Session Recording Active (${chunksUploaded} chunks uploaded). Continuous across topic changes.`
                  : 'Start 720p Continuous Session Recording (500kbps VP9 + 48kbps Opus)'
              }
              className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-all shrink-0 cursor-pointer ${
                isRecording
                  ? 'bg-white text-[#000000] border-[#12a3ff] shadow-xs'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  isRecording ? 'bg-rose-500 animate-pulse' : 'bg-slate-400'
                }`}
              />
              <span className="font-mono">
                {isRecording
                  ? `720p ${Math.floor(recordingDurationSec / 60)
                      .toString()
                      .padStart(2, '0')}:${(recordingDurationSec % 60)
                      .toString()
                      .padStart(2, '0')}`
                  : 'REC 720p'}
              </span>
            </button>
          )}

          {/* Student Custom Zoom Pill (Desktop Whiteboard) */}
          {role === 'student' && activeMode === 'whiteboard' && (
            <div className="hidden lg:flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1">
              <button
                type="button"
                onClick={() =>
                  onChangeZoomMultiplier((z) =>
                    Math.max(0.5, Number((z - 0.25).toFixed(2)))
                  )
                }
                className="p-0.5 rounded hover:bg-slate-200 text-slate-600"
                title="Zoom Out (Personal Multiplier)"
              >
                <ZoomOut className="w-3 h-3" />
              </button>
              <span className="text-[11px] font-mono font-semibold text-slate-700 min-w-[38px] text-center">
                {Math.round(studentZoomMultiplier * 100)}%
              </span>
              <button
                type="button"
                onClick={() =>
                  onChangeZoomMultiplier((z) =>
                    Math.min(3.0, Number((z + 0.25).toFixed(2)))
                  )
                }
                className="p-0.5 rounded hover:bg-slate-200 text-slate-600"
                title="Zoom In (Personal Multiplier)"
              >
                <ZoomIn className="w-3 h-3" />
              </button>
              {studentZoomMultiplier !== 1.0 && (
                <button
                  type="button"
                  onClick={() => onChangeZoomMultiplier(() => 1.0)}
                  className="p-0.5 rounded hover:bg-slate-200 text-slate-500"
                  title="Reset to 100% Auto-Fit"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              )}
            </div>
          )}

          {/* Toggle Content Annotation Toolbox (Teacher Content Mode Only, Shortcut Alt+T) */}
          {activeMode === 'content' && role === 'teacher' && onToggleContentToolbox && (
            <button
              type="button"
              data-testid="toggle-content-toolbox-btn"
              data-toolbox-visible={isContentToolboxVisible ? 'true' : 'false'}
              aria-label="Toggle Content Toolbox (Alt+T)"
              onClick={onToggleContentToolbox}
              className={`flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-lg transition-all shrink-0 ${
                isContentToolboxVisible
                  ? 'bg-[#12a3ff] hover:bg-[#0d8de0] text-white shadow-xs'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'
              }`}
              title="Toggle Toolbox (Alt+T)"
            >
              <PenTool className="w-4 h-4 shrink-0" />
            </button>
          )}

          {/* Full Screen / Exit Full Screen Toggle Button (Icon Only, No Text) */}
          {onToggleFullscreen && (
            <button
              type="button"
              data-testid="navbar-fullscreen-btn"
              data-fullscreen-state={isFullscreen ? 'true' : 'false'}
              aria-label={isFullscreen ? 'Exit Full Screen' : 'Full Screen'}
              onClick={onToggleFullscreen}
              className={`flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-lg transition-all shrink-0 ${
                isFullscreen
                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'
              }`}
              title={
                isFullscreen
                  ? 'Exit Full Screen Mode (Esc)'
                  : 'Enter Full Screen Mode'
              }
            >
              {isFullscreen ? (
                <Minimize2 className="w-4 h-4 shrink-0" />
              ) : (
                <Maximize2 className="w-4 h-4 shrink-0" />
              )}
            </button>
          )}

          {/* Mute / Unmute Toggle Button (Icon Only, No Text) */}
          {role === 'teacher' || hasStudentMicGrant ? (
            <button
              type="button"
              data-testid="mic-toggle-btn"
              aria-label={isLocalMicOn ? 'Mute Microphone' : 'Unmute Microphone'}
              onClick={onToggleLocalMic}
              className={`flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-lg transition-all shrink-0 ${
                isLocalMicOn
                  ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'
              }`}
              title={isLocalMicOn ? 'Mute Microphone' : 'Unmute Microphone'}
            >
              {isLocalMicOn ? (
                <Mic className="w-4 h-4 animate-pulse" />
              ) : (
                <MicOff className="w-4 h-4 text-rose-500" />
              )}
            </button>
          ) : (
            <button
              type="button"
              data-testid="raise-hand-btn"
              aria-label={hasRaisedHand ? 'Hand Raised' : 'Mic Muted — Raise Hand'}
              onClick={hasRaisedHand ? onLowerHand : onRaiseHand}
              className={`flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-lg transition-all shrink-0 ${
                hasRaisedHand
                  ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-xs'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'
              }`}
              title={
                hasRaisedHand
                  ? 'Hand Raised (Click to Lower Hand)'
                  : 'Microphone Muted by Default — Click to Raise Hand for Audio'
              }
            >
              <MicOff
                className={`w-4 h-4 ${
                  hasRaisedHand ? 'text-white' : 'text-rose-500'
                }`}
              />
            </button>
          )}

          {/* Users Icon Button (Opens Sidebar Drawer with Student & Teacher Tabs) */}
          <button
            type="button"
            data-testid="students-drawer-btn"
            aria-label="Open Classroom Users Drawer"
            onClick={() => setIsUsersDrawerOpen(true)}
            className="relative flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-700 transition-colors shrink-0"
            title="Open Users Drawer (Students & Teachers)"
          >
            <Users className="w-4 h-4 text-[#12a3ff]" />
            {raisedHandsCount > 0 && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-500 ring-2 ring-white animate-bounce" />
            )}
          </button>

          {/* Top-Right Leave Button (Icon Only, No Text) */}
          <button
            type="button"
            data-testid="navbar-leave-btn"
            aria-label="Leave Class"
            onClick={() => setIsLeaveModalOpen(true)}
            className="flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-600 transition-colors shrink-0"
            title={role === 'teacher' ? 'Leave Meeting or End Class' : 'Leave Class'}
          >
            <LogOut className="w-4 h-4 shrink-0" />
          </button>
        </div>
      </header>

      {/* CENTERED LEAVE / END CLASS CONFIRMATION MODAL */}
      {isLeaveModalOpen && (
        <div
          data-testid="leave-confirm-modal-backdrop"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs"
        >
          <div
            data-testid="leave-confirm-modal"
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-2xl p-6 space-y-5 animate-in fade-in zoom-in-95 duration-150"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center shrink-0">
                  <LogOut className="w-5 h-5" />
                </div>
                <div>
                  <h3
                    data-testid="leave-confirm-title"
                    className="text-base font-bold text-slate-900"
                  >
                    {role === 'teacher'
                      ? 'Leave Meeting or End Class?'
                      : 'Leave Live Classroom?'}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {role === 'teacher'
                      ? isHostTeacher
                        ? 'Host Teacher Session Controls'
                        : 'Co-Host Session Controls'
                      : 'Confirm leaving the live session'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsLeaveModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div
              data-testid="leave-confirm-message"
              className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 text-xs sm:text-sm text-slate-600 leading-relaxed"
            >
              {role === 'teacher' ? (
                <>
                  Are you sure you want to leave? Select{' '}
                  <strong className="text-slate-900">Leave Meeting</strong> to exit while
                  keeping the session active for others, or select{' '}
                  <strong className="text-rose-600">End Class</strong> to end the broadcast
                  and disconnect all participants.
                </>
              ) : (
                <>
                  Are you sure you want to leave this live classroom session? Your attendance
                  has been recorded and you can rejoin anytime while the broadcast is live.
                </>
              )}
            </div>

            <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2.5 pt-1">
              <button
                type="button"
                data-testid="cancel-leave-btn"
                onClick={() => setIsLeaveModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs sm:text-sm font-semibold transition-colors"
              >
                Cancel
              </button>

              <button
                type="button"
                data-testid="confirm-leave-meeting-btn"
                onClick={() => {
                  setIsLeaveModalOpen(false);
                  onLeaveMeeting?.();
                }}
                className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-colors ${
                  role === 'teacher'
                    ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-xs'
                    : 'bg-rose-600 hover:bg-rose-700 text-white shadow-xs'
                }`}
              >
                Leave Meeting
              </button>

              {role === 'teacher' && (
                <button
                  type="button"
                  data-testid="confirm-end-class-btn"
                  onClick={() => {
                    setIsLeaveModalOpen(false);
                    onEndClass?.();
                  }}
                  className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs sm:text-sm font-semibold shadow-xs transition-colors"
                >
                  End Class
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* SLIDE-OVER SIDEBAR DRAWER: Tab 1 = Students, Tab 2 = Teachers */}
      {isUsersDrawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-slate-900/20 backdrop-blur-xs transition-opacity"
            onClick={() => setIsUsersDrawerOpen(false)}
          />

          <div
            data-testid="users-sidebar-drawer"
            className="relative w-full max-w-md bg-white h-full shadow-2xl border-l border-slate-200 flex flex-col z-10"
          >
            {/* Drawer Header */}
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between bg-slate-50/70">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-[#12a3ff]" />
                <h2 className="text-sm font-bold text-slate-900">
                  Classroom Participants
                </h2>
              </div>
              <button
                type="button"
                data-testid="close-drawer-btn"
                onClick={() => setIsUsersDrawerOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Drawer Tabs: 1st = Student, 2nd = Teacher */}
            <div className="px-5 pt-3 pb-2 bg-white border-b border-slate-200">
              <div className="grid grid-cols-2 gap-1.5 bg-slate-100 p-1 rounded-xl border border-slate-200/80">
                <button
                  type="button"
                  data-testid="drawer-tab-student"
                  onClick={() => setActiveDrawerTab('student')}
                  className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-bold transition-all ${
                    activeDrawerTab === 'student'
                      ? 'bg-white text-[#12a3ff] shadow-xs border border-slate-200/60'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Users className="w-3.5 h-3.5" />
                  <span>Students</span>
                  <span className="px-1.5 py-0.2 rounded-full bg-slate-100 text-slate-700 text-[10px] font-bold">
                    {Math.max(participantsCount, attendanceList.length)}
                  </span>
                  {raisedHandsCount > 0 && (
                    <span className="px-1.5 py-0.2 rounded-full bg-amber-500 text-white text-[10px] font-bold">
                      {raisedHandsCount}
                    </span>
                  )}
                </button>

                <button
                  type="button"
                  data-testid="drawer-tab-teacher"
                  onClick={() => setActiveDrawerTab('teacher')}
                  className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-bold transition-all ${
                    activeDrawerTab === 'teacher'
                      ? 'bg-white text-indigo-600 shadow-xs border border-slate-200/60'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <GraduationCap className="w-3.5 h-3.5" />
                  <span>Teachers</span>
                  <span className="px-1.5 py-0.2 rounded-full bg-indigo-50 text-indigo-700 text-[10px] font-bold">
                    {1 + invitedTeachers.length}
                  </span>
                </button>
              </div>
            </div>

            {/* ============================================================== */}
            {/* TAB 1: STUDENTS (All Student List & Student-Related Controls)  */}
            {/* ============================================================== */}
            {activeDrawerTab === 'student' && (
              <>
                {/* Max 10 Student Mics Status Bar */}
                <div className="px-5 py-2.5 bg-slate-50/60 border-b border-slate-200 flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${
                        activeMicsCount >= maxMics
                          ? 'bg-rose-50 text-rose-700 border border-rose-200'
                          : 'bg-sky-50 text-[#12a3ff] border border-sky-200'
                      }`}
                    >
                      <Mic className="w-3 h-3" />
                      <span>
                        {activeMicsCount} / {maxMics} Active Student Mics
                      </span>
                    </span>

                    {/* Host/Co-Host Option: Allow all students to mute/unmute freely (Open Mic Mode) */}
                    {role === 'teacher' && onToggleAllowStudentUnmute && (
                      <button
                        type="button"
                        data-testid="toggle-allow-student-unmute-btn"
                        onClick={() =>
                          onToggleAllowStudentUnmute(!Boolean(audioStage.allowStudentUnmute))
                        }
                        className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${
                          audioStage.allowStudentUnmute
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-300 hover:bg-emerald-100 shadow-2xs'
                            : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200'
                        }`}
                        title={
                          audioStage.allowStudentUnmute
                            ? 'Students can currently unmute themselves freely. Click to restrict (require raising hand).'
                            : 'Students are currently muted by default. Click to allow all students to unmute themselves.'
                        }
                      >
                        {audioStage.allowStudentUnmute ? (
                          <>
                            <Volume2 className="w-3.5 h-3.5 text-emerald-600" />
                            <span>Students Can Unmute: ON</span>
                          </>
                        ) : (
                          <>
                            <VolumeX className="w-3.5 h-3.5 text-slate-500" />
                            <span>Allow Students to Unmute</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  {role === 'teacher' && activeMicsCount > 0 && (
                    <button
                      type="button"
                      data-testid="mute-all-students-btn"
                      onClick={onMuteAllStudents}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 text-xs font-semibold transition-colors"
                    >
                      <VolumeX className="w-3.5 h-3.5" />
                      <span>Mute All ({activeMicsCount})</span>
                    </button>
                  )}
                </div>

                {/* Validation Error Banner when >10 Student Mics attempted */}
                {micValidationError && (
                  <div className="mx-5 mt-3 p-3 rounded-xl bg-rose-50 border border-rose-200 flex items-start gap-2 text-xs text-rose-700">
                    <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <div className="font-bold">Audio Stage Capacity Reached</div>
                      <div className="mt-0.5">{micValidationError}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setMicValidationError(null)}
                      className="text-rose-400 hover:text-rose-700"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                <div className="flex-1 overflow-y-auto p-5 space-y-5">
                  {/* Section 1: Raised Hands Queue */}
                  {audioStage.raisedHands.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-xs font-bold uppercase tracking-wider text-amber-600 flex items-center gap-1.5">
                        <Hand className="w-3.5 h-3.5" />
                        <span>Raised Hands Queue ({audioStage.raisedHands.length})</span>
                      </div>
                      <div className="space-y-2">
                        {audioStage.raisedHands.map((hand) => {
                          const normHandId = hand.studentId.startsWith('student_')
                            ? hand.studentId
                            : `student_${hand.studentId}`;
                          const hasHandWbAccess =
                            whiteboardEditors.includes(hand.studentId) ||
                            whiteboardEditors.includes(normHandId);

                          return (
                            <div
                              key={hand.studentId}
                              className="flex items-center justify-between p-3 rounded-xl bg-amber-50/70 border border-amber-200"
                            >
                              <div>
                                <div className="text-xs font-bold text-slate-900">
                                  {hand.studentName}
                                </div>
                                <div className="text-[11px] text-amber-700">
                                  Requested at {formatClockTime(hand.raisedAt)}
                                </div>
                              </div>
                              {role === 'teacher' && (
                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      hasHandWbAccess
                                        ? onRevokeWhiteboardAccess(normHandId)
                                        : onGrantWhiteboardAccess(normHandId)
                                    }
                                    className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold transition-colors ${
                                      hasHandWbAccess
                                        ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-2xs'
                                        : 'bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200'
                                    }`}
                                    title={
                                      hasHandWbAccess
                                        ? 'Revoke Student Whiteboard Edit Access'
                                        : 'Grant Student Access to Edit Whiteboard'
                                    }
                                  >
                                    <PenTool className="w-3 h-3" />
                                    <span>
                                      {hasHandWbAccess ? 'Revoke Board' : 'Allow Board'}
                                    </span>
                                  </button>

                                  {activeMicsCount >= maxMics ? (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleReplaceOldestSpeakerAndApprove(
                                          hand.studentId,
                                          hand.studentName
                                        )
                                      }
                                      className="px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold shadow-2xs transition-colors"
                                    >
                                      Mute Oldest & Allow
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleApproveMic(hand.studentId, hand.studentName)
                                      }
                                      className="px-2.5 py-1 rounded-lg bg-[#12a3ff] hover:bg-[#0d8de0] text-white text-xs font-semibold shadow-2xs transition-colors"
                                    >
                                      Allow Mic
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Section 2: Active Student Microphones */}
                  {audioStage.activeStudentMics.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-xs font-bold uppercase tracking-wider text-emerald-600 flex items-center gap-1.5">
                        <Mic className="w-3.5 h-3.5" />
                        <span>
                          Live Student Speakers ({audioStage.activeStudentMics.length})
                        </span>
                      </div>
                      <div className="space-y-2">
                        {audioStage.activeStudentMics.map((speaker) => {
                          const normSpeakerId = speaker.studentId.startsWith('student_')
                            ? speaker.studentId
                            : `student_${speaker.studentId}`;
                          const hasSpeakerWbAccess =
                            whiteboardEditors.includes(speaker.studentId) ||
                            whiteboardEditors.includes(normSpeakerId);

                          return (
                            <div
                              key={speaker.studentId}
                              className="flex items-center justify-between p-3 rounded-xl bg-emerald-50/70 border border-emerald-200"
                            >
                              <div className="flex items-center gap-2.5">
                                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping" />
                                <div>
                                  <div className="text-xs font-bold text-slate-900">
                                    {speaker.studentName}
                                  </div>
                                  <div className="text-[11px] text-emerald-700">
                                    Speaking since {formatClockTime(speaker.grantedAt)}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-1.5">
                                {role === 'teacher' && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      hasSpeakerWbAccess
                                        ? onRevokeWhiteboardAccess(normSpeakerId)
                                        : onGrantWhiteboardAccess(normSpeakerId)
                                    }
                                    className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold transition-colors ${
                                      hasSpeakerWbAccess
                                        ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-2xs'
                                        : 'bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200'
                                    }`}
                                  >
                                    <PenTool className="w-3 h-3" />
                                    <span>
                                      {hasSpeakerWbAccess ? 'Revoke Board' : 'Allow Board'}
                                    </span>
                                  </button>
                                )}
                                {(role === 'teacher' || speaker.studentId === userId) && (
                                  <button
                                    type="button"
                                    onClick={() => onRevokeStudentMic(speaker.studentId)}
                                    className="px-2.5 py-1 rounded-lg bg-white hover:bg-rose-50 text-rose-600 border border-rose-200 text-xs font-semibold transition-colors"
                                  >
                                    Mute Mic
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Section 3: Joined Students List & Student Whiteboard/Mic Access */}
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                        Joined Students ({attendanceList.length})
                      </span>
                      <span className="text-[11px] text-slate-400">
                        Mic & Whiteboard Permissions
                      </span>
                    </div>

                    {attendanceList.length === 0 ? (
                      <div className="p-6 rounded-xl bg-slate-50 border border-slate-200 text-center text-xs text-slate-500">
                        No students recorded yet in this session.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {attendanceList.map((student) => {
                          const normStId = student.studentId.startsWith('student_')
                            ? student.studentId
                            : `student_${student.studentId}`;
                          const isMicGranted = audioStage.activeStudentMics.some(
                            (m) =>
                              m.studentId === student.studentId || m.studentId === normStId
                          );
                          const hasStudentWbAccess =
                            whiteboardEditors.includes(student.studentId) ||
                            whiteboardEditors.includes(normStId);
                          const isMultiDeviceAllowed =
                            multiDeviceStudents.includes(student.studentId) ||
                            multiDeviceStudents.includes(normStId);

                          return (
                            <div
                              key={student.studentId}
                              data-testid={`student-row-${student.studentId}`}
                              className="p-3 rounded-xl bg-white border border-slate-200 hover:border-slate-300 transition-all shadow-2xs space-y-2"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  <div className="relative w-7 h-7 rounded-full bg-slate-100 text-slate-700 flex items-center justify-center text-xs font-bold shrink-0">
                                    {(student.studentName || 'Student')
                                      .split(' ')
                                      .map((n) => n[0])
                                      .join('')
                                      .slice(0, 2)}
                                    <span
                                      className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white ${
                                        student.isOnline
                                          ? 'bg-emerald-500'
                                          : 'bg-slate-400'
                                      }`}
                                    />
                                  </div>
                                  <div className="min-w-0">
                                    <div className="text-xs font-bold text-slate-900 truncate flex items-center gap-1.5 flex-wrap">
                                      <span>{student.studentName}</span>
                                      <span
                                        className={`px-1.5 py-0.2 rounded text-[10px] font-semibold ${
                                          student.status === 'PRESENT'
                                            ? 'bg-emerald-50 text-emerald-700'
                                            : student.status === 'PARTIAL'
                                            ? 'bg-amber-50 text-amber-700'
                                            : 'bg-slate-100 text-slate-600'
                                        }`}
                                      >
                                        {student.status}
                                      </span>
                                      {hasStudentWbAccess && (
                                        <span
                                          data-testid={`student-wb-tag-${student.studentId}`}
                                          className="px-1.5 py-0.2 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-semibold"
                                        >
                                          Board Editor
                                        </span>
                                      )}
                                      {isMultiDeviceAllowed && (
                                        <span
                                          data-testid={`student-multidevice-tag-${student.studentId}`}
                                          className="px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-semibold"
                                        >
                                          Multi-Device
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-[11px] text-slate-500 flex items-center gap-2">
                                      <span>In: {formatClockTime(student.firstJoinedAt)}</span>
                                      {!student.isOnline && student.leftAt && (
                                        <span>• Out: {formatClockTime(student.leftAt)}</span>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                {/* Teacher 1-click Whiteboard Edit Access + Multi-Device Toggle + Mic Allow/Mute buttons */}
                                {role === 'teacher' && (
                                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                                    {isHostTeacher && onToggleStudentMultiDevice && (
                                      <button
                                        type="button"
                                        data-testid={`multi-device-btn-${normStId}`}
                                        onClick={() =>
                                          onToggleStudentMultiDevice(
                                            normStId,
                                            !isMultiDeviceAllowed
                                          )
                                        }
                                        className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold transition-colors ${
                                          isMultiDeviceAllowed
                                            ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-2xs'
                                            : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'
                                        }`}
                                        title={
                                          isMultiDeviceAllowed
                                            ? 'Multi-Device Join Allowed for this student (Click to restrict to 1 device)'
                                            : 'Restricted to 1 Device only (Click to allow this student to join from multiple devices)'
                                        }
                                      >
                                        <span>
                                          {isMultiDeviceAllowed
                                            ? 'Multi-Device: ON'
                                            : '1 Device Only'}
                                        </span>
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      data-testid={`wb-access-btn-${normStId}`}
                                      onClick={() =>
                                        hasStudentWbAccess
                                          ? onRevokeWhiteboardAccess(normStId)
                                          : onGrantWhiteboardAccess(normStId)
                                      }
                                      className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold transition-colors ${
                                        hasStudentWbAccess
                                          ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-2xs'
                                          : 'bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200'
                                      }`}
                                      title={
                                        hasStudentWbAccess
                                          ? 'Revoke Student Whiteboard Edit Access'
                                          : 'Grant Student Access to Edit Whiteboard'
                                      }
                                    >
                                      <PenTool className="w-3 h-3" />
                                      <span>
                                        {hasStudentWbAccess ? 'Revoke Board' : 'Allow Board'}
                                      </span>
                                    </button>

                                    {student.isOnline && (
                                      <button
                                        type="button"
                                        data-testid={`mic-access-btn-${student.studentId}`}
                                        onClick={() =>
                                          isMicGranted
                                            ? onRevokeStudentMic(student.studentId)
                                            : handleApproveMic(
                                                student.studentId,
                                                student.studentName
                                              )
                                        }
                                        className={`px-2 py-1 rounded-lg text-xs font-semibold transition-colors ${
                                          isMicGranted
                                            ? 'bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200'
                                            : 'bg-sky-50 hover:bg-[#12a3ff] text-[#12a3ff] hover:text-white border border-sky-200'
                                        }`}
                                      >
                                        {isMicGranted ? 'Mute Mic' : 'Allow Mic'}
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>

                              {/* Attendance Metrics Row */}
                              <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-600">
                                <span className="flex items-center gap-1">
                                  <Clock className="w-3 h-3 text-slate-400" />
                                  <strong className="text-slate-800">
                                    {student.totalJoinedMinutes} min
                                  </strong>{' '}
                                  ({student.totalJoinedHours} hrs)
                                </span>
                                <span className="flex items-center gap-1">
                                  <RefreshCw className="w-3 h-3 text-slate-400" />
                                  Rejoins:{' '}
                                  <strong className="text-slate-800">
                                    {student.rejoinCount}
                                  </strong>
                                </span>
                                <span className="flex items-center gap-1 font-semibold text-emerald-700">
                                  <CheckCircle2 className="w-3 h-3" />
                                  {student.attendancePercentage}%
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* ============================================================== */}
            {/* TAB 2: TEACHERS (Host Teacher, Invite Teacher & Co-Teachers)   */}
            {/* ============================================================== */}
            {activeDrawerTab === 'teacher' && (
              <div className="flex-1 overflow-y-auto p-5 space-y-5">
                {/* Host Teacher Info Card */}
                <div className="space-y-2">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    Host Teacher
                  </div>
                  <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="relative flex items-center justify-center w-9 h-9 rounded-full bg-[#12a3ff]/10 text-[#12a3ff] text-xs font-bold shrink-0">
                        {(teacherName || 'Teacher')
                          .split(' ')
                          .map((n) => n[0])
                          .join('')
                          .slice(0, 2)}
                        <span
                          className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white ${
                            isConnected ? 'bg-emerald-500' : 'bg-rose-500'
                          }`}
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-slate-900 truncate flex items-center gap-1.5">
                          <span>{teacherName}</span>
                          <span className="px-1.5 py-0.2 rounded bg-sky-50 text-[#12a3ff] border border-sky-200 text-[10px] font-semibold">
                            Host
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-500 flex items-center gap-1.5 mt-0.5">
                          <span>
                            {audioStage.teacherMicActive ? 'Mic Live' : 'Mic Muted'}
                          </span>
                          <span>•</span>
                          <span>Whiteboard Owner</span>
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      data-testid="noise-cancellation-btn"
                      onClick={onToggleNoiseCancellation}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors shrink-0 ${
                        isNoiseCancellationEnabled
                          ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200'
                          : 'bg-slate-100 hover:bg-slate-200 text-slate-600 border-slate-200'
                      }`}
                      title="Toggle Real-Time WebRTC + Web Audio DSP Noise Cancellation"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>{isNoiseCancellationEnabled ? 'NC On' : 'NC Off'}</span>
                    </button>
                  </div>
                </div>

                {/* Co-Teacher Invitation & Whiteboard Access (Teacher Tab Only) */}
                <div className="space-y-3 p-3.5 rounded-xl bg-indigo-50/50 border border-indigo-200/80">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-bold uppercase tracking-wider text-indigo-700 flex items-center gap-1.5">
                      <UserPlus className="w-3.5 h-3.5" />
                      <span>Invited Co-Teachers ({invitedTeachers.length})</span>
                    </div>
                    <span className="text-[10px] font-semibold text-indigo-600 bg-indigo-100/80 px-2 py-0.5 rounded-full">
                      Multi-Teacher Stage
                    </span>
                  </div>

                  {role === 'teacher' && isHostTeacher && (
                    <div className="space-y-2.5 bg-white p-3 rounded-lg border border-indigo-100 shadow-2xs">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-slate-700 flex items-center gap-1.5">
                          <Link2 className="w-3.5 h-3.5 text-indigo-600" />
                          <span>Share Co-Host Invite Link</span>
                        </span>
                        <span className="text-[10px] text-slate-400">
                          Co-Host joins via link
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          readOnly
                          data-testid="cohost-invite-link-input"
                          value={coHostInviteUrl}
                          onFocus={(e) => e.currentTarget.select()}
                          className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono text-slate-700 focus:outline-none focus:border-indigo-500"
                        />
                        <button
                          type="button"
                          data-testid="copy-cohost-link-btn"
                          onClick={handleCopyCoHostLink}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shadow-2xs transition-colors shrink-0 ${
                            isCoHostLinkCopied
                              ? 'bg-emerald-600 text-white'
                              : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                          }`}
                        >
                          {isCoHostLinkCopied ? (
                            <>
                              <Check className="w-3.5 h-3.5" />
                              <span>Copied!</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              <span>Copy Link</span>
                            </>
                          )}
                        </button>
                      </div>

                      <label className="flex items-center gap-2 text-[11px] text-slate-600 cursor-pointer select-none pt-0.5">
                        <input
                          type="checkbox"
                          data-testid="invite-coteacher-wb-checkbox"
                          checked={inviteWithWhiteboard}
                          onChange={(e) => {
                            const nextVal = e.target.checked;
                            setInviteWithWhiteboard(nextVal);
                            if (onRefreshCoHostInviteToken) {
                              onRefreshCoHostInviteToken(nextVal).catch(() => {});
                            }
                            invitedTeachers.forEach((t) => {
                              if (
                                t.teacherId.startsWith('teacher_cohost') ||
                                t.teacherId === 'cohost' ||
                                t.teacherId === 'teacher_502'
                              ) {
                                onToggleCoTeacherWhiteboard(t.teacherId, nextVal);
                              }
                            });
                          }}
                          className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span>Grant Whiteboard drawing & editing access to Co-Host</span>
                      </label>
                    </div>
                  )}

                  {invitedTeachers.length === 0 ? (
                    <div className="text-xs text-slate-500 text-center py-2">
                      No co-teachers invited yet. Host can invite another teacher and grant Whiteboard access.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {invitedTeachers.map((ct) => (
                        <div
                          key={ct.teacherId}
                          data-testid={`invited-coteacher-row-${ct.teacherId}`}
                          className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-white border border-indigo-200/80 shadow-2xs"
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-bold text-slate-900 truncate flex items-center gap-1.5">
                              <span>{ct.name}</span>
                              <span className="px-1.5 py-0.2 rounded bg-indigo-50 text-indigo-700 text-[10px] font-semibold">
                                Co-Teacher
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {ct.canUseWhiteboard
                                ? 'Whiteboard Access: Enabled (Can Draw & Edit)'
                                : 'Whiteboard Access: View Only'}
                            </div>
                          </div>

                          {role === 'teacher' && isHostTeacher && (
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                data-testid={`coteacher-wb-toggle-${ct.teacherId}`}
                                onClick={() =>
                                  onToggleCoTeacherWhiteboard(
                                    ct.teacherId,
                                    !ct.canUseWhiteboard
                                  )
                                }
                                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                                  ct.canUseWhiteboard
                                    ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200'
                                    : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200'
                                }`}
                                title="Toggle Co-Teacher Whiteboard Access"
                              >
                                <PenTool className="w-3 h-3" />
                                <span>{ct.canUseWhiteboard ? 'WB On' : 'WB Off'}</span>
                              </button>
                              <button
                                type="button"
                                data-testid={`coteacher-remove-${ct.teacherId}`}
                                onClick={() => onRemoveCoTeacher(ct.teacherId)}
                                className="p-1 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                                title="Remove Co-Teacher"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
