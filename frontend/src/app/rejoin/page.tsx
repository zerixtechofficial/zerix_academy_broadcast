'use client';

import React, { Suspense } from 'react';
import RejoinScreen from '@/modules/live-classroom/components/RejoinScreen';

export default function RejoinPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen w-full flex items-center justify-center bg-slate-50 text-slate-900">
          <div className="flex flex-col items-center gap-3">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-sky-600"></div>
            <p className="text-xs font-medium text-slate-600">Loading Classroom Portal...</p>
          </div>
        </div>
      }
    >
      <RejoinScreen />
    </Suspense>
  );
}
