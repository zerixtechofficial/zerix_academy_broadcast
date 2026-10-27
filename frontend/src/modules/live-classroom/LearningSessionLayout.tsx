'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { TopModeNavbar, BatchOption } from './components/TopModeNavbar';
import { ChapterLessonSidebar, ChapterItem } from './components/ChapterLessonSidebar';
import { VirtualContentStage, LessonBlock } from './components/VirtualContentStage';
import { ExcalidrawStage } from './components/ExcalidrawStage';
import { ReconnectModal } from './components/ReconnectModal';
import {
  useBroadcastSocket,
  ActiveMode,
  ExcalidrawElementState,
  WhiteboardCameraState,
  WhiteboardCursorState,
  AudioStageState,
  StudentAttendanceSummary,
} from './hooks/useBroadcastSocket';
import { useLiveKitStage } from './hooks/useLiveKitStage';
import { useFullscreenWorkspace } from './hooks/useFullscreenWorkspace';
import { useScreenWakeLock } from './hooks/useScreenWakeLock';
import { useCompressedClassRecorder } from './hooks/useCompressedClassRecorder';
import {
  CurriculumClient,
  RelationalLessonContext,
  CurriculumTeachingMode,
} from './services/curriculumClient';

const EMPTY_BATCHES: BatchOption[] = [];

function decodeJwtPayload(jwtToken: string): Record<string, any> | null {
  if (!jwtToken || typeof window === 'undefined') return null;
  const parts = jwtToken.trim().split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(window.atob(padded));
  } catch {
    return null;
  }
}

