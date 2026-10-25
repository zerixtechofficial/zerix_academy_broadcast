'use client';

import React, { Suspense } from 'react';
import RejoinScreen from '@/modules/live-classroom/components/RejoinScreen';

export default function RejoinPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen w-full flex items-center justify-center bg-slate-900 text-white">
          <div className="flex flex-col items-center gap-3">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-sky-400"></div>
            <p className="text-xs text-slate-400">Loading Classroom Portal...</p>
          </div>
        </div>
      }
    >
      <RejoinScreen />
    </Suspense>
  );
}
