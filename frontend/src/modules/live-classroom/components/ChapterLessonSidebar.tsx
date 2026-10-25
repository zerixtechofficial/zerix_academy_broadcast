'use client';

import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  BookOpen,
  FileText,
  Radio,
  Lock,
  ShieldAlert,
  CheckCircle2,
} from 'lucide-react';
import { CurriculumTeachingMode } from '../services/curriculumClient';

export interface TopicItem {
  topicId: string;
  title: string;
}

export interface LessonItem {
  lessonId: string;
  title: string;
  duration: string;
  topics: TopicItem[];
}

export interface ChapterItem {
  chapterId: string;
  title: string;
  lessons: LessonItem[];
}

interface ChapterLessonSidebarProps {
  chapters: ChapterItem[];
  activeChapterId: string;
  activeLessonId: string;
  activeTopicId: string;
  role: 'teacher' | 'student';
  isCollapsed: boolean;
  isTopNavVisible?: boolean;
  teachingMode?: CurriculumTeachingMode;
  lessonModesMap?: Record<string, CurriculumTeachingMode>;
  onToggleTeachingMode?: () => void;
  onCloseMobile?: () => void;
  onSelectTopic: (
    chapterId: string,
    lessonId: string,
    topicId: string,
    mode?: CurriculumTeachingMode
  ) => void;
}

export const ChapterLessonSidebar: React.FC<ChapterLessonSidebarProps> = ({
  chapters,
  activeChapterId,
  activeLessonId,
  activeTopicId,
  role,
  isCollapsed,
  isTopNavVisible = true,
  teachingMode = 'taught',
  lessonModesMap = {},
  onToggleTeachingMode,
  onCloseMobile,
  onSelectTopic,
}) => {
  const [expandedChapters, setExpandedChapters] = useState<Record<string, boolean>>({
    [activeChapterId]: true,
    'chap-1': true,
    'chap-2': true,
  });

  const toggleChapter = (chapterId: string) => {
    setExpandedChapters((prev) => ({ ...prev, [chapterId]: !prev[chapterId] }));
  };

  return (
    <>
      {!isCollapsed && onCloseMobile && (
        <div
          className={`md:hidden fixed inset-0 ${
            isTopNavVisible ? 'top-12 sm:top-14' : 'top-0'
          } bg-slate-900/20 backdrop-blur-[1px] z-30`}
          onClick={onCloseMobile}
        />
      )}
      <aside
        data-testid="curriculum-sidebar"
        aria-hidden={isCollapsed}
        className={`h-full bg-white border-r border-slate-200 flex flex-col shrink-0 overflow-hidden max-md:fixed ${
          isTopNavVisible ? 'max-md:top-12 sm:max-md:top-14' : 'max-md:top-0'
        } max-md:bottom-0 max-md:left-0 max-md:z-40 max-md:shadow-2xl ${
          isCollapsed ? 'w-0 border-r-0' : 'w-[260px]'
        }`}
      >
        <div className="w-[260px] h-full flex flex-col">
          {/* Compact Course Syllabus Header */}
          <div className="px-3.5 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/60">
            <div className="flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-[#12a3ff]" />
              <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                Course Curriculum
              </span>
            </div>
            {role === 'student' ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[10px] font-semibold">
                <Lock className="w-2.5 h-2.5" />
                Synced
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-50 text-[#12a3ff] text-[10px] font-semibold">
                Teacher Control
              </span>
            )}
          </div>

          {/* Teacher Multi-Topic Navigation Mode Bar (Teaching Mode vs Reference-Only) */}
          {role === 'teacher' && onToggleTeachingMode && (
            <div className="px-3 py-2 border-b border-slate-100 bg-white flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-slate-600">
                Lesson Mode:
              </span>
              <button
                type="button"
                data-testid="sidebar-teaching-mode-btn"
                onClick={onToggleTeachingMode}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold border transition-colors cursor-pointer ${
                  teachingMode === 'reference_only'
                    ? 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100'
                    : 'bg-sky-50 text-[#12a3ff] border-sky-200 hover:bg-sky-100'
                }`}
                title={
                  teachingMode === 'reference_only'
                    ? 'Reference-Only: Protects existing VOD & Whiteboard for this lesson'
                    : 'Teaching Mode: Logs segment to VOD & saves Whiteboard'
                }
              >
                {teachingMode === 'reference_only' ? (
                  <>
                    <ShieldAlert className="w-3 h-3 text-amber-600 shrink-0" />
                    <span>Ref Only (Protected)</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-3 h-3 text-[#12a3ff] shrink-0" />
                    <span>Teach &amp; Record</span>
                  </>
                )}
              </button>
            </div>
          )}

          {/* Hierarchical Chapters -> Lessons -> Topics Tree */}
          <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
            {chapters.map((chapter) => {
              const isExpanded = expandedChapters[chapter.chapterId] ?? true;
              const isChapterActive = chapter.chapterId === activeChapterId;

              return (
                <div
                  key={chapter.chapterId}
                  className={`rounded-xl border transition-colors ${
                    isChapterActive
                      ? 'border-slate-200 bg-slate-50/50'
                      : 'border-slate-100 bg-white'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleChapter(chapter.chapterId)}
                    className="w-full flex items-center justify-between px-3 py-2 text-left text-xs font-bold text-slate-800 hover:bg-slate-50 rounded-t-xl transition-colors"
                  >
                    <span className="truncate pr-2">{chapter.title}</span>
                    {isExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    )}
                  </button>

                  {isExpanded && (
                    <div className="px-2 pb-2 space-y-1.5">
                      {chapter.lessons.map((lesson) => {
                        const isLessonActive = lesson.lessonId === activeLessonId;
                        const lessonMode =
                          lessonModesMap[lesson.lessonId] ||
                          (isLessonActive ? teachingMode : undefined);

                        return (
                          <div key={lesson.lessonId} className="space-y-1">
                            <div
                              className={`flex items-center justify-between px-2 py-1 rounded-md text-[11px] font-semibold ${
                                isLessonActive
                                  ? 'text-[#12a3ff] bg-sky-50/80'
                                  : 'text-slate-500'
                              }`}
                            >
                              <span className="truncate">{lesson.title}</span>
                              <div className="flex items-center gap-1 shrink-0 ml-1">
                                {lessonMode === 'reference_only' && (
                                  <span className="px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 text-[9px] font-bold">
                                    REF
                                  </span>
                                )}
                                <span className="text-[10px] text-slate-400">
                                  {lesson.duration}
                                </span>
                              </div>
                            </div>

                            <div className="pl-2 space-y-0.5 border-l border-slate-200 ml-2">
                              {lesson.topics.map((topic) => {
                                const isTopicActive =
                                  isLessonActive && topic.topicId === activeTopicId;
                                return (
                                  <button
                                    key={topic.topicId}
                                    type="button"
                                    disabled={role === 'student'}
                                    onClick={() =>
                                      onSelectTopic(
                                        chapter.chapterId,
                                        lesson.lessonId,
                                        topic.topicId,
                                        teachingMode
                                      )
                                    }
                                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-all text-left ${
                                      isTopicActive
                                        ? 'bg-[#12a3ff] text-white font-semibold shadow-xs'
                                        : role === 'teacher'
                                        ? 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                                        : 'text-slate-500 cursor-default'
                                    }`}
                                  >
                                    {isTopicActive ? (
                                      <Radio className="w-3 h-3 text-white animate-pulse shrink-0" />
                                    ) : (
                                      <FileText className="w-3 h-3 text-slate-400 shrink-0" />
                                    )}
                                    <span className="truncate">{topic.title}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </aside>
    </>
  );
};
