import type { Metadata } from 'next';
import '@excalidraw/excalidraw/index.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Live Classroom Studio | Real-Time Broadcasting & Attendance',
  description: 'Production-grade real-time learning page broadcasting and attendance studio.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body
        className="h-full bg-slate-50 text-slate-900 antialiased overflow-hidden"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
