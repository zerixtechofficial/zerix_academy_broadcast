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

  const token =
    searchParams?.get('token') ||
    (typeof window !== 'undefined' ? sessionStorage.getItem('broadcast_rejoin_token') || '' : '');
  const tokenClaims = useMemo(() => parseUserFromToken(token), [token]);

  // URL Parameters validated against token claims
  const initialSessionId =
    searchParams?.get('sessionId') ||
    tokenClaims.sessionId ||
    (typeof window !== 'undefined' ? sessionStorage.getItem('broadcast_rejoin_session_id') || '' : '');
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

  const [selectedSessionId] = useState<string>(initialSessionId);
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
            roomName: prev?.roomName || sessId,
            title: prev?.title || sessId,
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

  // Navigate back into classroom
  const handleRejoin = () => {
    if (token) {
      sessionStorage.setItem('broadcast_rejoin_token', token);
      sessionStorage.setItem('broadcast_rejoin_session_id', selectedSessionId);
    }
    const params = new URLSearchParams({
      sessionId: selectedSessionId,
      role,
      ...(studentId ? { studentId } : {}),
      ...(teacherId ? { teacherId } : {}),
    });
    window.location.href = `/?${params.toString()}`;
  };

  // Host Teacher: Restart class if ended
  const handleRestartClass = () => {
    if (token) {
      sessionStorage.setItem('broadcast_rejoin_token', token);
      sessionStorage.setItem('broadcast_rejoin_session_id', selectedSessionId);
    }
    const params = new URLSearchParams({
      sessionId: selectedSessionId,
      role: 'teacher',
      ...(teacherId ? { teacherId } : {}),
    });
    window.location.href = `/?${params.toString()}`;
  };

  const academyPortalUrl =
    process.env.NEXT_PUBLIC_ACADEMY_URL || 'https://academy.zerixtech.com';

  if (!selectedSessionId || !token || error) {
    return (
      <div
        data-testid="rejoin-unauthorized-container"
        className="min-h-screen w-full bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950 text-slate-100 flex items-center justify-center p-4"
      >
        <div className="max-w-md w-full rounded-3xl bg-slate-800/90 border border-slate-700/80 shadow-2xl p-6 sm:p-8 text-center space-y-5">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400">
            <AlertCircle className="w-7 h-7" />
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-bold text-white">Classroom Authentication Required</h1>
            <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
              {error ||
                'Direct access to Zerix Live Broadcast Studio is restricted. Please sign in to Zerix Academy and join your scheduled live classroom.'}
            </p>
          </div>
          <a
            href={academyPortalUrl}
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-2xl bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white text-sm font-bold shadow-lg shadow-sky-500/20 transition-all"
          >
            <span>Return to Zerix Academy</span>
            <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      </div>
    );
  }

  const isActive = statusData ? statusData.isActive : !wasEnded;
  const roomTitle =
    statusData?.roomName ||
    statusData?.title ||
    selectedSessionId;

  return (
    <div
      data-testid="rejoin-screen-container"
      className="min-h-screen w-full bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950 text-slate-100 flex flex-col justify-between p-4 sm:p-6 lg:p-8"
    >
      {/* 1. Header Bar */}
      <header className="max-w-4xl mx-auto w-full flex items-center justify-between pb-6 border-b border-slate-700/60">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-sky-500/20 text-white font-bold">
            <Video className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base sm:text-lg font-bold tracking-tight text-white flex items-center gap-2">
              Zerix Live Broadcast Studio
            </h1>
            <p className="text-xs text-slate-400">Interactive Classroom Session Portal</p>
          </div>
        </div>

        {/* User Badge */}
        <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-slate-800/80 border border-slate-700 text-xs text-slate-300">
          <User className="w-3.5 h-3.5 text-sky-400" />
          <span className="font-medium truncate max-w-[140px] sm:max-w-none">{currentUserName}</span>
        </div>
      </header>

      {/* 2. Main Rejoin Card */}
      <main className="max-w-xl mx-auto w-full my-auto py-6 sm:py-8">
        <div className="relative rounded-3xl bg-slate-800/90 border border-slate-700/80 shadow-2xl backdrop-blur-xl p-6 sm:p-8 overflow-hidden transition-all duration-300">
          {/* Subtle Ambient Glow */}
          <div
            className={`absolute -top-24 -right-24 w-60 h-60 rounded-full blur-3xl pointer-events-none opacity-20 ${
              isActive ? 'bg-sky-500' : 'bg-rose-500'
            }`}
          />
          <div
            className={`absolute -bottom-24 -left-24 w-60 h-60 rounded-full blur-3xl pointer-events-none opacity-15 ${
              isActive ? 'bg-emerald-500' : 'bg-amber-500'
            }`}
          />

          {/* Top Status Pill & Refresh */}
          <div className="flex items-center justify-between mb-6">
            <div
              data-testid="room-status-badge"
              className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold shadow-inner transition-colors ${
                isActive
                  ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/30'
                  : 'bg-rose-950/80 text-rose-300 border border-rose-500/30'
              }`}
            >
              <span className="relative flex h-2 w-2">
                {isActive && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                )}
                <span
                  className={`relative inline-flex rounded-full h-2 w-2 ${
                    isActive ? 'bg-emerald-400' : 'bg-rose-400'
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
              className="p-2 rounded-xl bg-slate-700/50 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors border border-slate-600/50"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-sky-400' : ''}`} />
            </button>
          </div>

          {/* Room Name & Classroom Information */}
          <div className="space-y-3 mb-6">
            <div className="flex items-center gap-2 text-xs font-semibold tracking-wider uppercase text-sky-400">
              <BookOpen className="w-4 h-4" />
              <span>Room / Classroom</span>
            </div>

            <h2
              data-testid="rejoin-room-name"
              className="text-xl sm:text-2xl font-extrabold text-white tracking-tight leading-snug"
            >
              {roomTitle}
            </h2>

            {statusData?.lessonTitle && (
              <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
                {statusData.lessonTitle}
              </p>
            )}

            {/* Room Metadata Chips */}
            <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-slate-300">
              <span className="px-2.5 py-1 rounded-lg bg-slate-700/60 border border-slate-600/40 font-mono text-slate-200">
                ID: {selectedSessionId}
              </span>
              {statusData?.subjectName && (
                <span className="px-2.5 py-1 rounded-lg bg-indigo-950/60 border border-indigo-700/40 text-indigo-300">
                  {statusData.subjectName}
                </span>
              )}
              {statusData?.teacherName && (
                <span className="px-2.5 py-1 rounded-lg bg-slate-700/60 border border-slate-600/40 text-slate-300">
                  Instructor: {statusData.teacherName}
                </span>
              )}
              {isActive && typeof statusData?.onlineCount === 'number' && (
                <span
                  data-testid="room-online-count"
                  className="px-2.5 py-1 rounded-lg bg-emerald-950/60 border border-emerald-700/40 text-emerald-300 flex items-center gap-1.5"
                >
                  <Users className="w-3.5 h-3.5" />
                  {statusData.onlineCount} {statusData.onlineCount === 1 ? 'attendee' : 'attendees'} online
                </span>
              )}
            </div>
          </div>

          {/* Conditional Screen Content: Active Room vs Ended Room */}
          {isActive ? (
            /* ACTIVE ROOM STATE: Show Rejoin Button */
            <div
              data-testid="rejoin-active-state"
              className="space-y-5 rounded-2xl bg-slate-900/60 border border-emerald-500/20 p-5 mt-4"
            >
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 mt-0.5">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">Live Session Ready</h3>
                  <p className="text-xs text-slate-300 mt-0.5 leading-relaxed">
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
                className="w-full flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-2xl bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white text-sm sm:text-base font-bold shadow-lg shadow-sky-500/25 transition-all duration-200 transform hover:-translate-y-0.5 active:translate-y-0"
              >
                <span>Rejoin Classroom</span>
                <ArrowRight className="w-5 h-5" />
              </button>
            </div>
          ) : (
            /* ENDED ROOM STATE: Rejoin Button is NOT Visible; Show Concluded Message */
            <div
              data-testid="rejoin-ended-state"
              className="space-y-4 rounded-2xl bg-slate-900/60 border border-rose-500/20 p-5 mt-4"
            >
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-rose-500/10 text-rose-400 mt-0.5">
                  <Clock className="w-5 h-5" />
                </div>
                <div className="space-y-1">
                  <h3 data-testid="class-ended-heading" className="text-sm font-bold text-white">
                    Class Concluded
                  </h3>
                  <p
                    data-testid="class-ended-description"
                    className="text-xs sm:text-sm text-slate-300 leading-relaxed"
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
                    className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-white text-xs sm:text-sm font-bold shadow-lg shadow-amber-500/20 transition-all duration-200"
                  >
                    <span>Resume / Restart Class Broadcast</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 3. Return to Zerix Academy Portal */}
          <div className="mt-6 pt-5 border-t border-slate-700/60 flex items-center justify-between gap-3">
            <span className="text-xs text-slate-400">
              Want to return to your course dashboard?
            </span>
            <a
              href={academyPortalUrl}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-700/60 hover:bg-slate-700 text-xs font-semibold text-white border border-slate-600/50 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Zerix Academy</span>
            </a>
          </div>
        </div>
      </main>

      {/* 4. Footer */}
      <footer className="max-w-4xl mx-auto w-full pt-6 border-t border-slate-700/60 text-center text-xs text-slate-400">
        <p>Zerix Edu Technologies • Real-Time Broadcast Microservice • Session: {selectedSessionId}</p>
      </footer>
    </div>
  );
}
