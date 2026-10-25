'use client';

import dynamic from 'next/dynamic';

const LearningSessionLayout = dynamic(
  () => import('../modules/live-classroom/LearningSessionLayout'),
  { ssr: false }
);

export default function Page() {
  return <LearningSessionLayout />;
}
