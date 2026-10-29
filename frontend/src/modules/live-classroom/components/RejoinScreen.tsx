'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Video,
  LogOut,
  RefreshCw,
  Users,
  CheckCircle2,
  AlertCircle,
  Clock,
  BookOpen,
  User,
  ArrowRight,
  Sparkles,
  Layers,
} from 'lucide-react';
import { CurriculumClient } from '../services/curriculumClient';

export interface BatchItem {
  sessionId: string;
  name: string;
  subject: string;
  teacherName: string;
}

interface SessionStatusData {
  sessionId: string;
  status: 'LIVE' | 'ENDED' | 'TEACHER_RECONNECTING';
  isActive: boolean;
  roomName: string;
  title: string;
  batchName?: string;
  courseName?: string;
  subjectName?: string;
  teacherName?: string;
  lessonTitle?: string;
  onlineCount?: number;
}

function parseUserFromToken(token: string): {
  name?: string;
  role?: 'teacher' | 'student';
  userId?: string;
  sessionId?: string;
} {
  if (!token || token.split('.').length !== 3) return {};
  try {
    const parts = token.split('.');
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(typeof window !== 'undefined' ? window.atob(padded) : '');
    return {
      name: payload.name,
      role: payload.role === 'student' ? 'student' : payload.role === 'teacher' ? 'teacher' : undefined,
      userId: payload.userId ? String(payload.userId) : undefined,
      sessionId: payload.sessionId ? String(payload.sessionId) : undefined,
    };
  } catch {
    return {};
  }
}

