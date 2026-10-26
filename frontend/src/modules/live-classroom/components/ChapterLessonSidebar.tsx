'use client';

import React, { useState, useEffect } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Layers,
  FileText,
  PlayCircle,
  Clock,
  Lock,
  ShieldAlert,
  CheckCircle2,
} from 'lucide-react';
import { CurriculumTeachingMode } from '../services/curriculumClient';

export interface TopicItem {
  topicId: string;
  title: string;
  isCompleted?: boolean;
}

export interface LessonItem {
  lessonId: string;
  title: string;
  duration: string;
  hasContent?: boolean;
  description?: string;
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
  const [expandedChapters, setExpandedChapters] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    if (activeChapterId) {
      initial[String(activeChapterId)] = true;
    }
    return initial;
  });

  useEffect(() => {
    if (activeChapterId) {
      setExpandedChapters((prev) => ({
        ...prev,
        [String(activeChapterId)]: true,
      }));
    } else if (chapters.length > 0 && chapters[0]?.chapterId) {
      setExpandedChapters((prev) => ({
        ...prev,
        [String(chapters[0].chapterId)]: true,
      }));
    }
  }, [activeChapterId, chapters]);

  const toggleChapter = (chapterId: string) => {
    const key = String(chapterId);
    setExpandedChapters((prev) => ({ ...prev, [key]: !(prev[key] ?? true) }));
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
        <div className="w-[260px] h-full flex flex-col bg-slate-50/50">
          {/* Compact Course Syllabus Header matching /learn */}
          <div className="px-3.5 py-3 border-b border-slate-200/80 flex items-center justify-between bg-white">
            <div className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-slate-600">
              <Layers className="w-3.5 h-3.5 text-[#2563eb]" />
              <span>Course Syllabus</span>
            </div>
            {role === 'student' ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[10px] font-semibold">
                <Lock className="w-2.5 h-2.5" />
                Synced
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-[#2563eb] text-[10px] font-semibold">
                Teacher Control
              </span>
            )}
          </div>

          {/* Teacher Multi-Topic Navigation Mode Bar (Teaching Mode vs Reference-Only) */}
          {role === 'teacher' && onToggleTeachingMode && (
            <div className="px-3 py-2 border-b border-slate-200/70 bg-white flex items-center justify-between gap-2">
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
                    : 'bg-blue-50 text-[#2563eb] border-blue-200 hover:bg-blue-100'
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
                    <CheckCircle2 className="w-3 h-3 text-[#2563eb] shrink-0" />
                    <span>Teach &amp; Record</span>
                  </>
                )}
              </button>
            </div>
          )}

          {/* Hierarchical Chapters -> Lessons -> Topics Tree matching /learn */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {chapters.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-400">
                Loading course curriculum...
              </div>
            ) : (
              chapters.map((chapter) => {
                const chapKey = String(chapter.chapterId);
                const isExpanded = expandedChapters[chapKey] ?? true;

                return (
                  <div
                    key={chapKey}
                    className="bg-white border border-slate-200/80 rounded-xl p-2 space-y-2"
                  >
                    <button
                      type="button"
                      onClick={() => toggleChapter(chapKey)}
                      className="w-full text-left cursor-pointer group flex items-center justify-between gap-1 select-none"
                    >
                      <span
                        className="text-xs font-black text-slate-900 group-hover:text-[#2563eb] transition-colors leading-snug truncate"
                        title={chapter.title}
                      >
                        {chapter.title}
                      </span>
                      {isExpanded ? (
                        <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
                      ) : (
                        <ChevronRight className="w-3 h-3 text-slate-400 shrink-0" />
                      )}
                    </button>

                    {isExpanded && (
                      <div className="space-y-1.5 pt-1 border-t border-slate-200/60">
                        {chapter.lessons.map((lesson) => {
                          const lesKey = String(lesson.lessonId);
                          const isLessonMatched =
                            String(lesson.lessonId) === String(activeLessonId);
                          const isLessonDirectActive =
                            isLessonMatched && !activeTopicId;
                          const lessonMode =
                            lessonModesMap[lesKey] ||
                            (isLessonMatched ? teachingMode : undefined);
                          const hasContent = Boolean(
                            lesson.hasContent ||
                              (lesson.description &&
                                lesson.description.trim() !== '')
                          );
                          const firstTopicId = lesson.topics[0]?.topicId
                            ? String(lesson.topics[0].topicId)
                            : '';

                          return (
                            <div key={lesKey} className="space-y-1">
                              <button
                                type="button"
                                disabled={role === 'student'}
                                data-active={isLessonDirectActive ? 'true' : undefined}
                                onClick={() => {
                                  if (role === 'teacher') {
                                    // If lesson has its own HTML content, open the lesson view (topicId = '') just like /learn
                                    const targetTopicId = hasContent ? '' : firstTopicId;
                                    onSelectTopic(
                                      chapKey,
                                      lesKey,
                                      targetTopicId,
                                      teachingMode
                                    );
                                  }
                                }}
                                className={`flex items-center justify-between text-left w-full font-bold py-1.5 px-2 rounded-xl transition-all border select-none ${
                                  isLessonDirectActive
                                    ? 'bg-[#2563eb]/10 border-[#2563eb]/40 text-[#2563eb] font-black shadow-xs'
                                    : isLessonMatched
                                    ? 'bg-slate-50 border-slate-200/70 text-slate-900'
                                    : role === 'teacher'
                                    ? 'bg-transparent border-transparent hover:bg-slate-50 text-slate-900 cursor-pointer'
                                    : 'bg-transparent border-transparent text-slate-700 cursor-default'
                                }`}
                              >
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <FileText
                                    className={`w-3 h-3 shrink-0 ${
                                      isLessonDirectActive || isLessonMatched
                                        ? 'text-[#2563eb]'
                                        : 'text-slate-400'
                                    }`}
                                  />
                                  <span
                                    className="text-[11.5px] font-bold truncate"
                                    title={lesson.title}
                                  >
                                    {lesson.title}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1 shrink-0 ml-1">
                                  {lessonMode === 'reference_only' && (
                                    <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[8px] font-extrabold">
                                      REF
                                    </span>
                                  )}
                                  {hasContent && (
                                    <span className="text-[8px] bg-[#2563eb]/10 text-[#2563eb] px-1.5 py-0.5 rounded font-extrabold shrink-0 border border-[#2563eb]/20">
                                      Article
                                    </span>
                                  )}
                                </div>
                              </button>

                              {lesson.topics.length > 0 && (
                                <div className="space-y-1 pl-2 border-l border-slate-200/80 ml-2">
                                  {lesson.topics.map((topic) => {
                                    const topKey = String(topic.topicId);
                                    const isTopicActive =
                                      isLessonMatched &&
                                      String(topic.topicId) === String(activeTopicId);
                                    return (
                                      <button
                                        key={topKey}
                                        type="button"
                                        disabled={role === 'student'}
                                        data-active={isTopicActive ? 'true' : undefined}
                                        onClick={() =>
                                          onSelectTopic(
                                            chapKey,
                                            lesKey,
                                            topKey,
                                            teachingMode
                                          )
                                        }
                                        className={`w-full text-left py-1.5 px-2 rounded-xl transition-all text-[11px] flex items-center justify-between gap-2 border select-none ${
                                          isTopicActive
                                            ? 'bg-[#2563eb] border-[#2563eb] text-white font-black shadow-md'
                                            : role === 'teacher'
                                            ? 'bg-slate-50/80 hover:bg-white border-slate-200/80 text-slate-800 font-bold hover:border-[#2563eb]/40 cursor-pointer'
                                            : 'bg-slate-50/80 border-slate-200/80 text-slate-600 font-bold cursor-default'
                                        }`}
                                      >
                                        <div className="flex items-center gap-1.5 min-w-0">
                                          <PlayCircle
                                            className={`w-[11px] h-[11px] shrink-0 ${
                                              isTopicActive
                                                ? 'text-white'
                                                : 'text-[#2563eb]'
                                            }`}
                                          />
                                          <span
                                            className="truncate leading-tight"
                                            title={topic.title}
                                          >
                                            {topic.title}
                                          </span>
                                        </div>
                                        {topic.isCompleted ? (
                                          <CheckCircle2
                                            className={`w-[11px] h-[11px] shrink-0 ${
                                              isTopicActive
                                                ? 'text-white'
                                                : 'text-emerald-500'
                                            }`}
                                          />
                                        ) : (
                                          <Clock
                                            className={`w-[11px] h-[11px] shrink-0 ${
                                              isTopicActive
                                                ? 'text-white/80'
                                                : 'text-slate-400'
                                            }`}
                                          />
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </aside>
    </>
  );
};
