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

const DEFAULT_BATCHES: BatchOption[] = [
  {
    sessionId: 'batch_physics_101',
    batchId: 'batch_phys_10_a',
    name: 'Class 10 Physics — Batch A (Live)',
    subject: 'Physics',
    teacherName: 'Dr. H.C. Verma',
  },
  {
    sessionId: 'batch_chemistry_102',
    batchId: 'batch_chem_10_b',
    name: 'Class 10 Chemistry — Batch B',
    subject: 'Chemistry',
    teacherName: 'Prof. R.K. Sharma',
  },
];

export default function LearningSessionLayout() {
  // Synchronously read URL parameters on initial client render so a Student or Co-Teacher tab
  // never momentarily connects to the socket as Host Teacher on first mount.
  const initialParams = useMemo(() => {
    if (typeof window === 'undefined') {
      return {
        role: 'teacher' as 'teacher' | 'student',
        teacherId: 'teacher_501',
        studentId: '101',
        sessionId: 'batch_physics_101',
        token: 'DEV_TOKEN_TEACHER_501',
        isMobileViewport: false,
        branchId: 4,
        batchId: 105,
        boardId: 2,
        languageId: 1,
        courseId: 12,
        linkedVodCourseId: 212,
        subjectId: 1,
        academicYear: 2026,
        version: 1,
      };
    }
    const urlParams = new URLSearchParams(window.location.search);
    const urlRole = urlParams.get('role') === 'student' ? 'student' : 'teacher';
    const isCohostParam =
      urlParams.get('cohost') === '1' || urlParams.get('cohost') === 'true';
    const rawTeacherId =
      urlParams.get('teacherId') || (isCohostParam ? 'teacher_502' : 'teacher_501');
    const normTeacherId = rawTeacherId.startsWith('teacher_')
      ? rawTeacherId
      : `teacher_${rawTeacherId}`;
    const rawStId = urlParams.get('studentId') || '101';
    const stId = rawStId.replace(/^student_/, '');
    const sessId = urlParams.get('sessionId') || 'batch_physics_101';
    const teacherTokenMap: Record<string, string> = {
      teacher_501: 'DEV_TOKEN_TEACHER_501',
      teacher_502: 'DEV_TOKEN_TEACHER_502',
      teacher_503: 'DEV_TOKEN_TEACHER_503',
      teacher_504: 'DEV_TOKEN_TEACHER_504',
    };
    const isTokenMatchingSession = (
      jwtOrToken: string | null,
      targetSessionId: string
    ): boolean => {
      if (!jwtOrToken || jwtOrToken === 'undefined' || jwtOrToken === 'null') {
        return false;
      }
      const trimmed = jwtOrToken.trim();
      if (!trimmed) return false;
      const parts = trimmed.split('.');
      if (parts.length === 3) {
        try {
          const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
          const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
          const payload = JSON.parse(window.atob(padded));
          if (payload.exp && Math.floor(Date.now() / 1000) >= Number(payload.exp)) {
            return false;
          }
          if (
            payload.sessionId &&
            payload.sessionId !== '*' &&
            payload.sessionId !== targetSessionId
          ) {
            return false;
          }
        } catch {
          return false;
        }
      }
      return true;
    };

    const rawUrlToken = urlParams.get('token');
    const urlToken = isTokenMatchingSession(rawUrlToken, sessId)
      ? rawUrlToken!.trim()
      : '';
    if (urlToken) {
      window.sessionStorage.setItem('broadcast_rejoin_token', urlToken);
      window.sessionStorage.setItem('broadcast_rejoin_session_id', sessId);
    }
    const rawStoredToken = window.sessionStorage.getItem('broadcast_rejoin_token');
    const storedSessionId = window.sessionStorage.getItem('broadcast_rejoin_session_id');
    const storedToken =
      (!storedSessionId || storedSessionId === sessId) &&
      isTokenMatchingSession(rawStoredToken, sessId)
        ? rawStoredToken!.trim()
        : '';
    if (rawStoredToken && !storedToken) {
      window.sessionStorage.removeItem('broadcast_rejoin_token');
      window.sessionStorage.removeItem('broadcast_rejoin_session_id');
    }
    const cleanTeacherSuffix = normTeacherId.replace(/^teacher_/, '') || '501';
    const tok =
      urlToken ||
      storedToken ||
      (urlRole === 'student'
        ? `DEV_TOKEN_STUDENT_${stId}`
        : teacherTokenMap[normTeacherId] || `DEV_TOKEN_TEACHER_${cleanTeacherSuffix}`);
    return {
      role: urlRole as 'teacher' | 'student',
      teacherId: normTeacherId,
      studentId: stId,
      sessionId: sessId,
      token: tok,
      isMobileViewport: window.innerWidth < 768,
      branchId: Number(urlParams.get('branchId')) || 4,
      batchId: Number(urlParams.get('batchId')) || 105,
      boardId: urlParams.get('boardId') ? Number(urlParams.get('boardId')) : 2,
      languageId: Number(urlParams.get('languageId')) || 1,
      courseId: Number(urlParams.get('courseId')) || 12,
      linkedVodCourseId: Number(urlParams.get('linkedVodCourseId')) || 212,
      subjectId: Number(urlParams.get('subjectId')) || 1,
      academicYear: Number(urlParams.get('academicYear')) || 2026,
      version: Number(urlParams.get('version')) || 1,
    };
  }, []);

  // User Identity & Session State
  const [role, setRole] = useState<'teacher' | 'student'>(initialParams.role);
  const [teacherId, setTeacherId] = useState<string>(initialParams.teacherId);
  const [studentId, setStudentId] = useState<string>(initialParams.studentId);
  const [sessionId, setSessionId] = useState<string>(initialParams.sessionId);
  const [token, setToken] = useState<string>(initialParams.token);

  // Session & Curriculum Data
  const [sessionMetadata, setSessionMetadata] = useState<any>(null);
  const [curriculum, setCurriculum] = useState<any>(null);
  const [lessonContent, setLessonContent] = useState<any>(null);
  const [livekitToken, setLivekitToken] = useState<string>('');
  const [livekitUrl, setLivekitUrl] = useState<string | undefined>(undefined);
  const [canPublishAudio, setCanPublishAudio] = useState<boolean>(false);
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
    activeTopicId,
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
  });

  // Prevent phone/tablet/desktop screen from turning off during an active live broadcast
  useScreenWakeLock({
    enabled: !hasLeftSession && teacherStatus !== 'ENDED' && !multiDeviceBlocked,
  });

  // Load Initial Session Snapshot, Curriculum Tree, Lesson Blocks & Attendance
  useEffect(() => {
    let isMounted = true;

    const loadSessionData = async () => {
      try {
        const initData = await CurriculumClient.initSession({
          sessionId,
          role,
          teacherId,
          studentId,
          token,
          deviceId: clientDeviceId,
        });

        if (!isMounted) return;

        setSessionMetadata(initData.sessionContext);
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

        const courseId = initData.sessionContext?.courseId || 'course_phys_class10';
        const curData = await CurriculumClient.fetchCurriculum(courseId);
        if (isMounted) setCurriculum(curData);

        const currentLesId = initData.sessionContext?.lessonId || 'les_ohms_law';
        const contentData = await CurriculumClient.fetchLessonContent(currentLesId);
        if (isMounted) setLessonContent(contentData);
      } catch (err: any) {
        console.error('[LearningSessionLayout] Init error:', err.message);
        if (
          isMounted &&
          token &&
          !token.startsWith('DEV_TOKEN_') &&
          typeof window !== 'undefined'
        ) {
          window.sessionStorage.removeItem('broadcast_rejoin_token');
          window.sessionStorage.removeItem('broadcast_rejoin_session_id');
          const cleanTId = String(teacherId || '501').replace(/^teacher_/, '') || '501';
          const fallbackTok =
            role === 'student'
              ? `DEV_TOKEN_STUDENT_${studentId || '101'}`
              : `DEV_TOKEN_TEACHER_${cleanTId}`;
          setToken(fallbackTok);
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
    setAttendanceList,
    setTeacherMicActive,
    setInvitedTeachers,
    setWhiteboardEditors,
    setMultiDeviceStudents,
    clientDeviceId,
  ]);

  // Reload lesson content when activeLessonId changes
  useEffect(() => {
    let isMounted = true;
    if (activeLessonId) {
      CurriculumClient.fetchLessonContent(activeLessonId)
        .then((data) => {
          if (isMounted && data) setLessonContent(data);
        })
        .catch((err) => console.error('[Content] Error loading lesson content:', err));
    }
    return () => {
      isMounted = false;
    };
  }, [activeLessonId]);

  // Compute current user ID, Host/Co-Teacher status, Whiteboard edit permission & Mic permissions
  const currentUserId = role === 'teacher' ? teacherId : `student_${studentId}`;
  const isCoHostTeacher = useMemo(() => {
    if (role !== 'teacher') return false;
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('cohost') === '1' || params.get('cohost') === 'true') {
        return true;
      }
    }
    if (['teacher_502', 'teacher_503', 'teacher_504'].includes(teacherId)) {
      return true;
    }
    const cleanCurrentId = String(teacherId).replace(/^teacher_/, '');
    const cleanSessionOwnerId = sessionMetadata?.teacherId
      ? String(sessionMetadata.teacherId).replace(/^teacher_/, '')
      : null;
    if (
      invitedTeachers.some(
        (t) =>
          t.teacherId === teacherId ||
          String(t.teacherId).replace(/^teacher_/, '') === cleanCurrentId
      ) &&
      cleanSessionOwnerId !== cleanCurrentId
    ) {
      return true;
    }
    return false;
  }, [role, teacherId, invitedTeachers, sessionMetadata]);

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
  } = useLiveKitStage({
    livekitUrl,
    token: livekitToken,
    canPublishAudio: hasStudentMicGrant,
    autoActivateMic: pendingMicAutoActivate,
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
        if (allowStudentUnmute && !canPublishAudio) {
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
    canPublishAudio,
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
      chapterId: ch.chapterId,
      title: ch.title,
      lessons: (ch.lessons || []).map((les: any) => ({
        lessonId: les.lessonId,
        title: les.title,
        duration:
          les.duration ||
          `${(les.topics || []).reduce(
            (acc: number, t: any) => acc + (t.durationMinutes || 15),
            0
          )}m`,
        topics: (les.topics || []).map((top: any) => ({
          topicId: top.topicId,
          title: top.title,
        })),
      })),
    }));
  }, [curriculum]);

  // Determine current Chapter, Lesson, and Topic titles for the Top Header Breadcrumb
  const { activeChapterId, chapterTitle, lessonTitle, topicTitle } = useMemo(() => {
    let chapId = sessionMetadata?.chapterId || 'chap_electricity';
    let chapTitle = sessionMetadata?.chapterTitle || 'Chapter 1: Electricity';
    let lesTitle =
      lessonContent?.lessonTitle ||
      sessionMetadata?.lessonTitle ||
      "Ohm's Law & Resistance";
    let topTitle = sessionMetadata?.topicTitle || "Ohm's Law & Circuit Analysis";

    for (const ch of normalizedChapters) {
      for (const les of ch.lessons) {
        if (les.lessonId === activeLessonId) {
          chapId = ch.chapterId;
          chapTitle = ch.title;
          lesTitle = les.title;
          const matchedTopic = les.topics.find((t) => t.topicId === activeTopicId);
          if (matchedTopic) {
            topTitle = matchedTopic.title;
          } else if (les.topics[0]) {
            topTitle = les.topics[0].title;
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
  }, [normalizedChapters, activeLessonId, activeTopicId, sessionMetadata, lessonContent]);

  // Normalize Lesson Blocks for VirtualContentStage (800px Virtual Page)
  const normalizedBlocks: LessonBlock[] = useMemo(() => {
    const rawBlocks = lessonContent?.blocks || [];
    return rawBlocks.map((b: any) => ({
      blockId: b.blockId,
      type:
        b.type === 'callout'
          ? 'problem'
          : b.type === 'paragraph'
          ? 'concept'
          : b.type || 'concept',
      title: b.title,
      content: b.content || '',
      formulaLatex: b.formulaLatex,
      svgDiagram: b.svgDiagram,
    }));
  }, [lessonContent]);

  // Map Socket Mode to Top Header ActiveMode (Student Rough Pad removed)
  const activeMode: ActiveMode = mode === 'WHITEBOARD' ? 'whiteboard' : 'content';
  const isWhiteboardView = activeMode === 'whiteboard';

  // Build Relational Hierarchy Context for 720p VOD & Gzip Whiteboard storage
  const relationalContext: RelationalLessonContext = useMemo(
    () => ({
      sessionId,
      contextType: 'course_lesson',
      branchId: initialParams.branchId,
      batchId: initialParams.batchId,
      boardId: initialParams.boardId,
      languageId: initialParams.languageId,
      courseId: initialParams.courseId,
      linkedVodCourseId: initialParams.linkedVodCourseId,
      subjectId: initialParams.subjectId,
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
      initialParams,
      activeChapterId,
      chapterTitle,
      activeLessonId,
      lessonTitle,
      activeTopicId,
      teacherId,
      teachingMode,
    ]
  );

  // Browser-Side 720p Hardware Encoder & Jittered Chunk Uploader Hook
  const {
    isRecording,
    recordingDurationSec,
    chunksUploaded,
    startRecording,
    stopAndFinalizeRecording,
    getCurrentVideoOffsetSec,
  } = useCompressedClassRecorder({
    sessionId,
    role,
    isHostTeacher,
    token,
    relationalContext,
    activeMode,
    teachingMode,
    chapterTitle,
    lessonTitle,
    topicTitle,
    isLocalMicOn: isMicrophoneEnabled,
    getWhiteboardSnapshot: () => ({
      elements: incomingWhiteboardDelta || [],
      appState: { viewBackgroundColor: '#ffffff' },
      files: whiteboardFiles || {},
    }),
  });

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
        const resolvedId = s.studentId || s.userId || 'student_101';
        const resolvedName =
          s.studentName ||
          s.name ||
          s.userName ||
          `Student #${String(resolvedId).replace(/^student_/, '')}`;
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
    [attendanceList]
  );

  // Map Audio Stage State for TopModeNavbar & Joined Students Drawer
  const audioStageState: AudioStageState = useMemo(() => {
    const nameMap = new Map<string, string>();
    for (const s of normalizedAttendanceList) {
      nameMap.set(s.studentId, s.studentName);
    }

    return {
      teacherMicActive:
        role === 'teacher' && isHostTeacher ? isMicrophoneEnabled : teacherMicActive,
      maxAllowedStudentMics: sessionMetadata?.maxStudentMics || 10,
      activeStudentMics: activeStudentMics.map((id) => ({
        studentId: id,
        studentName:
          nameMap.get(id) ||
          `Student #${id.replace(/^student_/, '')}`,
        grantedAt: Date.now(),
      })),
      raisedHands: raisedHands.map((h: any) => ({
        studentId: h.userId || h.studentId,
        studentName: h.name || h.userName || h.studentName || `Student #${h.userId}`,
        raisedAt: h.raisedAt || Date.now(),
      })),
      invitedTeachers,
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

  // Auto-start 720p Continuous Session Recording for Host Teacher when connected
  const autoStartedRecorderRef = useRef<boolean>(false);
  useEffect(() => {
    if (
      role === 'teacher' &&
      isHostTeacher &&
      isConnected &&
      teacherStatus === 'LIVE' &&
      !hasLeftSession &&
      !autoStartedRecorderRef.current
    ) {
      autoStartedRecorderRef.current = true;
      startRecording('workspace_canvas').catch(() => {});
    }
  }, [role, isHostTeacher, isConnected, teacherStatus, hasLeftSession, startRecording]);

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

  // Role & Session Switch Handlers
  const handleSwitchRole = (newRole: 'teacher' | 'student', nextTeacherId?: string) => {
    setRole(newRole);
    setFollowTeacher(true);
    setStudentZoomMultiplier(1.0);
    if (newRole === 'teacher') {
      const resolvedTId = (nextTeacherId || '501').replace(/^teacher_/, '');
      setTeacherId(`teacher_${resolvedTId}`);
      setToken(`DEV_TOKEN_TEACHER_${resolvedTId}`);
      const query =
        resolvedTId === '501'
          ? `?role=teacher&sessionId=${sessionId}`
          : `?role=teacher&teacherId=${resolvedTId}&sessionId=${sessionId}`;
      window.history.replaceState(null, '', query);
    } else {
      const stId = studentId || '101';
      setStudentId(stId);
      setToken(`DEV_TOKEN_STUDENT_${stId}`);
      window.history.replaceState(
        null,
        '',
        `?role=student&studentId=${stId}&sessionId=${sessionId}`
      );
    }
  };

  const handleSelectBatch = (newSessionId: string) => {
    setSessionId(newSessionId);
    window.history.replaceState(
      null,
      '',
      role === 'teacher'
        ? teacherId !== '501'
          ? `?role=teacher&teacherId=${teacherId}&sessionId=${newSessionId}`
          : `?role=teacher&sessionId=${newSessionId}`
        : `?role=student&studentId=${studentId}&sessionId=${newSessionId}`
    );
  };

  const currentTeacherDisplayName = useMemo(() => {
    if (teacherId === '502' || teacherId === 'teacher_502') return 'Prof. R.K. Verma';
    if (teacherId === '503' || teacherId === 'teacher_503') return 'Dr. Neha Kulkarni';
    if (teacherId === '504' || teacherId === 'teacher_504') return 'Prof. S.K. Iyer';
    return sessionMetadata?.teacherName || 'Dr. H.C. Verma';
  }, [teacherId, sessionMetadata]);

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
      }
      const queryParams = new URLSearchParams({
        sessionId,
        role,
        studentId: studentId || '101',
        teacherId: teacherId || 'teacher_501',
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
    }
    // Redirect to room-based Rejoin Page
    const queryParams = new URLSearchParams({
      sessionId,
      role,
      studentId: studentId || '101',
      teacherId: teacherId || 'teacher_501',
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

    // Flush final 720p video chunk, save active taught lesson's Whiteboard JSON, and finalize session BEFORE ending room & redirecting
    try {
      await Promise.race([
        stopAndFinalizeRecording(),
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]);
    } catch {
      // Ignore finalization error during teardown
    }

    endSession();

    if (token) {
      sessionStorage.setItem('broadcast_rejoin_token', token);
    }
    // Redirect host/cohost to room-based Rejoin Page with ended=true
    const queryParams = new URLSearchParams({
      sessionId,
      role,
      studentId: studentId || '101',
      teacherId: teacherId || 'teacher_501',
      ended: 'true',
    });
    setTimeout(() => {
      window.location.href = `/rejoin?${queryParams.toString()}`;
    }, 200);
  }, [
    isMicrophoneEnabled,
    toggleMicrophone,
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
      if (initData.livekit) {
        setLivekitToken(initData.livekit.token);
        setCanPublishAudio(initData.livekit.canPublishAudio);
      }
    } catch {
      // Ignore init error on rejoin
    }
  }, [rejoinSession, sessionId, role, teacherId, studentId, token, clientDeviceId]);

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
        userName={
          role === 'teacher'
            ? currentTeacherDisplayName
            : `Aarav Sharma (#${studentId})`
        }
        teacherName={sessionMetadata?.teacherName || 'Dr. H.C. Verma'}
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
        batches={DEFAULT_BATCHES}
        selectedSessionId={sessionId}
        isTopNavVisible={isTopNavVisible}
        isFullscreen={isFullscreen}
        isContentToolboxVisible={isContentToolboxVisible}
        teachingMode={teachingMode}
        onToggleTeachingMode={handleToggleTeachingMode}
        isRecording={isRecording}
        recordingDurationSec={recordingDurationSec}
        chunksUploaded={chunksUploaded}
        onToggleRecording={() => {
          if (!isRecording) {
            startRecording('workspace_canvas').catch(() => {});
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
                    studentId: studentId || '101',
                    teacherId: teacherId || 'teacher_501',
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
        onManualReconnect={manualReconnect}
      />
    </div>
  );
}