export default function LearningSessionLayout() {
  // Synchronously read URL parameters and JWT claims on initial client render
  const initialParams = useMemo(() => {
    if (typeof window === 'undefined') {
      return {
        role: 'student' as 'teacher' | 'student',
        teacherId: '',
        studentId: '',
        userName: '',
        sessionId: '',
        token: '',
        isMobileViewport: false,
        branchId: 0,
        batchId: 0,
        boardId: null as number | null,
        languageId: 1 as string | number,
        courseId: 0 as string | number,
        linkedVodCourseId: 0,
        subjectId: 0,
        chapterId: '' as string | number,
        lessonId: '' as string | number,
        topicId: '' as string | number,
        academicYear: new Date().getFullYear(),
        version: 1,
      };
    }
    const urlParams = new URLSearchParams(window.location.search);
    const rawSessId = urlParams.get('sessionId') || '';

    const isTokenMatchingSession = (
      jwtOrToken: string | null,
      targetSessionId: string
    ): boolean => {
      if (!jwtOrToken || jwtOrToken === 'undefined' || jwtOrToken === 'null') {
        return false;
      }
      const trimmed = jwtOrToken.trim();
      if (!trimmed || trimmed.startsWith('DEV_TOKEN_')) return false;
      const payload = decodeJwtPayload(trimmed);
      if (payload) {
        if (payload.exp && Math.floor(Date.now() / 1000) >= Number(payload.exp)) {
          return false;
        }
        if (
          targetSessionId &&
          payload.sessionId &&
          payload.sessionId !== '*' &&
          String(payload.sessionId) !== String(targetSessionId)
        ) {
          return false;
        }
      }
      return true;
    };

    const rawUrlToken = urlParams.get('token');
    const urlToken = isTokenMatchingSession(rawUrlToken, rawSessId)
      ? rawUrlToken!.trim()
      : '';

    const rawStoredToken = window.sessionStorage.getItem('broadcast_rejoin_token');
    const storedSessionId = window.sessionStorage.getItem('broadcast_rejoin_session_id') || '';
    const effectiveSessId = rawSessId || storedSessionId;

    if (urlToken && effectiveSessId) {
      window.sessionStorage.setItem('broadcast_rejoin_token', urlToken);
      window.sessionStorage.setItem('broadcast_rejoin_session_id', effectiveSessId);
    }

    const storedToken =
      (!storedSessionId || !effectiveSessId || storedSessionId === effectiveSessId) &&
      isTokenMatchingSession(rawStoredToken, effectiveSessId)
        ? rawStoredToken!.trim()
        : '';

    if (rawStoredToken && !storedToken) {
      window.sessionStorage.removeItem('broadcast_rejoin_token');
      window.sessionStorage.removeItem('broadcast_rejoin_session_id');
    }

    const tok = urlToken || storedToken || '';
    const claims = decodeJwtPayload(tok) || {};

    const resolvedSessionId =
      effectiveSessId || (claims.sessionId && claims.sessionId !== '*' ? String(claims.sessionId) : '');
    const resolvedRole: 'teacher' | 'student' =
      claims.role === 'teacher' || claims.role === 'student'
        ? claims.role
        : urlParams.get('role') === 'teacher'
        ? 'teacher'
        : 'student';

    const claimUserId = claims.userId ? String(claims.userId) : '';
    const rawTeacherId =
      (resolvedRole === 'teacher' ? claimUserId : '') ||
      urlParams.get('teacherId') ||
      '';
    const normTeacherId = rawTeacherId
      ? rawTeacherId.startsWith('teacher_')
        ? rawTeacherId
        : `teacher_${rawTeacherId}`
      : '';

    const rawStId =
      (resolvedRole === 'student' ? claimUserId : '') ||
      urlParams.get('studentId') ||
      '';
    const stId = rawStId.replace(/^student_/, '');

    const rawLangCandidate =
      urlParams.get('languageId') ||
      urlParams.get('language_id') ||
      claims.languageId ||
      1;
    const rawLang: number = (() => {
      if (!isNaN(Number(rawLangCandidate)) && Number(rawLangCandidate) > 0) {
        return Math.floor(Number(rawLangCandidate));
      }
      const code = String(rawLangCandidate || '').trim().toLowerCase();
      const codeMap: Record<string, number> = {
        en: 1,
        english: 1,
        hi: 2,
        hindi: 2,
        as: 3,
        assamese: 3,
        bn: 4,
        brx: 5,
        gu: 7,
        kn: 8,
        ml: 11,
        mr: 13,
        ne: 14,
        or: 15,
        pa: 17,
        sa: 18,
        ta: 21,
        te: 22,
        ur: 23,
        hinglish: 24,
      };
      return codeMap[code] || 1;
    })();

    return {
      role: resolvedRole,
      teacherId: normTeacherId,
      studentId: stId,
      userName: claims.name ? String(claims.name) : '',
      sessionId: resolvedSessionId,
      token: tok,
      isMobileViewport: window.innerWidth < 768,
      branchId: Number(urlParams.get('branchId') || claims.branchId) || 0,
      batchId: Number(urlParams.get('batchId') || claims.batchId) || 0,
      boardId: urlParams.get('boardId') ? Number(urlParams.get('boardId')) : null,
      languageId: rawLang,
      courseId: urlParams.get('courseId') || claims.courseId || 0,
      linkedVodCourseId: Number(urlParams.get('linkedVodCourseId')) || 0,
      subjectId: Number(urlParams.get('subjectId')) || 0,
      chapterId: urlParams.get('chapterId') || claims.chapterId || '',
      lessonId: urlParams.get('lessonId') || claims.lessonId || '',
      topicId: urlParams.get('topicId') || claims.topicId || '',
      academicYear: Number(urlParams.get('academicYear')) || new Date().getFullYear(),
      version: Number(urlParams.get('version')) || 1,
    };
  }, []);

  // User Identity & Session State
  const [role, setRole] = useState<'teacher' | 'student'>(initialParams.role);
  const [teacherId, setTeacherId] = useState<string>(initialParams.teacherId);
  const [studentId, setStudentId] = useState<string>(initialParams.studentId);
  const [verifiedUserName, setVerifiedUserName] = useState<string>(initialParams.userName);
  const [sessionId, setSessionId] = useState<string>(initialParams.sessionId);
  const [token, setToken] = useState<string>(initialParams.token);
  const [languageId, setLanguageId] = useState<string | number>(initialParams.languageId);
  const [isAuthVerifying, setIsAuthVerifying] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // Session & Curriculum Data
  const [sessionMetadata, setSessionMetadata] = useState<any>(null);
  const [curriculum, setCurriculum] = useState<any>(null);
  const [lessonContent, setLessonContent] = useState<any>(null);
  const [livekitToken, setLivekitToken] = useState<string>('');
  const [livekitUrl, setLivekitUrl] = useState<string | undefined>(undefined);
  const [canPublishAudio, setCanPublishAudio] = useState<boolean>(false);
  const [coHostInviteToken, setCoHostInviteToken] = useState<string>('');
  const [pendingMicAutoActivate, setPendingMicAutoActivate] = useState<boolean>(false);

  // Workspace Layout & Sync Controls
  // By default: show Course Curriculum sidebar in Content mode (on desktop/tablet >= 768px)
  // and hide Course Curriculum sidebar in Whiteboard mode.
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(
    initialParams.isMobileViewport
  );
  // Multi-Topic Teaching Mode vs Reference-Only Mode ('taught' | 'reference_only')
  const [teachingMode, setTeachingMode] = useState<CurriculumTeachingMode>('taught');
  const [lessonModesMap, setLessonModesMap] = useState<Record<string, CurriculumTeachingMode>>({});
  const lessonWhiteboardsRef = useRef<
    Record<
      string,
      {
        elements: ExcalidrawElementState[];
        files: Record<string, any>;
      }
    >
  >({});
  const [followTeacher, setFollowTeacher] = useState<boolean>(true);
  const [studentZoomMultiplier, setStudentZoomMultiplier] = useState<number>(1.0);
  const [isContentToolboxVisible, setIsContentToolboxVisible] = useState<boolean>(true);
  const [isVerifiedCoTeacher, setIsVerifiedCoTeacher] = useState<boolean>(false);
  const [initialVideoState, setInitialVideoState] = useState<any>(null);
  const [isRecordingModalOpen, setIsRecordingModalOpen] = useState<boolean>(false);
  const [recordingModalMode, setRecordingModalMode] = useState<'start' | 'restart'>('start');
  const [recordingModalForm, setRecordingModalForm] = useState({
    courseTitle: '',
    subjectName: '',
    batchName: '',
    chapterTitle: '',
    lessonTitle: '',
    topicTitle: '',
    teacherName: '',
    academicYear: String(new Date().getFullYear()),
    version: '1',
    recordVoice: true,
  });

  // Global Keyboard Shortcut: Alt+T / Option+T or single key 'T' (when not typing in an input) to toggle Content Toolbox
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      const isAltT = e.altKey && (e.key.toLowerCase() === 't' || e.code === 'KeyT');
      const isPlainT =
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !isInput &&
        (e.key.toLowerCase() === 't' || e.code === 'KeyT');

      if (isAltT || isPlainT) {
        e.preventDefault();
        e.stopPropagation();
        setIsContentToolboxVisible((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);

  // Fullscreen Workspace Hook
  const workspaceContainerRef = useRef<HTMLDivElement | null>(null);
  const {
    isFullscreen,
    isTopNavVisible,
    toggleTopNav,
    toggleFullscreen,
  } = useFullscreenWorkspace(workspaceContainerRef);

  const setMicrophoneActiveRef = useRef<(active: boolean) => Promise<boolean>>(() =>
    Promise.resolve(false)
  );
  const playIncomingVoiceFrameRef = useRef<(packet: any) => void>(() => {});
  const recoverAudioStageRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const isMicrophoneEnabledRef = useRef<boolean>(false);

  // Real-time Socket.io + MsgPack Broadcast Hook
  const {
    isConnected,
    isReconnecting,
    hasLeftSession,
    sessionEndedInfo,
    mode,
    teacherStatus,
    onlineCount,
    attendanceList,
    setAttendanceList,
    seqId,
    teacherCam,
    whiteboardCursor,
    incomingWhiteboardDelta,
    whiteboardFiles,
    activeLessonId,
    setActiveLessonId,
    activeTopicId,
    setActiveTopicId,
    activeBlockId,
    blockOffsetRatio,
    scrollAuthorId,
    scrollUpdatedAt,
    penStrokes,
    laserPointer,
    activeStudentMics,
    allowStudentUnmute,
    raisedHands,
    teacherMicActive,
    setTeacherMicActive,
    invitedTeachers,
    setInvitedTeachers,
    whiteboardEditors,
    setWhiteboardEditors,
    multiDeviceStudents,
    setMultiDeviceStudents,
    multiDeviceBlocked,
    clientDeviceId,
    audioError,
    changeMode,
    broadcastTeacherCam,
    broadcastWhiteboardCursor,
    broadcastWhiteboardDelta,
    broadcastWhiteboardClear,
    broadcastWhiteboardFiles,
    sendContentBlockToWhiteboard,
    broadcastScrollSync,
    broadcastNavSync,
    broadcastStroke,
    broadcastDeleteStroke,
    broadcastClearStrokes,
    broadcastLaser,
    raiseHand,
    lowerHand,
    grantMic,
    muteStudent,
    muteAllStudents,
    setAllowStudentUnmuteOption,
    studentSelfUnmute,
    studentSelfMute,
    notifyDeviceMicActive,
    broadcastVoiceFrame,
    setStudentMultiDeviceAccess,
    retryJoinRoom,
    broadcastTeacherMicState,
    inviteCoTeacher,
    toggleCoTeacherWhiteboard,
    removeCoTeacher,
    grantWhiteboardAccess,
    revokeWhiteboardAccess,
    clearAudioError,
    simulateDisconnect,
    manualReconnect,
    leaveSession,
    endSession,
    rejoinSession,
  } = useBroadcastSocket({
    sessionId,
    role,
    token,
    teacherId,
    studentId,
    onStudentTokenRefresh: (newToken, autoActivate) => {
      setLivekitToken(newToken);
      setCanPublishAudio(true);
      if (autoActivate && role === 'student') {
        setPendingMicAutoActivate(true);
      }
    },
    onStudentMicRevoked: () => {
      setCanPublishAudio(false);
      setMicrophoneActiveRef.current(false).catch(() => {});
    },
    onIncomingVoiceFrame: (packet) => {
      playIncomingVoiceFrameRef.current(packet);
    },
    onSocketReconnected: () => {
      void recoverAudioStageRef.current();
    },
  });

  // Prevent phone/tablet/desktop screen from turning off during an active live broadcast
  useScreenWakeLock({
    enabled: !hasLeftSession && teacherStatus !== 'ENDED' && !multiDeviceBlocked,
  });

  // Load Initial Session Snapshot, Curriculum Tree, Lesson Blocks & Attendance
  useEffect(() => {
    let isMounted = true;

    const loadSessionData = async () => {
      if (!sessionId || !token || token.startsWith('DEV_TOKEN_')) {
        if (isMounted) {
          setIsAuthVerifying(false);
          setAuthError(
            'Direct access to Zerix Live Broadcast Studio is restricted. Please sign in to Zerix Academy and launch or join your scheduled live classroom session.'
          );
        }
        return;
      }

      try {
        const isCoHostUrlParam =
          typeof window !== 'undefined' &&
          ['1', 'true'].includes(
            new URLSearchParams(window.location.search).get('cohost') || ''
          );

        const initData = await CurriculumClient.initSession({
          sessionId,
          role,
          teacherId,
          studentId,
          token,
          deviceId: clientDeviceId,
          cohost: isCoHostUrlParam,
        });

        if (!isMounted) return;

        let activeSessionToken = token;
        if (initData.token && typeof initData.token === 'string') {
          activeSessionToken = initData.token;
          if (activeSessionToken !== token) {
            setToken(activeSessionToken);
          }
          if (typeof window !== 'undefined') {
            window.sessionStorage.setItem('broadcast_rejoin_token', activeSessionToken);
          }
        }
        if (initData.coHostInviteToken && typeof initData.coHostInviteToken === 'string') {
          setCoHostInviteToken(initData.coHostInviteToken);
        }

        if (initData.user) {
          if (initData.user.role === 'teacher' || initData.user.role === 'student') {
            setRole(initData.user.role);
          }
          if (initData.user.name) {
            setVerifiedUserName(String(initData.user.name));
          }
          if (initData.user.role === 'teacher' && initData.user.userId) {
            const rawTId = String(initData.user.userId);
            setTeacherId(rawTId.startsWith('teacher_') ? rawTId : `teacher_${rawTId}`);
            setIsVerifiedCoTeacher(Boolean(initData.user.isCoTeacher));
          } else if (initData.user.role === 'student' && initData.user.userId) {
            setStudentId(String(initData.user.userId).replace(/^student_/, ''));
            setIsVerifiedCoTeacher(false);
          }
        }

        const ctx = initData.sessionContext || {};
        setSessionMetadata(ctx);
        if ((initData as any).videoState) {
          setInitialVideoState((initData as any).videoState);
        }
        const resolvedLang = initialParams.languageId || ctx.languageId || 1;
        setLanguageId(resolvedLang);
        setIsAuthVerifying(false);
        setAuthError(null);

        if (initData.livekit) {
          setLivekitToken(initData.livekit.token);
          if (initData.livekit.url) {
            setLivekitUrl(initData.livekit.url);
          }
          setCanPublishAudio(initData.livekit.canPublishAudio);
        }
        if (Array.isArray(initData.attendance) && initData.attendance.length > 0) {
          setAttendanceList(initData.attendance);
        }
        if (initData.audioStage) {
          if (typeof initData.audioStage.teacherMicActive === 'boolean') {
            setTeacherMicActive(initData.audioStage.teacherMicActive);
          }
          if (Array.isArray(initData.audioStage.invitedTeachers)) {
            setInvitedTeachers(initData.audioStage.invitedTeachers);
          }
          if (Array.isArray(initData.audioStage.whiteboardEditors)) {
            setWhiteboardEditors(initData.audioStage.whiteboardEditors);
          }
          if (Array.isArray(initData.audioStage.multiDeviceStudents)) {
            setMultiDeviceStudents(initData.audioStage.multiDeviceStudents);
          }
        }

        const courseId = initialParams.courseId || ctx.courseId;
        let curData: any = null;
        if (courseId) {
          curData = await CurriculumClient.fetchCurriculum(
            String(courseId),
            resolvedLang,
            activeSessionToken
          );
          if (isMounted) setCurriculum(curData);
        }

        const chaptersList = Array.isArray(curData?.chapters) ? curData.chapters : [];
        const firstChapter = chaptersList[0];
        const firstLesson = firstChapter?.lessons?.[0];
        const firstTopic = firstLesson?.topics?.[0];

        let targetTopicId = String(
          initialParams.topicId || ctx.topicId || firstTopic?.topicId || ''
        );
        let targetLessonId = String(
          initialParams.lessonId || ctx.lessonId || firstLesson?.lessonId || ''
        );

        // Verify targetTopicId and targetLessonId exist in curriculum if curriculum has chapters
        if (chaptersList.length > 0) {
          let matchedLesson: any = null;
          if (targetTopicId) {
            for (const ch of chaptersList) {
              for (const les of ch.lessons || []) {
                if (
                  (les.topics || []).some(
                    (t: any) => String(t.topicId) === targetTopicId
                  )
                ) {
                  matchedLesson = les;
                  targetLessonId = String(les.lessonId);
                  break;
                }
              }
              if (matchedLesson) break;
            }
          }
          if (!matchedLesson) {
            for (const ch of chaptersList) {
              for (const les of ch.lessons || []) {
                if (String(les.lessonId) === targetLessonId) {
                  matchedLesson = les;
                  break;
                }
              }
              if (matchedLesson) break;
            }
          }
          if (!matchedLesson && firstLesson) {
            matchedLesson = firstLesson;
            targetLessonId = String(firstLesson.lessonId);
          }
          if (matchedLesson) {
            const topicExists = (matchedLesson.topics || []).some(
              (t: any) => String(t.topicId) === targetTopicId
            );
            if (!topicExists && matchedLesson.topics?.[0]?.topicId) {
              targetTopicId = String(matchedLesson.topics[0].topicId);
            }
          }
        }

        if (isMounted) {
          if (targetLessonId) setActiveLessonId(targetLessonId);
          if (targetTopicId) setActiveTopicId(targetTopicId);
        }

        if (targetLessonId) {
          const contentData = await CurriculumClient.fetchLessonContent(
            targetLessonId,
            resolvedLang,
            undefined,
            activeSessionToken
          );
          if (isMounted) setLessonContent(contentData);
        }
      } catch (err: any) {
        console.error('[LearningSessionLayout] Init error:', err.message);
        if (isMounted) {
          if (typeof window !== 'undefined') {
            window.sessionStorage.removeItem('broadcast_rejoin_token');
            window.sessionStorage.removeItem('broadcast_rejoin_session_id');
          }
          setIsAuthVerifying(false);
          setAuthError(
            err?.message ||
              'Invalid or expired classroom credentials. Please launch the live class from Zerix Academy.'
          );
        }
      }
    };

    loadSessionData();
    return () => {
      isMounted = false;
    };
  }, [
    sessionId,
    role,
    teacherId,
    studentId,
    token,
    initialParams,
    setActiveLessonId,
    setActiveTopicId,
    setAttendanceList,
    setTeacherMicActive,
    setInvitedTeachers,
    setWhiteboardEditors,
    setMultiDeviceStudents,
    clientDeviceId,
  ]);

  // Reload lesson content when activeLessonId or languageId changes
  useEffect(() => {
    let isMounted = true;
    if (
      activeLessonId &&
      activeLessonId !== 'les_ohms_law' &&
      token &&
      !token.startsWith('DEV_TOKEN_')
    ) {
      CurriculumClient.fetchLessonContent(activeLessonId, languageId, undefined, token)
        .then((data) => {
          if (isMounted && data) {
            setLessonContent(data);
          }
        })
        .catch((err) => console.error('[Content] Error loading lesson content:', err));
    }
    return () => {
      isMounted = false;
    };
  }, [activeLessonId, languageId, token]);

  // Ensure activeLessonId and activeTopicId match a valid lesson/topic when curriculum loads or socket updates activeLessonId
  useEffect(() => {
    if (!curriculum?.chapters || curriculum.chapters.length === 0) return;
    const chaptersList = curriculum.chapters;

    // First check if activeTopicId belongs to a lesson in the curriculum
    if (activeTopicId) {
      for (const ch of chaptersList) {
        for (const les of ch.lessons || []) {
          if (
            Array.isArray(les.topics) &&
            les.topics.some((t: any) => String(t.topicId) === String(activeTopicId))
          ) {
            if (String(les.lessonId) !== String(activeLessonId)) {
              setActiveLessonId(String(les.lessonId));
            }
            return;
          }
        }
      }
    }

    let foundLesson: any = null;
    for (const ch of chaptersList) {
      for (const les of ch.lessons || []) {
        if (String(les.lessonId) === String(activeLessonId)) {
          foundLesson = les;
          break;
        }
      }
      if (foundLesson) break;
    }

    if (!foundLesson) {
      const firstLesson = chaptersList[0]?.lessons?.[0];
      if (firstLesson?.lessonId) {
        setActiveLessonId(String(firstLesson.lessonId));
        if (firstLesson.topics?.[0]?.topicId) {
          setActiveTopicId(String(firstLesson.topics[0].topicId));
        }
      }
      return;
    }

    const lessonHasOwnContent = Boolean(
      foundLesson.hasContent ||
        (foundLesson.description && String(foundLesson.description).trim() !== '') ||
        (Array.isArray(lessonContent?.lessonBlocks) && lessonContent.lessonBlocks.length > 0) ||
        (lessonContent?.contentHtml && String(lessonContent.contentHtml).trim() !== '')
    );

    if (
      Array.isArray(foundLesson.topics) &&
      foundLesson.topics.length > 0 &&
      !(activeTopicId === '' && lessonHasOwnContent) &&
      !foundLesson.topics.some((t: any) => String(t.topicId) === String(activeTopicId))
    ) {
      setActiveTopicId(String(foundLesson.topics[0].topicId));
    }
  }, [curriculum, lessonContent, activeLessonId, activeTopicId, setActiveLessonId, setActiveTopicId]);

  // Compute current user ID, Host/Co-Teacher status, Whiteboard edit permission & Mic permissions
  // Any course/batch teacher is ALWAYS the Primary Host Teacher unless they explicitly joined via a Co-Host invite link.
  const currentUserId = role === 'teacher' ? teacherId : `student_${studentId}`;
  const isCoHostTeacher = useMemo(() => {
    if (role !== 'teacher') return false;
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('cohost') === '1' || params.get('cohost') === 'true') {
        return true;
      }
    }
    if (isVerifiedCoTeacher) {
      return true;
    }
    if (
      ['teacher_502', 'teacher_503', 'teacher_504'].includes(teacherId) ||
      teacherId.startsWith('teacher_cohost') ||
      teacherId.startsWith('cohost')
    ) {
      return true;
    }
    return false;
  }, [role, teacherId, isVerifiedCoTeacher]);

  const isHostTeacher = role === 'teacher' && !isCoHostTeacher;

  const canEditWhiteboard = useMemo(() => {
    if (role === 'teacher') {
      if (isHostTeacher) return true;
      const cleanCurrentId = String(teacherId).replace(/^teacher_/, '');
      return (
        invitedTeachers.some(
          (t) =>
            (t.teacherId === teacherId ||
              String(t.teacherId).replace(/^teacher_/, '') === cleanCurrentId) &&
            t.canUseWhiteboard
        ) ||
        whiteboardEditors.includes(teacherId) ||
        whiteboardEditors.includes(cleanCurrentId)
      );
    }
    return (
      whiteboardEditors.includes(currentUserId) ||
      whiteboardEditors.includes(studentId) ||
      whiteboardEditors.includes(studentId.replace(/^student_/, ''))
    );
  }, [role, isHostTeacher, teacherId, currentUserId, studentId, invitedTeachers, whiteboardEditors]);

  const hasStudentMicGrant =
    role === 'teacher' ||
    canPublishAudio ||
    Boolean(allowStudentUnmute) ||
    activeStudentMics.includes(currentUserId) ||
    activeStudentMics.includes(studentId) ||
    activeStudentMics.includes(studentId.replace('student_', ''));

  // LiveKit Two-Way Audio Stage Hook (All Mics Muted by Default + Active DSP Noise Cancellation + Port-443 Voice Relay)
  const {
    isMicrophoneEnabled,
    isNoiseCancellationEnabled,
    isAudioConnected,
    audioPlaybackBlocked,
    micError,
    clearMicError,
    ensureMicrophonePermission,
    playIncomingVoiceFrame,
    setMicrophoneActive,
    toggleMicrophone,
    toggleNoiseCancellation,
    unlockAudioPlayback,
    recoverAudioStage,
  } = useLiveKitStage({
    livekitUrl,
    token: livekitToken,
    canPublishAudio: hasStudentMicGrant,
    autoActivateMic: pendingMicAutoActivate,
    localUserId: currentUserId,
    clientDeviceId,
    onMicStateChange: (enabled) => {
      if (role === 'teacher') {
        broadcastTeacherMicState(enabled);
      } else if (role === 'student') {
        notifyDeviceMicActive(enabled);
      }
    },
    onEmitVoiceFrame: broadcastVoiceFrame,
  });

  useEffect(() => {
    setMicrophoneActiveRef.current = setMicrophoneActive;
  }, [setMicrophoneActive]);

  useEffect(() => {
    playIncomingVoiceFrameRef.current = playIncomingVoiceFrame;
  }, [playIncomingVoiceFrame]);

  useEffect(() => {
    isMicrophoneEnabledRef.current = isMicrophoneEnabled;
  }, [isMicrophoneEnabled]);

  useEffect(() => {
    recoverAudioStageRef.current = async () => {
      await recoverAudioStage();
      if (isMicrophoneEnabledRef.current) {
        if (role === 'teacher') {
          broadcastTeacherMicState(true);
        } else if (role === 'student') {
          notifyDeviceMicActive(true);
        }
      }
    };
  }, [recoverAudioStage, role, broadcastTeacherMicState, notifyDeviceMicActive]);

  // Auto-activate student microphone when host grants mic access
  useEffect(() => {
    if (pendingMicAutoActivate && role === 'student') {
      setPendingMicAutoActivate(false);
      setMicrophoneActive(true).catch((err) => {
        console.warn('[LearningSessionLayout] Mic auto-activation notice:', err?.message || err);
      });
    }
  }, [pendingMicAutoActivate, role, setMicrophoneActive]);

  // Student Raise Hand Handler:
  // First checks/requests browser microphone permission in real time.
  // Only after permission is granted by the student's browser do we emit raiseHand()
  // so the student is shown to the Host / Co-Host in the "Allow Mic" queue.
  const handleStudentRaiseHand = useCallback(async () => {
    unlockAudioPlayback();
    const perm = await ensureMicrophonePermission();
    if (!perm.granted) {
      return;
    }
    raiseHand();
  }, [ensureMicrophonePermission, raiseHand, unlockAudioPlayback]);

  // Automatically turn off local microphone when the session ends or participant leaves
  useEffect(() => {
    if ((teacherStatus === 'ENDED' || hasLeftSession) && isMicrophoneEnabled) {
      setMicrophoneActive(false).catch(() => {});
    }
  }, [teacherStatus, hasLeftSession, isMicrophoneEnabled, setMicrophoneActive]);

  // Handle local microphone toggle for ALL user types (Host Teacher, Co-Host Teacher, Student):
  // - Checks browser microphone permission in real time whenever unmuting
  // - Students notify server per-device on mute/unmute so multi-device mics operate independently
  const handleToggleLocalMic = useCallback(async () => {
    unlockAudioPlayback();
    if (role === 'student') {
      if (isMicrophoneEnabled) {
        await setMicrophoneActive(false);
        studentSelfMute();
      } else {
        const perm = await ensureMicrophonePermission();
        if (!perm.granted) {
          return;
        }
        if (allowStudentUnmute) {
          studentSelfUnmute();
        }
        await setMicrophoneActive(true);
      }
    } else {
      if (!isMicrophoneEnabled) {
        const perm = await ensureMicrophonePermission();
        if (!perm.granted) {
          return;
        }
      }
      await toggleMicrophone();
    }
  }, [
    role,
    isMicrophoneEnabled,
    allowStudentUnmute,
    ensureMicrophonePermission,
    setMicrophoneActive,
    studentSelfMute,
    studentSelfUnmute,
    toggleMicrophone,
    unlockAudioPlayback,
  ]);

  // Normalize Curriculum Chapters for Sidebar
  const normalizedChapters: ChapterItem[] = useMemo(() => {
    if (!curriculum?.chapters) return [];
    return curriculum.chapters.map((ch: any) => ({
      chapterId: String(ch.chapterId),
      title: ch.title,
      lessons: (ch.lessons || []).map((les: any) => ({
        lessonId: String(les.lessonId),
        title: les.title,
        duration:
          les.duration ||
          `${(les.topics || []).reduce(
            (acc: number, t: any) => acc + (t.durationMinutes || 15),
            0
          )}m`,
        hasContent: Boolean(
          les.hasContent || (les.description && String(les.description).trim() !== '')
        ),
        description: les.description || undefined,
        topics: (les.topics || []).map((top: any) => ({
          topicId: String(top.topicId),
          title: top.title,
          durationMinutes: top.durationMinutes,
        })),
      })),
    }));
  }, [curriculum]);

  // Determine current Chapter, Lesson, and Topic titles for the Top Header Breadcrumb
  const { activeChapterId, chapterTitle, lessonTitle, topicTitle } = useMemo(() => {
    const firstChapter = normalizedChapters[0];
    const firstLesson = firstChapter?.lessons?.[0];
    const firstTopic = firstLesson?.topics?.[0];

    let chapId = String(
      sessionMetadata?.chapterId || firstChapter?.chapterId || initialParams.chapterId || ''
    );
    let chapTitle =
      sessionMetadata?.chapterTitle ||
      firstChapter?.title ||
      curriculum?.courseName ||
      sessionMetadata?.courseName ||
      'Course Curriculum';
    let lesTitle =
      lessonContent?.lessonTitle ||
      sessionMetadata?.lessonTitle ||
      firstLesson?.title ||
      'Live Classroom Lesson';
    let topTitle =
      activeTopicId === ''
        ? lesTitle
        : sessionMetadata?.topicTitle || firstTopic?.title || lesTitle;

    for (const ch of normalizedChapters) {
      for (const les of ch.lessons) {
        if (String(les.lessonId) === String(activeLessonId)) {
          chapId = String(ch.chapterId);
          chapTitle = ch.title;
          lesTitle = les.title;
          if (activeTopicId === '') {
            topTitle = les.title;
          } else {
            const matchedTopic = les.topics.find(
              (t) => String(t.topicId) === String(activeTopicId)
            );
            if (matchedTopic) {
              topTitle = matchedTopic.title;
            } else if (les.topics[0]) {
              topTitle = les.topics[0].title;
            } else {
              topTitle = les.title;
            }
          }
        }
      }
    }

    return {
      activeChapterId: chapId,
      chapterTitle: chapTitle,
      lessonTitle: lesTitle,
      topicTitle: topTitle,
    };
  }, [
    normalizedChapters,
    activeLessonId,
    activeTopicId,
    sessionMetadata,
    lessonContent,
    curriculum,
    initialParams.chapterId,
  ]);

  // Normalize Lesson Blocks for VirtualContentStage
  // Supports both Lesson-level HTML content (activeTopicId === '') and Topic-level HTML content
  const normalizedBlocks: LessonBlock[] = useMemo(() => {
    const topicsArray: any[] = Array.isArray(lessonContent?.topics)
      ? lessonContent.topics
      : [];
    const rawBlocks: any[] = Array.isArray(lessonContent?.blocks)
      ? lessonContent.blocks
      : [];
    const lessonBlocksArray: any[] = Array.isArray(lessonContent?.lessonBlocks)
      ? lessonContent.lessonBlocks
      : [];

    let filteredBlocks: any[] = rawBlocks;

    if (!activeTopicId) {
      if (lessonBlocksArray.length > 0) {
        filteredBlocks = lessonBlocksArray;
      } else if (
        lessonContent?.contentHtml &&
        String(lessonContent.contentHtml).trim() !== ''
      ) {
        filteredBlocks = [
          {
            blockId: 'blk_lesson_html',
            type: 'concept',
            content: '',
            contentHtml: String(lessonContent.contentHtml),
          },
        ];
      } else if (
        lessonContent?.description &&
        String(lessonContent.description).trim() !== ''
      ) {
        filteredBlocks = [
          {
            blockId: 'blk_lesson_desc',
            type: 'concept',
            content: '',
            contentHtml: String(lessonContent.description),
          },
        ];
      } else if (rawBlocks.some((b: any) => !b.topicId)) {
        filteredBlocks = rawBlocks.filter((b: any) => !b.topicId);
      }
    } else {
      const matchedTopic = topicsArray.find(
        (t: any) => String(t.topicId) === String(activeTopicId)
      );
      if (matchedTopic && Array.isArray(matchedTopic.blocks) && matchedTopic.blocks.length > 0) {
        filteredBlocks = matchedTopic.blocks;
      } else if (
        matchedTopic?.contentHtml &&
        String(matchedTopic.contentHtml).trim() !== ''
      ) {
        filteredBlocks = [
          {
            blockId: `blk_topic_${activeTopicId}`,
            type: 'concept',
            content: '',
            contentHtml: String(matchedTopic.contentHtml),
            topicId: String(activeTopicId),
            topicTitle: matchedTopic.title,
          },
        ];
      } else if (
        topicsArray.length > 0 ||
        rawBlocks.some((b: any) => b.topicId !== undefined && b.topicId !== null)
      ) {
        filteredBlocks = rawBlocks.filter(
          (b: any) => String(b.topicId) === String(activeTopicId)
        );
      }
    }

    return filteredBlocks.map((b: any) => ({
      blockId: String(b.blockId),
      type:
        b.type === 'callout'
          ? 'problem'
          : b.type === 'paragraph'
          ? 'concept'
          : b.type || 'concept',
      title: b.title,
      content: b.content || '',
      contentHtml: b.contentHtml || undefined,
      formulaLatex: b.formulaLatex,
      svgDiagram: b.svgDiagram,
      topicId: b.topicId ? String(b.topicId) : undefined,
      topicTitle: b.topicTitle,
    }));
  }, [lessonContent, activeTopicId]);

  // Map Socket Mode to Top Header ActiveMode (Student Rough Pad removed)
  const activeMode: ActiveMode = mode === 'WHITEBOARD' ? 'whiteboard' : 'content';
  const isWhiteboardView = activeMode === 'whiteboard';

  // Build Relational Hierarchy Context for 720p VOD & Gzip Whiteboard storage
  const relationalContext: RelationalLessonContext = useMemo(
    () => ({
      sessionId,
      contextType: 'course_lesson',
      branchId: Number(sessionMetadata?.branchId || initialParams.branchId) || 0,
      batchId: Number(sessionMetadata?.batchId || initialParams.batchId) || 0,
      boardId: sessionMetadata?.boardId ?? initialParams.boardId,
      languageId: Number(languageId) || 1,
      courseId: Number(sessionMetadata?.courseId || initialParams.courseId) || 0,
      linkedVodCourseId: Number(
        sessionMetadata?.linkedVodCourseId || initialParams.linkedVodCourseId
      ) || 0,
      subjectId: Number(sessionMetadata?.subjectId || initialParams.subjectId) || 0,
      chapterId: activeChapterId,
      chapterNumber: 1,
      chapterTitle,
      lessonId: activeLessonId,
      lessonNumber: '1',
      lessonTitle,
      topicId: activeTopicId,
      teacherId,
      academicYear: initialParams.academicYear,
      version: initialParams.version,
      publishToVodCourse: teachingMode === 'taught',
      isPrimaryVod: true,
    }),
    [
      sessionId,
      sessionMetadata,
      initialParams,
      languageId,
      activeChapterId,
      chapterTitle,
      activeLessonId,
      lessonTitle,
      activeTopicId,
      teacherId,
      teachingMode,
    ]
  );

  const currentTeacherDisplayName = useMemo(() => {
    if (role === 'teacher' && isHostTeacher && verifiedUserName) return verifiedUserName;
    return (
      sessionMetadata?.teacherName ||
      (role === 'teacher' && isHostTeacher ? verifiedUserName : '') ||
      'Instructor'
    );
  }, [role, isHostTeacher, verifiedUserName, sessionMetadata]);

  const currentUserDisplayName = useMemo(() => {
    if (verifiedUserName) return verifiedUserName;
    if (role === 'teacher') {
      return isHostTeacher ? currentTeacherDisplayName : 'Co-Host';
    }
    return studentId ? `Student #${studentId}` : 'Student';
  }, [verifiedUserName, role, isHostTeacher, currentTeacherDisplayName, studentId]);

  const resolvedCourseTitle = useMemo(
    () =>
      (sessionMetadata as any)?.courseTitle ||
      (curriculum as any)?.courseTitle ||
      (curriculum as any)?.title ||
      'Live Classroom Course',
    [sessionMetadata, curriculum]
  );

  // Browser-Side 720p Hardware Encoder & Jittered Chunk Uploader Hook (Manual Start/Stop/Restart)
  const {
    isRecording,
    isFinalizing: isFinalizingRecording,
    recordingDurationSec,
    chunksUploaded,
    offlineQueuedChunksCount,
    hasResumableRecording,
    resumableDurationSec,
    startRecording,
    resumeRecording,
    stopAndFinalizeRecording,
    restartRecording,
    getCurrentVideoOffsetSec,
  } = useCompressedClassRecorder({
    sessionId,
    role,
    isHostTeacher,
    token,
    relationalContext,
    activeMode,
    teachingMode,
    courseTitle: resolvedCourseTitle,
    subjectName: (sessionMetadata as any)?.subjectName || (curriculum as any)?.subjectName || '',
    batchName: (sessionMetadata as any)?.batchName || (sessionMetadata as any)?.title || '',
    chapterTitle,
    lessonTitle,
    topicTitle,
    teacherName: currentTeacherDisplayName,
    isLocalMicOn: isMicrophoneEnabled,
    initialVideoState,
    getWhiteboardSnapshot: () => ({
      elements: incomingWhiteboardDelta || [],
      appState: { viewBackgroundColor: '#ffffff' },
      files: whiteboardFiles || {},
    }),
  });

  const openRecordingSetupModal = useCallback(
    (modeToOpen: 'start' | 'restart' = 'start') => {
      setRecordingModalMode(modeToOpen);
      setRecordingModalForm({
        courseTitle: resolvedCourseTitle || 'Live Classroom Course',
        subjectName:
          (sessionMetadata as any)?.subjectName || (curriculum as any)?.subjectName || 'General',
        batchName:
          (sessionMetadata as any)?.batchName || (sessionMetadata as any)?.title || sessionId,
        chapterTitle: chapterTitle || 'Chapter 1',
        lessonTitle: lessonTitle || 'Live Lesson',
        topicTitle: topicTitle || '',
        teacherName: currentTeacherDisplayName || 'Instructor',
        academicYear: String(initialParams.academicYear || new Date().getFullYear()),
        version: String(initialParams.version || 1),
        recordVoice: true,
      });
      setIsRecordingModalOpen(true);
    },
    [
      resolvedCourseTitle,
      sessionMetadata,
      curriculum,
      sessionId,
      chapterTitle,
      lessonTitle,
      topicTitle,
      currentTeacherDisplayName,
      initialParams.academicYear,
      initialParams.version,
    ]
  );

  const handleConfirmRecordingModal = useCallback(async () => {
    setIsRecordingModalOpen(false);
    if (recordingModalMode === 'restart') {
      await restartRecording('display_media', recordingModalForm);
    } else {
      await startRecording('display_media', recordingModalForm, {
        resume: false,
        forceReset: true,
      });
    }
  }, [recordingModalMode, recordingModalForm, restartRecording, startRecording]);

  // Synchronously update Course Curriculum sidebar default visibility whenever the active view mode changes:
  // - Whiteboard: hide Course Curriculum sidebar by default (isSidebarCollapsed = true)
  // - Content Mode: show Course Curriculum sidebar by default on desktop/tablet (isSidebarCollapsed = false),
  //   while keeping the fixed slide-over overlay drawer closed on mobile phones (< 768px) so content stays full-width.
  const [prevIsWhiteboardView, setPrevIsWhiteboardView] = useState<boolean>(isWhiteboardView);
  if (prevIsWhiteboardView !== isWhiteboardView) {
    setPrevIsWhiteboardView(isWhiteboardView);
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
    setIsSidebarCollapsed(isWhiteboardView ? true : isMobile);
  }

  useEffect(() => {
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
    setIsSidebarCollapsed(isWhiteboardView ? true : isMobile);
  }, [isWhiteboardView]);

  // Map Whiteboard Camera State (Formula B)
  const cameraState: WhiteboardCameraState = useMemo(
    () => ({
      centerX: teacherCam?.Cx ?? 640,
      centerY: teacherCam?.Cy ?? 360,
      zoom: teacherCam?.Zt ?? 1.0,
      viewportWidth: teacherCam?.Wt ?? 1280,
      viewportHeight: teacherCam?.Ht ?? 720,
      authorId: teacherCam?.authorId,
      authorName: teacherCam?.authorName,
      updatedAt: teacherCam?.updatedAt,
    }),
    [teacherCam]
  );

  // Map Whiteboard Teacher / Collaborator Cursor State (Formula B.5)
  const cursorState: WhiteboardCursorState = useMemo(
    () => ({
      x: whiteboardCursor?.Lx ?? 0,
      y: whiteboardCursor?.Ly ?? 0,
      tool: whiteboardCursor?.tool ?? 'pointer',
      button: whiteboardCursor?.button ?? 'up',
      active: Boolean(whiteboardCursor?.active),
      teacherName: whiteboardCursor?.teacherName || sessionMetadata?.teacherName || 'Teacher',
      userId: whiteboardCursor?.userId,
      role: whiteboardCursor?.role,
    }),
    [whiteboardCursor, sessionMetadata]
  );

  // Normalize Attendance List so both backend StudentAttendanceCalculation (userId, name)
  // and frontend StudentAttendanceSummary (studentId, studentName) schemas work seamlessly
  const normalizedAttendanceList: StudentAttendanceSummary[] = useMemo(
    () =>
      (attendanceList || []).map((s: any) => {
        const resolvedId = s.studentId || s.userId || '';
        const cleanResolvedId = String(resolvedId).replace(/^student_/, '');
        const cleanCurrentStudentId = String(studentId || '').replace(/^student_/, '');
        const isSelfStudent =
          role === 'student' &&
          Boolean(
            cleanResolvedId &&
              cleanCurrentStudentId &&
              cleanResolvedId === cleanCurrentStudentId
          );
        const rawName = s.studentName || s.name || s.userName || '';
        const resolvedName =
          isSelfStudent &&
          verifiedUserName &&
          (!rawName || rawName.startsWith('Student #'))
            ? verifiedUserName
            : rawName ||
              (isSelfStudent && verifiedUserName ? verifiedUserName : '') ||
              `Student #${cleanResolvedId}`;
        return {
          studentId: resolvedId,
          studentName: resolvedName,
          isOnline: Boolean(s.isOnline),
          firstJoinedAt: s.firstJoinedAt || Date.now(),
          lastSeenAt: s.lastSeenAt || Date.now(),
          leftAt: s.leftAt ?? null,
          totalJoinedSeconds: s.totalJoinedSeconds ?? 0,
          totalJoinedMinutes: s.totalJoinedMinutes ?? 0,
          totalJoinedHours: s.totalJoinedHours ?? 0,
          rejoinCount: s.rejoinCount ?? 0,
          attendancePercentage: s.attendancePercentage ?? 100,
          status: (String(s.status || 'PRESENT').toUpperCase() as any) || 'PRESENT',
        };
      }),
    [attendanceList, role, studentId, verifiedUserName]
  );

  // Map Audio Stage State for TopModeNavbar & Joined Students Drawer
  const audioStageState: AudioStageState = useMemo(() => {
    const nameMap = new Map<string, string>();
    for (const s of normalizedAttendanceList) {
      nameMap.set(s.studentId, s.studentName);
      const cleanId = String(s.studentId).replace(/^student_/, '');
      if (cleanId) {
        nameMap.set(cleanId, s.studentName);
        nameMap.set(`student_${cleanId}`, s.studentName);
      }
    }

    const seenStudentMics = new Set<string>();
    const dedupedActiveMics: Array<{ studentId: string; studentName: string; grantedAt: number }> = [];
    for (const id of activeStudentMics) {
      const cleanId = String(id).replace(/^student_/, '');
      if (!cleanId || seenStudentMics.has(cleanId)) continue;
      seenStudentMics.add(cleanId);
      dedupedActiveMics.push({
        studentId: id,
        studentName:
          nameMap.get(id) ||
          nameMap.get(cleanId) ||
          `Student #${cleanId}`,
        grantedAt: Date.now(),
      });
    }

    return {
      teacherMicActive:
        role === 'teacher' && isHostTeacher ? isMicrophoneEnabled : teacherMicActive,
      maxAllowedStudentMics: sessionMetadata?.maxStudentMics || 10,
      activeStudentMics: dedupedActiveMics,
      raisedHands: raisedHands.map((h: any) => ({
        studentId: h.userId || h.studentId,
        studentName: h.name || h.userName || h.studentName || `Student #${h.userId}`,
        raisedAt: h.raisedAt || Date.now(),
      })),
      invitedTeachers: isHostTeacher
        ? invitedTeachers.filter((t) => {
            const cleanT = String(t.teacherId).replace(/^teacher_/, '');
            const cleanHost = String(teacherId).replace(/^teacher_/, '');
            return t.teacherId !== teacherId && cleanT !== cleanHost;
          })
        : invitedTeachers,
      whiteboardEditors,
      multiDeviceStudents,
      allowStudentUnmute: Boolean(allowStudentUnmute),
    };
  }, [
    role,
    isHostTeacher,
    isMicrophoneEnabled,
    teacherMicActive,
    sessionMetadata,
    activeStudentMics,
    raisedHands,
    normalizedAttendanceList,
    invitedTeachers,
    whiteboardEditors,
    multiDeviceStudents,
    allowStudentUnmute,
  ]);

  const hasRaisedHand = useMemo(
    () =>
      audioStageState.raisedHands.some(
        (h) => h.studentId === currentUserId || h.studentId === studentId
      ),
    [audioStageState.raisedHands, currentUserId, studentId]
  );

  // Toggle between 'taught' (Record & Save WB to VOD) and 'reference_only' (Protect existing VOD & WB)
  const handleToggleTeachingMode = useCallback(() => {
    if (role !== 'teacher' || !isHostTeacher) return;
    const nextMode: CurriculumTeachingMode =
      teachingMode === 'taught' ? 'reference_only' : 'taught';
    setTeachingMode(nextMode);
    setLessonModesMap((prev) => ({ ...prev, [activeLessonId]: nextMode }));

    CurriculumClient.navigateCurriculum(sessionId, {
      chapterId: activeChapterId,
      lessonId: activeLessonId,
      topicId: activeTopicId,
      videoOffsetSec: getCurrentVideoOffsetSec(),
      mode: nextMode,
      token,
      relationalContext: {
        ...relationalContext,
        publishToVodCourse: nextMode === 'taught',
      },
    }).catch(() => {});
  }, [
    role,
    isHostTeacher,
    teachingMode,
    activeLessonId,
    sessionId,
    activeChapterId,
    activeTopicId,
    getCurrentVideoOffsetSec,
    token,
    relationalContext,
  ]);

  // Multi-Topic Curriculum Navigation Handler (Never restarts 720p Video Recorder)
  const handleNavigateCurriculumTopic = useCallback(
    (
      nextChapterId: string,
      nextLessonId: string,
      nextTopicId: string,
      requestedMode?: CurriculumTeachingMode
    ) => {
      const resolvedNextMode: CurriculumTeachingMode =
        requestedMode || lessonModesMap[nextLessonId] || teachingMode;

      // If switching to a different lesson and the outgoing lesson was in 'taught' mode,
      // auto-save the outgoing lesson's Excalidraw Whiteboard JSON (stripping Content Mode strokes)
      if (
        role === 'teacher' &&
        isHostTeacher &&
        nextLessonId !== activeLessonId
      ) {
        const currentElements = incomingWhiteboardDelta || [];
        const currentFiles = whiteboardFiles || {};
        lessonWhiteboardsRef.current[activeLessonId] = {
          elements: currentElements,
          files: currentFiles,
        };

        const outgoingMode = lessonModesMap[activeLessonId] || teachingMode;
        if (outgoingMode === 'taught' && currentElements.length > 0) {
          CurriculumClient.saveWhiteboard(sessionId, {
            chapterId: activeChapterId,
            lessonId: activeLessonId,
            topicId: activeTopicId,
            elements: currentElements,
            appState: { viewBackgroundColor: '#ffffff' },
            files: currentFiles,
            relationalContext,
            token,
          }).catch(() => {});
        }
      }

      setTeachingMode(resolvedNextMode);
      setLessonModesMap((prev) => ({ ...prev, [nextLessonId]: resolvedNextMode }));

      // Log multi-topic segment offset in SessionTimelineTracker without splitting video_720p.webm
      if (role === 'teacher' && isHostTeacher) {
        CurriculumClient.navigateCurriculum(sessionId, {
          chapterId: nextChapterId,
          lessonId: nextLessonId,
          topicId: nextTopicId,
          videoOffsetSec: getCurrentVideoOffsetSec(),
          mode: resolvedNextMode,
          token,
          relationalContext: {
            ...relationalContext,
            chapterId: nextChapterId,
            lessonId: nextLessonId,
            topicId: nextTopicId,
            publishToVodCourse: resolvedNextMode === 'taught',
          },
        }).catch(() => {});
      }

      broadcastNavSync(nextLessonId, nextTopicId);
      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        setIsSidebarCollapsed(true);
      }
    },
    [
      lessonModesMap,
      teachingMode,
      role,
      isHostTeacher,
      activeLessonId,
      incomingWhiteboardDelta,
      whiteboardFiles,
      sessionId,
      activeChapterId,
      activeTopicId,
      relationalContext,
      token,
      getCurrentVideoOffsetSec,
      broadcastNavSync,
    ]
  );

  // Role & Session Switch Handlers (Disabled in production token-authenticated mode)
  const handleSwitchRole = (_newRole: 'teacher' | 'student', _nextTeacherId?: string) => {
    // Role switching is governed strictly by the signed classroom token from Zerix Academy
  };

  const handleSelectBatch = (_newSessionId: string) => {
    // Session selection is governed strictly by the signed classroom token from Zerix Academy
  };

  // Disconnect LiveKit audio automatically when the broadcast ends
  useEffect(() => {
    if (teacherStatus === 'ENDED' || hasLeftSession) {
      if (isMicrophoneEnabled) {
        toggleMicrophone();
      }
      setLivekitToken('');
      setCanPublishAudio(false);
    }
  }, [teacherStatus, hasLeftSession, isMicrophoneEnabled, toggleMicrophone]);

  // When class is ended by host/cohost, automatically redirect all participants to the dedicated Rejoin Page
  useEffect(() => {
    if (teacherStatus === 'ENDED') {
      if (token) {
        sessionStorage.setItem('broadcast_rejoin_token', token);
        sessionStorage.setItem('broadcast_rejoin_session_id', sessionId);
      }
      const queryParams = new URLSearchParams({
        sessionId,
        role,
        ...(studentId ? { studentId } : {}),
        ...(teacherId ? { teacherId } : {}),
        ended: 'true',
      });
      const timer = setTimeout(() => {
        window.location.href = `/rejoin?${queryParams.toString()}`;
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [teacherStatus, sessionId, role, studentId, teacherId, token]);

  const handleLeaveMeeting = useCallback(() => {
    if (isMicrophoneEnabled) {
      toggleMicrophone();
    }
    setLivekitToken('');
    setCanPublishAudio(false);
    leaveSession();

    if (token) {
      sessionStorage.setItem('broadcast_rejoin_token', token);
      sessionStorage.setItem('broadcast_rejoin_session_id', sessionId);
    }
    // Redirect to room-based Rejoin Page
    const queryParams = new URLSearchParams({
      sessionId,
      role,
      ...(studentId ? { studentId } : {}),
      ...(teacherId ? { teacherId } : {}),
      left: 'true',
    });
    window.location.href = `/rejoin?${queryParams.toString()}`;
  }, [isMicrophoneEnabled, toggleMicrophone, leaveSession, sessionId, role, studentId, teacherId, token]);

  const handleEndClass = useCallback(async () => {
    if (isMicrophoneEnabled) {
      toggleMicrophone();
    }
    setLivekitToken('');
    setCanPublishAudio(false);

    // If recording is active when ending class, flush final video chunk, save active taught lesson's Whiteboard JSON, and finalize session BEFORE ending room & redirecting
    if (isRecording) {
      try {
        await Promise.race([
          stopAndFinalizeRecording(),
          new Promise((resolve) => setTimeout(resolve, 4000)),
        ]);
      } catch {
        // Ignore finalization error during teardown
      }
    }

    endSession();

    if (token) {
      sessionStorage.setItem('broadcast_rejoin_token', token);
      sessionStorage.setItem('broadcast_rejoin_session_id', sessionId);
    }
    // Redirect host/cohost to room-based Rejoin Page with ended=true
    const queryParams = new URLSearchParams({
      sessionId,
      role,
      ...(studentId ? { studentId } : {}),
      ...(teacherId ? { teacherId } : {}),
      ended: 'true',
    });
    setTimeout(() => {
      window.location.href = `/rejoin?${queryParams.toString()}`;
    }, 200);
  }, [
    isMicrophoneEnabled,
    toggleMicrophone,
    isRecording,
    stopAndFinalizeRecording,
    endSession,
    sessionId,
    role,
    studentId,
    teacherId,
    token,
  ]);

  const handleRejoinSession = useCallback(async () => {
    rejoinSession();
    try {
      const initData = await CurriculumClient.initSession({
        sessionId,
        role,
        teacherId,
        studentId,
        token,
        deviceId: clientDeviceId,
      });
      if ((initData as any).videoState) {
        setInitialVideoState((initData as any).videoState);
      }
      if (initData.livekit) {
        setLivekitToken(initData.livekit.token);
        setCanPublishAudio(initData.livekit.canPublishAudio);
      }
    } catch {
      // Ignore init error on rejoin
    }
  }, [rejoinSession, sessionId, role, teacherId, studentId, token, clientDeviceId]);

  const academyPortalUrl =
    process.env.NEXT_PUBLIC_ACADEMY_URL || 'https://academy.zerixtech.com';

  // Strict Classroom Authentication Gate: Block direct unauthenticated access to studio.zerixtech.com
  if (authError || (!isAuthVerifying && (!sessionId || !token))) {
    return (
      <div
        data-testid="studio-auth-required-screen"
        className="fixed inset-0 flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950 text-slate-100 p-4"
      >
        <div className="max-w-md w-full rounded-3xl bg-slate-800/95 border border-slate-700/80 shadow-2xl p-6 sm:p-8 text-center space-y-5">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400 text-2xl font-bold">
            🔒
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-bold text-white">
              Classroom Authentication Required
            </h1>
            <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
              {authError ||
                'Direct access to Zerix Live Broadcast Studio is restricted. Both instructors and students must launch or join the live class from Zerix Academy with a valid classroom token.'}
            </p>
          </div>
          <div className="pt-2">
            <a
              href={academyPortalUrl}
              className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-2xl bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white text-sm font-bold shadow-lg shadow-sky-500/20 transition-all"
            >
              <span>Go to Zerix Academy</span>
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (isAuthVerifying && !sessionMetadata) {
    return (
      <div
        data-testid="studio-auth-verifying-screen"
        className="fixed inset-0 flex items-center justify-center bg-slate-900 text-slate-100 p-4"
      >
        <div className="text-center space-y-3">
          <div className="mx-auto w-10 h-10 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
          <p className="text-sm font-semibold text-slate-200">
            Verifying classroom identity &amp; session token...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={workspaceContainerRef}
      data-testid="learning-session-workspace"
      data-fullscreen={isFullscreen ? 'true' : 'false'}
      data-topnav-visible={isTopNavVisible ? 'true' : 'false'}
      className="fixed inset-0 flex flex-col h-screen w-screen h-dvh w-dvw overflow-hidden bg-slate-50 text-slate-900"
    >
      {/* 1. Compact Single Top Header (h-12 on mobile / h-14 on desktop, collapsible via screen tap or QuickBar) */}
      <TopModeNavbar
        role={role}
        userId={currentUserId}
        userName={currentUserDisplayName}
        teacherName={currentTeacherDisplayName}
        isHostTeacher={isHostTeacher}
        canEditWhiteboard={canEditWhiteboard}
        chapterTitle={chapterTitle}
        lessonTitle={lessonTitle}
        topicTitle={topicTitle}
        activeMode={activeMode}
        isSidebarCollapsed={isSidebarCollapsed}
        isConnected={isConnected}
        participantsCount={onlineCount}
        audioStage={audioStageState}
        attendanceList={normalizedAttendanceList}
        followTeacher={followTeacher}
        studentZoomMultiplier={studentZoomMultiplier}
        isLocalMicOn={isMicrophoneEnabled}
        isNoiseCancellationEnabled={isNoiseCancellationEnabled}
        hasRaisedHand={hasRaisedHand}
        hasStudentMicGrant={hasStudentMicGrant}
        batches={EMPTY_BATCHES}
        selectedSessionId={sessionId}
        isTopNavVisible={isTopNavVisible}
        isFullscreen={isFullscreen}
        isContentToolboxVisible={isContentToolboxVisible}
        teachingMode={teachingMode}
        onToggleTeachingMode={handleToggleTeachingMode}
        isRecording={isRecording}
        isFinalizingRecording={isFinalizingRecording}
        recordingDurationSec={recordingDurationSec}
        chunksUploaded={chunksUploaded}
        onStartRecording={() => {
          if (hasResumableRecording) {
            startRecording('display_media').catch(() => {});
          } else {
            openRecordingSetupModal('start');
          }
        }}
        onStopRecording={() => {
          stopAndFinalizeRecording().catch(() => {});
        }}
        onRestartRecording={() => {
          openRecordingSetupModal('restart');
        }}
        onToggleRecording={() => {
          if (isRecording) {
            stopAndFinalizeRecording().catch(() => {});
          } else if (hasResumableRecording) {
            startRecording('display_media').catch(() => {});
          } else {
            openRecordingSetupModal('start');
          }
        }}
        onToggleContentToolbox={() => setIsContentToolboxVisible((prev) => !prev)}
        onToggleFullscreen={toggleFullscreen}
        onToggleTopNav={toggleTopNav}
        onToggleSidebar={() => setIsSidebarCollapsed((prev) => !prev)}
        onSwitchMode={(nextMode) => {
          const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
          setIsSidebarCollapsed(nextMode === 'whiteboard' ? true : isMobile);
          changeMode(nextMode === 'whiteboard' ? 'WHITEBOARD' : 'CONTENT');
        }}
        onToggleFollow={(follow) => setFollowTeacher(follow)}
        onChangeZoomMultiplier={(updater) =>
          setStudentZoomMultiplier((prev) => updater(prev))
        }
        onToggleLocalMic={handleToggleLocalMic}
        onToggleNoiseCancellation={toggleNoiseCancellation}
        onToggleAllowStudentUnmute={(allow) => setAllowStudentUnmuteOption(allow)}
        onRaiseHand={handleStudentRaiseHand}
        onLowerHand={() => lowerHand(currentUserId)}
        onGrantStudentMic={(targetStudentId, _studentName, cb) => {
          clearAudioError();
          if (audioStageState.activeStudentMics.length >= audioStageState.maxAllowedStudentMics) {
            cb?.({
              ok: false,
              message:
                audioError?.message ||
                `Maximum of ${audioStageState.maxAllowedStudentMics} student microphones are already active. Mute an existing student or use 'Mute Oldest & Allow'.`,
            });
            return;
          }
          grantMic(targetStudentId, false);
          cb?.({ ok: true });
        }}
        onRevokeStudentMic={(targetStudentId) => muteStudent(targetStudentId)}
        onMuteAllStudents={muteAllStudents}
        onInviteCoTeacher={inviteCoTeacher}
        onToggleCoTeacherWhiteboard={toggleCoTeacherWhiteboard}
        onRemoveCoTeacher={removeCoTeacher}
        onGrantWhiteboardAccess={(targetUserId) => {
          grantWhiteboardAccess(targetUserId);
          if (activeMode !== 'whiteboard') {
            setIsSidebarCollapsed(true);
            changeMode('WHITEBOARD');
          }
        }}
        onRevokeWhiteboardAccess={revokeWhiteboardAccess}
        onToggleStudentMultiDevice={setStudentMultiDeviceAccess}
        onSwitchRole={handleSwitchRole}
        onSelectBatch={handleSelectBatch}
        onSimulateDisconnect={simulateDisconnect}
        onLeaveMeeting={handleLeaveMeeting}
        onEndClass={handleEndClass}
        coHostInviteToken={coHostInviteToken}
        onRefreshCoHostInviteToken={async (canUseWhiteboard) => {
          try {
            const res = await CurriculumClient.mintCoHostInviteToken(
              sessionId,
              { canUseWhiteboard },
              token
            );
            if (res?.coHostInviteToken) {
              setCoHostInviteToken(res.coHostInviteToken);
              return res.coHostInviteToken;
            }
          } catch (err) {
            console.warn('[LearningSessionLayout] Failed to refresh co-host invite token:', err);
          }
          return coHostInviteToken;
        }}
      />

      {/* 1b. Real-Time Microphone Permission Alert & Autoplay Audio Unlock Banners */}
      {micError && (
        <div
          data-testid="mic-permission-alert-banner"
          role="alert"
          className="z-40 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-900 flex flex-wrap items-center justify-between gap-2 text-xs font-medium shrink-0"
        >
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-200 text-amber-900 font-bold">
              🎤
            </span>
            <span>{micError}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="retry-mic-permission-btn"
              onClick={async () => {
                const res = await ensureMicrophonePermission();
                if (res.granted) {
                  if (role === 'student' && !hasStudentMicGrant && !hasRaisedHand) {
                    raiseHand();
                  } else if (role === 'teacher' || hasStudentMicGrant) {
                    await handleToggleLocalMic();
                  }
                }
              }}
              className="px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold transition-colors"
            >
              Grant Mic Permission
            </button>
            <button
              type="button"
              data-testid="dismiss-mic-error-btn"
              onClick={clearMicError}
              className="px-2 py-1 rounded-lg text-amber-700 hover:bg-amber-100 font-semibold transition-colors"
              aria-label="Dismiss microphone error"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {audioPlaybackBlocked && (
        <div
          data-testid="audio-autoplay-unlock-banner"
          className="z-40 px-4 py-2 bg-sky-50 border-b border-sky-200 text-sky-900 flex flex-wrap items-center justify-between gap-2 text-xs font-medium shrink-0"
        >
          <div className="flex items-center gap-2">
            <span>🔊</span>
            <span>
              Your browser paused live audio playback. Tap once to hear the teacher and classroom voice.
            </span>
          </div>
          <button
            type="button"
            data-testid="unlock-audio-playback-btn"
            onClick={() => unlockAudioPlayback()}
            className="px-3 py-1 rounded-lg bg-[#12a3ff] hover:bg-[#0d8de0] text-white font-semibold shadow-2xs transition-colors"
          >
            Tap to Enable Audio
          </button>
        </div>
      )}

      {/* 1c. Resumable Session Recording & Offline Chunk Queue Banner (Instructor Rejoin / Network Recovery) */}
      {role === 'teacher' &&
        isHostTeacher &&
        ((!isRecording && hasResumableRecording) || offlineQueuedChunksCount > 0) && (
          <div
            data-testid="resume-recording-banner"
            className="z-40 px-4 py-2 bg-indigo-50 border-b border-indigo-200 text-indigo-950 flex flex-wrap items-center justify-between gap-2 text-xs font-medium shrink-0"
          >
            <div className="flex items-center gap-2">
              <span className="inline-flex h-2.5 w-2.5 rounded-full bg-indigo-600 animate-pulse" />
              <span>
                {!isRecording && hasResumableRecording
                  ? `Session recording is already in progress (${Math.floor(
                      resumableDurationSec / 60
                    )
                      .toString()
                      .padStart(2, '0')}:${(resumableDurationSec % 60)
                      .toString()
                      .padStart(2, '0')} recorded). Resume to continue the same video without restarting.`
                  : `${offlineQueuedChunksCount} video chunk(s) buffered during network drop. Auto-syncing on reconnect...`}
              </span>
            </div>
            {!isRecording && hasResumableRecording && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="resume-recording-btn"
                  onClick={() => {
                    resumeRecording('display_media').catch(() => {});
                  }}
                  className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold shadow-2xs transition-colors"
                >
                  Resume Recording
                </button>
                <button
                  type="button"
                  data-testid="start-fresh-recording-btn"
                  onClick={() => openRecordingSetupModal('restart')}
                  className="px-2.5 py-1 rounded-lg border border-indigo-300 bg-white hover:bg-indigo-100 text-indigo-800 font-semibold transition-colors"
                >
                  Start Fresh
                </button>
              </div>
            )}
          </div>
        )}

      {/* 2. Main Studio Workspace (Collapsible 260px Sidebar + 90%+ Canvas/Content Area) */}
      <div className="flex flex-1 min-h-0 w-full overflow-hidden relative">
        <ChapterLessonSidebar
          chapters={normalizedChapters}
          activeChapterId={activeChapterId}
          activeLessonId={activeLessonId}
          activeTopicId={activeTopicId}
          role={role}
          isCollapsed={isSidebarCollapsed}
          isTopNavVisible={isTopNavVisible}
          teachingMode={teachingMode}
          lessonModesMap={lessonModesMap}
          onToggleTeachingMode={handleToggleTeachingMode}
          onCloseMobile={() => setIsSidebarCollapsed(true)}
          onSelectTopic={handleNavigateCurriculumTopic}
        />

        <main
          data-testid="classroom-stage-main"
          className="flex-1 h-full min-w-0 flex flex-col overflow-hidden relative bg-white"
        >
          {activeMode === 'whiteboard' ? (
            /* Live Infinite Whiteboard Mode (Official @excalidraw/excalidraw in Light Theme) */
            <ExcalidrawStage
              key={`live-whiteboard-${role}-${currentUserId}`}
              role={role}
              currentUserId={currentUserId}
              isHostTeacher={isHostTeacher}
              isRoughPad={false}
              canEditWhiteboard={canEditWhiteboard}
              elements={incomingWhiteboardDelta}
              files={whiteboardFiles}
              camera={cameraState}
              whiteboardCursor={cursorState}
              followTeacher={followTeacher}
              onToggleFollow={setFollowTeacher}
              studentZoomMultiplier={studentZoomMultiplier}
              onChangeZoomMultiplier={setStudentZoomMultiplier}
              onElementsDiff={(changed) => broadcastWhiteboardDelta(changed)}
              onFilesDiff={(newFiles) => broadcastWhiteboardFiles(newFiles)}
              onClearBoard={() => broadcastWhiteboardClear()}
              onCameraUpdate={(cam) =>
                broadcastTeacherCam({
                  Cx: cam.centerX,
                  Cy: cam.centerY,
                  Zt: cam.zoom,
                  Wt: cam.viewportWidth,
                  Ht: cam.viewportHeight,
                })
              }
              onCursorMove={(cur) =>
                broadcastWhiteboardCursor({
                  Lx: cur.x,
                  Ly: cur.y,
                  tool: cur.tool || 'pointer',
                  button: cur.button || 'up',
                  active: cur.active,
                })
              }
            />
          ) : (
            /* Content Mode (800px Virtual Page with Formula A Scaling & Block-ID Anchoring) */
            <VirtualContentStage
              role={role}
              currentUserId={currentUserId}
              isHostTeacher={isHostTeacher}
              canEditContent={role === 'teacher' || canEditWhiteboard}
              lessonTitle={lessonTitle}
              topicTitle={topicTitle}
              blocks={normalizedBlocks}
              contentState={{
                chapterId: activeChapterId,
                lessonId: activeLessonId,
                topicId: activeTopicId,
                scrollAnchor: {
                  blockId: activeBlockId,
                  offsetRatio: blockOffsetRatio,
                  authorId: scrollAuthorId,
                  updatedAt: scrollUpdatedAt,
                },
                penStrokes: penStrokes || [],
              }}
              laserPointer={{
                blockId: laserPointer?.blockId,
                x: laserPointer?.x || 0,
                y: laserPointer?.y || 0,
                active: Boolean(laserPointer?.active),
                isDragging: Boolean(laserPointer?.isDragging),
                tool: laserPointer?.tool || 'cursor',
                sheetXPct: laserPointer?.sheetXPct,
                sheetYPct: laserPointer?.sheetYPct,
                sheetYPx: laserPointer?.sheetYPx,
                tokenId: laserPointer?.tokenId,
                rx: laserPointer?.rx,
                ry: laserPointer?.ry,
                regionId: laserPointer?.regionId,
                regionRx: laserPointer?.regionRx,
                regionRy: laserPointer?.regionRy,
                authorId: laserPointer?.authorId,
                authorName: laserPointer?.authorName,
                updatedAt: laserPointer?.updatedAt,
              }}
              isToolboxVisible={isContentToolboxVisible}
              followTeacher={followTeacher}
              onToggleFollow={setFollowTeacher}
              onScrollSync={broadcastScrollSync}
              onAddStroke={(stroke) => broadcastStroke(stroke)}
              onDeleteStroke={(strokeId) =>
                broadcastDeleteStroke(activeLessonId, strokeId)
              }
              onClearStrokes={() => broadcastClearStrokes(activeLessonId)}
              onLaserMove={broadcastLaser}
              onSendBlockToWhiteboard={(block) => {
                setIsSidebarCollapsed(true);
                sendContentBlockToWhiteboard(block);
              }}
            />
          )}
        </main>
      </div>

      {/* 3. Single-Device Enforcement Modal (Shown when Student attempts to join from a 2nd device without Host permission) */}
      {multiDeviceBlocked && (
        <div
          data-testid="multi-device-blocked-modal"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/75 backdrop-blur-sm"
        >
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-2xl p-6 text-center space-y-4">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-amber-50 border border-amber-200 text-amber-600 flex items-center justify-center text-xl font-bold">
              🔒
            </div>
            <h2
              data-testid="multi-device-blocked-heading"
              className="text-lg font-bold text-slate-900"
            >
              Active on Another Device
            </h2>
            <p
              data-testid="multi-device-blocked-description"
              className="text-xs sm:text-sm text-slate-600 leading-relaxed"
            >
              {multiDeviceBlocked.message}
            </p>
            <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-2">
              <button
                type="button"
                data-testid="retry-multi-device-join-btn"
                onClick={retryJoinRoom}
                className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-[#12a3ff] hover:bg-[#0d8de0] text-white text-xs sm:text-sm font-semibold shadow-sm transition-colors"
              >
                Retry Join
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. Intentional Leave / Broadcast Ended Fullscreen Overlay */}
      {(hasLeftSession || teacherStatus === 'ENDED') && (
        <div
          data-testid={
            teacherStatus === 'ENDED' ? 'session-ended-screen' : 'session-left-screen'
          }
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/75 backdrop-blur-sm"
        >
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-2xl p-6 text-center space-y-4">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center text-xl font-bold">
              {teacherStatus === 'ENDED' ? '⏹' : '👋'}
            </div>
            <h2
              data-testid="session-exit-heading"
              className="text-lg font-bold text-slate-900"
            >
              {teacherStatus === 'ENDED'
                ? 'Class Broadcast Has Ended'
                : 'You Left the Meeting'}
            </h2>
            <p
              data-testid="session-exit-description"
              className="text-xs sm:text-sm text-slate-600 leading-relaxed"
            >
              {teacherStatus === 'ENDED'
                ? sessionEndedInfo?.message ||
                  `The live class has been ended by ${
                    sessionEndedInfo?.endedBy || 'the teacher'
                  }. All participants have been disconnected from the broadcast.`
                : 'You have left the live classroom session. Your attendance and session progress have been saved.'}
            </p>
            <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-2">
              <button
                type="button"
                data-testid="rejoin-session-btn"
                onClick={() => {
                  if (token) {
                    sessionStorage.setItem('broadcast_rejoin_token', token);
                  }
                  const queryParams = new URLSearchParams({
                    sessionId,
                    role,
                    ...(studentId ? { studentId } : {}),
                    ...(teacherId ? { teacherId } : {}),
                    ...(teacherStatus === 'ENDED' ? { ended: 'true' } : { left: 'true' }),
                  });
                  window.location.href = `/rejoin?${queryParams.toString()}`;
                }}
                className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-[#12a3ff] hover:bg-[#0d8de0] text-white text-xs sm:text-sm font-semibold shadow-sm transition-colors"
              >
                Go to Rejoin Page
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. Meeting-Style Auto-Reconnect & 5-Min Teacher Grace Period Modal */}
      <ReconnectModal
        isDisconnected={
          !hasLeftSession &&
          teacherStatus !== 'ENDED' &&
          (!isConnected || isReconnecting)
        }
        teacherDisconnected={{
          active:
            !hasLeftSession &&
            teacherStatus === 'TEACHER_RECONNECTING',
          gracePeriodSeconds: 300,
          message:
            'The teacher experienced a temporary network drop. The classroom state is preserved in Redis and waiting for the teacher to rejoin (5-minute grace window)...',
        }}
        lastSeqId={seqId}
        onManualReconnect={() => {
          manualReconnect();
          void recoverAudioStageRef.current();
        }}
      />

      {/* 5. Pre-Start / Restart Session Recording Course & Intro Details Modal */}
      {isRecordingModalOpen && role === 'teacher' && isHostTeacher && (
        <div
          data-testid="start-recording-modal"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/75 backdrop-blur-sm"
        >
          <div className="w-full max-w-lg rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden">
            <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold">
                  {recordingModalMode === 'restart'
                    ? 'Restart Session Recording Details'
                    : 'Start Session Recording Details'}
                </h2>
                <p className="text-xs text-slate-300 mt-0.5">
                  Review or edit course details shown on the starting video card. Switching lessons or chapters mid-session will keep recording in one continuous video.
                </p>
              </div>
              <button
                type="button"
                data-testid="close-start-recording-modal-btn"
                onClick={() => setIsRecordingModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
                aria-label="Close recording setup modal"
              >
                ✕
              </button>
            </div>

            <div className="p-6 space-y-3.5 max-h-[75vh] overflow-y-auto text-xs sm:text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Course Title *
                  </label>
                  <input
                    type="text"
                    data-testid="recording-modal-course-input"
                    value={recordingModalForm.courseTitle}
                    onChange={(e) =>
                      setRecordingModalForm((prev) => ({
                        ...prev,
                        courseTitle: e.target.value,
                      }))
                    }
                    placeholder="Enter course title"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#12a3ff]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Subject Name
                  </label>
                  <input
                    type="text"
                    data-testid="recording-modal-subject-input"
                    value={recordingModalForm.subjectName}
                    onChange={(e) =>
                      setRecordingModalForm((prev) => ({
                        ...prev,
                        subjectName: e.target.value,
                      }))
                    }
                    placeholder="Enter subject name"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#12a3ff]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Batch / Classroom Name
                  </label>
                  <input
                    type="text"
                    data-testid="recording-modal-batch-input"
                    value={recordingModalForm.batchName}
                    onChange={(e) =>
                      setRecordingModalForm((prev) => ({
                        ...prev,
                        batchName: e.target.value,
                      }))
                    }
                    placeholder="Enter batch name"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#12a3ff]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Instructor Name *
                  </label>
                  <input
                    type="text"
                    data-testid="recording-modal-teacher-input"
                    value={recordingModalForm.teacherName}
                    onChange={(e) =>
                      setRecordingModalForm((prev) => ({
                        ...prev,
                        teacherName: e.target.value,
                      }))
                    }
                    placeholder="Enter instructor name"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#12a3ff]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Starting Chapter *
                  </label>
                  <input
                    type="text"
                    data-testid="recording-modal-chapter-input"
                    value={recordingModalForm.chapterTitle}
                    onChange={(e) =>
                      setRecordingModalForm((prev) => ({
                        ...prev,
                        chapterTitle: e.target.value,
                      }))
                    }
                    placeholder="Enter chapter title"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#12a3ff]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Starting Lesson *
                  </label>
                  <input
                    type="text"
                    data-testid="recording-modal-lesson-input"
                    value={recordingModalForm.lessonTitle}
                    onChange={(e) =>
                      setRecordingModalForm((prev) => ({
                        ...prev,
                        lessonTitle: e.target.value,
                      }))
                    }
                    placeholder="Enter lesson title"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#12a3ff]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-1">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Topic Title
                  </label>
                  <input
                    type="text"
                    data-testid="recording-modal-topic-input"
                    value={recordingModalForm.topicTitle}
                    onChange={(e) =>
                      setRecordingModalForm((prev) => ({
                        ...prev,
                        topicTitle: e.target.value,
                      }))
                    }
                    placeholder="Topic title"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#12a3ff]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Academic Year
                  </label>
                  <input
                    type="number"
                    data-testid="recording-modal-year-input"
                    value={recordingModalForm.academicYear}
                    onChange={(e) =>
                      setRecordingModalForm((prev) => ({
                        ...prev,
                        academicYear: e.target.value,
                      }))
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#12a3ff]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    VOD Version
                  </label>
                  <input
                    type="number"
                    min={1}
                    data-testid="recording-modal-version-input"
                    value={recordingModalForm.version}
                    onChange={(e) =>
                      setRecordingModalForm((prev) => ({
                        ...prev,
                        version: e.target.value,
                      }))
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#12a3ff]"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2.5 p-3 rounded-xl bg-slate-50 border border-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="recording-modal-voice-checkbox"
                  checked={recordingModalForm.recordVoice}
                  onChange={(e) =>
                    setRecordingModalForm((prev) => ({
                      ...prev,
                      recordVoice: e.target.checked,
                    }))
                  }
                  className="w-4 h-4 rounded border-slate-300 text-[#12a3ff] focus:ring-[#12a3ff]"
                />
                <span className="text-xs font-semibold text-slate-800">
                  Record Instructor Microphone &amp; Classroom Two-Way Voice Audio (48 kbps Opus)
                </span>
              </label>
            </div>

            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2.5">
              <button
                type="button"
                data-testid="cancel-start-recording-btn"
                onClick={() => setIsRecordingModalOpen(false)}
                className="px-4 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 text-xs sm:text-sm font-semibold transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="confirm-start-recording-btn"
                onClick={() => {
                  if (!recordingModalForm.courseTitle && !recordingModalForm.lessonTitle) {
                    if (recordingModalMode === 'restart') {
                      restartRecording('display_media').catch(() => {});
                    } else {
                      startRecording('display_media').catch(() => {});
                    }
                    setIsRecordingModalOpen(false);
                    return;
                  }
                  handleConfirmRecordingModal().catch(() => {});
                }}
                className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs sm:text-sm font-bold shadow-sm transition-colors"
              >
                {recordingModalMode === 'restart'
                  ? 'Confirm & Restart Recording'
                  : 'Confirm & Start Recording'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