export default function RejoinScreen() {
  const searchParams = useSearchParams();
  const [hasMounted, setHasMounted] = useState<boolean>(false);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  const rawQuerySessionId = searchParams?.get('sessionId') || '';

  const token =
    searchParams?.get('token') ||
    (typeof window !== 'undefined'
      ? sessionStorage.getItem('broadcast_rejoin_token') ||
        sessionStorage.getItem('broadcast_ended_token') ||
        (rawQuerySessionId
          ? (() => {
              try {
                return localStorage.getItem(`broadcast_rejoin_token_${rawQuerySessionId}`) || '';
              } catch {
                return '';
              }
            })()
          : '')
      : '');
  const tokenClaims = useMemo(() => parseUserFromToken(token), [token]);

  // URL Parameters validated against token claims
  const initialSessionId =
    rawQuerySessionId ||
    tokenClaims.sessionId ||
    (typeof window !== 'undefined'
      ? sessionStorage.getItem('broadcast_rejoin_session_id') ||
        sessionStorage.getItem('broadcast_ended_session_id') ||
        ''
      : '');
  const role =
    tokenClaims.role ||
    ((searchParams?.get('role') as 'teacher' | 'student') || 'student');
  const studentId =
    (role === 'student' ? tokenClaims.userId : undefined) ||
    searchParams?.get('studentId') ||
    '';
  const teacherId =
    (role === 'teacher' ? tokenClaims.userId : undefined) ||
    searchParams?.get('teacherId') ||
    '';
  const wasEnded = searchParams?.get('ended') === 'true';

  const selectedSessionId = initialSessionId;
  const [statusData, setStatusData] = useState<SessionStatusData | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const currentUserName = useMemo(() => {
    if (tokenClaims.name) {
      return `${tokenClaims.name} (${role === 'teacher' ? 'Instructor' : 'Student'})`;
    }
    return role === 'teacher' ? 'Verified Instructor' : 'Verified Student';
  }, [tokenClaims.name, role]);

  // Fetch session status
  const checkStatus = useCallback(
    async (sessId: string, isManual = false) => {
      if (!sessId || !token) {
        setIsLoading(false);
        return;
      }
      if (isManual) setIsRefreshing(true);
      try {
        const data = await CurriculumClient.fetchSessionStatus(sessId, token);
        setStatusData(data);
        setError(null);
      } catch (err: any) {
        if (err?.status === 401 || err?.status === 403) {
          setError('Your classroom session token has expired or is invalid. Please launch the live class from Zerix Academy.');
        } else {
          setStatusData((prev) => ({
            sessionId: sessId,
            status: wasEnded && sessId === initialSessionId ? 'ENDED' : prev?.status || 'LIVE',
            isActive: wasEnded && sessId === initialSessionId ? false : prev?.isActive ?? true,
            roomName: prev?.roomName || 'Live Classroom Session',
            title: prev?.title || 'Live Classroom Session',
            subjectName: prev?.subjectName,
            teacherName: prev?.teacherName,
            onlineCount: prev?.onlineCount || 0,
          }));
        }
      } finally {
        setIsLoading(false);
        if (isManual) {
          setTimeout(() => setIsRefreshing(false), 300);
        }
      }
    },
    [wasEnded, initialSessionId, token]
  );

  // Initial load and batch change
  useEffect(() => {
    setIsLoading(true);
    checkStatus(selectedSessionId);
  }, [selectedSessionId, checkStatus]);

  // Periodic polling every 4 seconds to detect live teacher resumption or end
  useEffect(() => {
    if (!selectedSessionId || !token) return;
    const timer = setInterval(() => {
      checkStatus(selectedSessionId);
    }, 4000);
    return () => clearInterval(timer);
  }, [selectedSessionId, token, checkStatus]);

  // If the session is ended, clear active rejoin keys so visiting studio.zerixtech.com does not auto-verify/redirect
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isConfirmedEnded = statusData ? statusData.status === 'ENDED' : wasEnded;
    if (isConfirmedEnded) {
      if (token) {
        sessionStorage.setItem('broadcast_ended_token', token);
      }
      if (selectedSessionId) {
        sessionStorage.setItem('broadcast_ended_session_id', selectedSessionId);
        sessionStorage.setItem('broadcast_session_ended', selectedSessionId);
        try {
          localStorage.removeItem(`broadcast_rejoin_token_${selectedSessionId}`);
        } catch {
          // Ignore localStorage cleanup errors
        }
      }
      sessionStorage.removeItem('broadcast_rejoin_token');
      sessionStorage.removeItem('broadcast_rejoin_session_id');
      sessionStorage.removeItem('broadcast_rejoin_authorized');
    } else if (statusData && statusData.status !== 'ENDED') {
      sessionStorage.removeItem('broadcast_session_ended');
      if (token) {
        sessionStorage.setItem('broadcast_rejoin_token', token);
      }
      if (selectedSessionId) {
        sessionStorage.setItem('broadcast_rejoin_session_id', selectedSessionId);
        sessionStorage.setItem('broadcast_rejoin_authorized', selectedSessionId);
        if (token) {
          try {
            localStorage.setItem(`broadcast_rejoin_token_${selectedSessionId}`, token);
          } catch {
            // Ignore localStorage write errors
          }
        }
      }
    }
  }, [wasEnded, statusData, token, selectedSessionId]);

  // Navigate back into classroom (strictly authorized from /rejoin page only when session is active)
  const handleRejoin = () => {
    if (statusData?.status === 'ENDED') return;
    sessionStorage.removeItem('broadcast_session_ended');
    sessionStorage.removeItem('broadcast_session_left');
    if (token) {
      sessionStorage.setItem('broadcast_rejoin_token', token);
      sessionStorage.setItem('broadcast_rejoin_session_id', selectedSessionId);
      sessionStorage.setItem('broadcast_rejoin_authorized', selectedSessionId);
      try {
        localStorage.setItem(`broadcast_rejoin_token_${selectedSessionId}`, token);
      } catch {
        // Ignore localStorage write errors
      }
    }
    const params = new URLSearchParams({
      sessionId: selectedSessionId,
      role,
      ...(studentId ? { studentId } : {}),
      ...(teacherId ? { teacherId } : {}),
      rejoin: 'true',
    });
    window.location.href = `/?${params.toString()}`;
  };

  // Host Teacher: Restart class if ended
  const handleRestartClass = () => {
    sessionStorage.removeItem('broadcast_session_ended');
    sessionStorage.removeItem('broadcast_session_left');
    if (token) {
      sessionStorage.setItem('broadcast_rejoin_token', token);
      sessionStorage.setItem('broadcast_rejoin_session_id', selectedSessionId);
      sessionStorage.setItem('broadcast_restart_authorized', selectedSessionId);
      sessionStorage.removeItem('broadcast_session_ended');
      try {
        localStorage.setItem(`broadcast_rejoin_token_${selectedSessionId}`, token);
      } catch {
        // Ignore localStorage write errors
      }
    }
    const params = new URLSearchParams({
      sessionId: selectedSessionId,
      role: 'teacher',
      ...(teacherId ? { teacherId } : {}),
      restart: 'true',
    });
    window.location.href = `/?${params.toString()}`;
  };

  const academyPortalUrl = (
    process.env.NEXT_PUBLIC_ACADEMY_PORTAL_URL ||
    ''
  ).replace(/\/+$/, '');

  if (!hasMounted) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-slate-50 text-slate-900">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-sky-600" />
          <p className="text-xs font-medium text-slate-600">Loading Classroom Portal...</p>
        </div>
      </div>
    );
  }

  if (!selectedSessionId || !token || error) {
    return (
      <div
        data-testid="rejoin-unauthorized-container"
        className="h-dvh min-h-screen w-full overflow-y-auto overflow-x-hidden scroll-smooth bg-gradient-to-br from-slate-50 via-white to-sky-50/60 text-slate-900 flex items-center justify-center p-4 sm:p-6"
      >
        <div className="max-w-md w-full my-auto rounded-3xl bg-white border border-slate-200/90 shadow-xl p-6 sm:p-8 text-center space-y-5">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-rose-50 border border-rose-200 flex items-center justify-center text-rose-600">
            <AlertCircle className="w-7 h-7" />
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-bold text-slate-900">Classroom Authentication Required</h1>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
              {error ||
                'Direct access to Zerix Live Broadcast Studio is restricted. Please sign in to Zerix Academy and join your scheduled live classroom.'}
            </p>
          </div>
          <a
            href={academyPortalUrl}
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-2xl bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-600 hover:to-indigo-700 text-white text-sm font-bold shadow-md shadow-sky-500/20 transition-all"
          >
            <span>Return to Zerix Academy</span>
            <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      </div>
    );
  }

  const isActive = statusData ? statusData.isActive : !wasEnded;
  const rawRoomTitle = statusData?.roomName || statusData?.title || '';
  const roomTitle =
    rawRoomTitle && rawRoomTitle !== selectedSessionId
      ? rawRoomTitle
      : statusData?.courseName || statusData?.batchName || 'Live Classroom Session';

  return (
    <div
      data-testid="rejoin-screen-container"
      className="h-dvh min-h-screen w-full overflow-y-auto overflow-x-hidden scroll-smooth bg-gradient-to-br from-slate-50 via-white to-sky-50/60 text-slate-900 flex flex-col justify-between p-4 sm:p-6 lg:p-8"
    >
      {/* 1. Header Bar */}
      <header className="max-w-4xl mx-auto w-full flex flex-wrap items-center justify-between gap-3 pb-4 sm:pb-6 border-b border-slate-200/80 shrink-0">
        <div className="flex items-center space-x-3 min-w-0">
          <div className="w-10 h-10 shrink-0 rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center shadow-md shadow-sky-500/20 text-white font-bold">
            <Video className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm sm:text-lg font-bold tracking-tight text-slate-900 truncate">
              Zerix Live Broadcast Studio
            </h1>
            <p className="text-[11px] sm:text-xs text-slate-500 truncate">
              Interactive Classroom Session Portal
            </p>
          </div>
        </div>

        {/* User Badge */}
        <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-white border border-slate-200 shadow-sm text-xs text-slate-700 max-w-full">
          <User className="w-3.5 h-3.5 text-sky-600 shrink-0" />
          <span className="font-semibold truncate max-w-[180px] sm:max-w-[260px]">
            {currentUserName}
          </span>
        </div>
      </header>

      {/* 2. Main Rejoin Card */}
      <main className="max-w-xl mx-auto w-full my-auto py-6 sm:py-8 shrink-0">
        <div className="relative rounded-3xl bg-white border border-slate-200/90 shadow-xl p-5 sm:p-8 overflow-hidden transition-all duration-300">
          {/* Subtle Ambient Glow */}
          <div
            className={`absolute -top-24 -right-24 w-60 h-60 rounded-full blur-3xl pointer-events-none opacity-25 ${
              isActive ? 'bg-sky-200' : 'bg-rose-200'
            }`}
          />
          <div
            className={`absolute -bottom-24 -left-24 w-60 h-60 rounded-full blur-3xl pointer-events-none opacity-20 ${
              isActive ? 'bg-emerald-200' : 'bg-amber-200'
            }`}
          />

          {/* Top Status Pill & Refresh */}
          <div className="relative flex flex-wrap items-center justify-between gap-2 mb-5 sm:mb-6">
            <div
              data-testid="room-status-badge"
              className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                isActive
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-rose-50 text-rose-700 border border-rose-200'
              }`}
            >
              <span className="relative flex h-2 w-2">
                {isActive && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75"></span>
                )}
                <span
                  className={`relative inline-flex rounded-full h-2 w-2 ${
                    isActive ? 'bg-emerald-500' : 'bg-rose-500'
                  }`}
                ></span>
              </span>
              <span>{isActive ? 'Classroom is Live & Active' : 'Class Broadcast Ended'}</span>
            </div>

            <button
              type="button"
              data-testid="refresh-status-btn"
              onClick={() => checkStatus(selectedSessionId, true)}
              disabled={isRefreshing}
              title="Refresh Room Status"
              className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200/80 text-slate-600 hover:text-slate-900 transition-colors border border-slate-200"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-sky-600' : ''}`} />
            </button>
          </div>

          {/* Room Name & Classroom Information */}
          <div className="relative space-y-3 mb-6">
            <div className="flex items-center gap-2 text-xs font-semibold tracking-wider uppercase text-sky-600">
              <BookOpen className="w-4 h-4 shrink-0" />
              <span>Room / Classroom</span>
            </div>

            <h2
              data-testid="rejoin-room-name"
              className="text-lg sm:text-2xl font-extrabold text-slate-900 tracking-tight leading-snug break-words"
            >
              {roomTitle}
            </h2>

            {statusData?.lessonTitle && (
              <p className="text-xs sm:text-sm text-slate-600 leading-relaxed break-words">
                {statusData.lessonTitle}
              </p>
            )}

            {/* Room Metadata Chips (Session/Card ID hidden by design) */}
            {(statusData?.subjectName ||
              statusData?.teacherName ||
              (isActive && typeof statusData?.onlineCount === 'number')) && (
              <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-slate-700">
                {statusData?.subjectName && (
                  <span className="px-2.5 py-1 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-700 font-medium">
                    {statusData.subjectName}
                  </span>
                )}
                {statusData?.teacherName && (
                  <span className="px-2.5 py-1 rounded-lg bg-slate-100 border border-slate-200 text-slate-700 font-medium">
                    Instructor: {statusData.teacherName}
                  </span>
                )}
                {isActive && typeof statusData?.onlineCount === 'number' && (
                  <span
                    data-testid="room-online-count"
                    className="px-2.5 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 font-medium flex items-center gap-1.5"
                  >
                    <Users className="w-3.5 h-3.5" />
                    {statusData.onlineCount} {statusData.onlineCount === 1 ? 'attendee' : 'attendees'} online
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Conditional Screen Content: Active Room vs Ended Room */}
          {isActive ? (
            /* ACTIVE ROOM STATE: Show Rejoin Button */
            <div
              data-testid="rejoin-active-state"
              className="relative space-y-4 sm:space-y-5 rounded-2xl bg-slate-50/90 border border-emerald-200/80 p-4 sm:p-5 mt-4"
            >
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-emerald-100 text-emerald-700 mt-0.5 shrink-0">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-slate-900">Live Session Ready</h3>
                  <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
                    You have left the broadcast. The teacher and classmates are currently active in this
                    classroom. Click below to rejoin with your preserved role and state.
                  </p>
                </div>
              </div>

              {/* REJOIN BUTTON */}
              <button
                type="button"
                data-testid="rejoin-classroom-btn"
                onClick={handleRejoin}
                className="w-full flex items-center justify-center gap-2.5 px-5 sm:px-6 py-3 sm:py-3.5 rounded-2xl bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-600 hover:to-indigo-700 text-white text-sm sm:text-base font-bold shadow-md shadow-sky-500/20 transition-all duration-200 transform hover:-translate-y-0.5 active:translate-y-0"
              >
                <span>Rejoin Classroom</span>
                <ArrowRight className="w-5 h-5" />
              </button>
            </div>
          ) : (
            /* ENDED ROOM STATE: Rejoin Button is NOT Visible; Show Concluded Message */
            <div
              data-testid="rejoin-ended-state"
              className="relative space-y-4 rounded-2xl bg-slate-50/90 border border-rose-200/80 p-4 sm:p-5 mt-4"
            >
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-rose-100 text-rose-600 mt-0.5 shrink-0">
                  <Clock className="w-5 h-5" />
                </div>
                <div className="space-y-1 min-w-0">
                  <h3 data-testid="class-ended-heading" className="text-sm font-bold text-slate-900">
                    Class Concluded
                  </h3>
                  <p
                    data-testid="class-ended-description"
                    className="text-xs sm:text-sm text-slate-600 leading-relaxed"
                  >
                    {role === 'teacher'
                      ? 'You have ended this class broadcast session. All participants have been dismissed and attendance logs have been finalized.'
                      : 'The instructor has concluded this live class. Rejoining is not available because the session has ended. Thank you for attending!'}
                  </p>
                </div>
              </div>

              {/* Host Teacher Restart Option */}
              {role === 'teacher' && (
                <div className="pt-2">
                  <button
                    type="button"
                    data-testid="restart-classroom-btn"
                    onClick={handleRestartClass}
                    className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white text-xs sm:text-sm font-bold shadow-md shadow-amber-500/20 transition-all duration-200"
                  >
                    <span>Resume / Restart Class Broadcast</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 3. Return to Zerix Academy Portal */}
          <div className="relative mt-6 pt-5 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <span className="text-xs text-slate-500">
              Want to return to your course dashboard?
            </span>
            <a
              href={academyPortalUrl}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-semibold text-slate-800 border border-slate-200 transition-colors shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Zerix Academy</span>
            </a>
          </div>
        </div>
      </main>

      {/* 4. Footer */}
      <footer className="max-w-4xl mx-auto w-full pt-4 sm:pt-6 border-t border-slate-200/80 text-center text-xs text-slate-500 shrink-0">
        <p>Zerix Edu Technologies • Real-Time Broadcast Microservice</p>
      </footer>
    </div>
  );
}
