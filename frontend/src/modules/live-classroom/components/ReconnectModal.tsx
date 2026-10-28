'use client';

import React, { useEffect, useState } from 'react';
import { WifiOff, RefreshCw, Clock } from 'lucide-react';

interface ReconnectModalProps {
  isDisconnected: boolean;
  teacherDisconnected: {
    active: boolean;
    gracePeriodSeconds: number;
    graceEndsAt?: number;
    message: string;
  };
  lastSeqId: number;
  onManualReconnect: () => void;
}

export const ReconnectModal: React.FC<ReconnectModalProps> = ({
  isDisconnected,
  teacherDisconnected,
  lastSeqId,
  onManualReconnect,
}) => {
  const [remainingSeconds, setRemainingSeconds] = useState<number>(
    teacherDisconnected.gracePeriodSeconds || 300
  );

  useEffect(() => {
    if (!teacherDisconnected.active) {
      setRemainingSeconds(teacherDisconnected.gracePeriodSeconds || 300);
      return;
    }
    const computeRemaining = () => {
      if (teacherDisconnected.graceEndsAt && teacherDisconnected.graceEndsAt > Date.now()) {
        return Math.max(0, Math.ceil((teacherDisconnected.graceEndsAt - Date.now()) / 1000));
      }
      return teacherDisconnected.gracePeriodSeconds || 300;
    };
    setRemainingSeconds(computeRemaining());
    const interval = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (teacherDisconnected.graceEndsAt) {
          return Math.max(0, Math.ceil((teacherDisconnected.graceEndsAt - Date.now()) / 1000));
        }
        return prev > 0 ? prev - 1 : 0;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [
    teacherDisconnected.active,
    teacherDisconnected.gracePeriodSeconds,
    teacherDisconnected.graceEndsAt,
  ]);

  useEffect(() => {
    if (!isDisconnected) return;
    const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    if (isOnline) {
      const immediateTimer = window.setTimeout(() => {
        onManualReconnect();
      }, 900);
      const retryInterval = window.setInterval(() => {
        if (typeof navigator === 'undefined' || navigator.onLine !== false) {
          onManualReconnect();
        }
      }, 2200);
      return () => {
        window.clearTimeout(immediateTimer);
        window.clearInterval(retryInterval);
      };
    }
  }, [isDisconnected, onManualReconnect]);

  if (!isDisconnected && !teacherDisconnected.active) {
    return null;
  }

  const mins = Math.floor(remainingSeconds / 60)
    .toString()
    .padStart(2, '0');
  const secs = (remainingSeconds % 60).toString().padStart(2, '0');

  // Non-blocking compact floating banner when no Host or Co-Host is active
  if (!isDisconnected && teacherDisconnected.active) {
    return (
      <div className="pointer-events-none fixed top-16 left-1/2 -translate-x-1/2 z-40 px-4">
        <div
          data-testid="teacher-grace-banner"
          className="pointer-events-auto flex items-center gap-2.5 px-3.5 py-2 rounded-full bg-amber-50/95 backdrop-blur-md border border-amber-200 shadow-md text-xs text-amber-800"
        >
          <Clock className="w-3.5 h-3.5 text-amber-600 animate-spin shrink-0" />
          <span className="font-semibold">
            No Host/Co-Host active (Closing in {mins}:{secs})
          </span>
          <span className="text-amber-500 hidden sm:inline">•</span>
          <span className="text-amber-700 hidden sm:inline">
            Live Whiteboard &amp; Content remain active (Seq #{lastSeqId})
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-xs p-4">
      <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-2xl p-6 text-center space-y-4">
        <div className="mx-auto w-12 h-12 rounded-2xl bg-sky-50 border border-sky-200 flex items-center justify-center">
          <WifiOff className="w-6 h-6 text-[#12a3ff] animate-pulse" />
        </div>

        <div className="space-y-1.5">
          <h3 className="text-lg font-bold text-slate-900">
            Connection Interrupted — Rejoining Studio...
          </h3>
          <p className="text-xs text-slate-600 leading-relaxed">
            {`Preserving your live canvas and audio stage state. Catching up from packet sequence #${lastSeqId} via Redis ring buffer...`}
          </p>
        </div>

        <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between text-xs text-slate-600">
          <span>Ring Buffer Sequence ID</span>
          <span className="font-mono font-bold text-[#12a3ff]">#{lastSeqId}</span>
        </div>

        <button
          type="button"
          onClick={onManualReconnect}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-[#12a3ff] hover:bg-[#0d8de0] text-white text-xs font-bold shadow-sm transition-all cursor-pointer"
        >
          <RefreshCw className="w-4 h-4" />
          <span>Reconnect Immediately</span>
        </button>
      </div>
    </div>
  );
};
