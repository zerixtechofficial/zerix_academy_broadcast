'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
// @ts-ignore - socket.io-msgpack-parser ships an empty index.d.ts on npm
import msgpackParser from '@socket.io/msgpack-parser';
import { getApiBaseUrl } from '../services/curriculumClient';
import { ContentRegionId } from '../utils/contentSyncMath';

/**
 * Rounds cursor and stroke coordinates to 1 decimal place before emitting over WebSocket.
 */
export const roundCoord1dp = (val: number): number =>
  typeof val === 'number' && Number.isFinite(val) ? Math.round(val * 10) / 10 : 0;

export type ActiveMode = 'content' | 'whiteboard';

export interface ExcalidrawElementState {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  roughness?: number;
  opacity?: number;
  groupIds?: string[];
  frameId?: string | null;
  roundness?: any;
  seed?: number;
  version: number;
  versionNonce?: number;
  index?: string | null;
  isDeleted?: boolean;
  boundElements?: any;
  updated?: number;
  link?: string | null;
  locked?: boolean;
  points?: number[][];
  pressures?: number[];
  simulatePressure?: boolean;
  lastCommittedPoint?: number[] | null;
  startBinding?: any;
  endBinding?: any;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  elbowed?: boolean;
  fixedSegments?: any;
  startIsSpecial?: boolean | null;
  endIsSpecial?: boolean | null;
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  originalText?: string;
  lineHeight?: number;
  containerId?: string | null;
  autoResize?: boolean;
  fileId?: string | null;
  status?: 'pending' | 'saved' | 'error';
  scale?: [number, number];
  crop?: any;
  name?: string | null;
  customData?: Record<string, any>;
}

export interface WhiteboardCameraState {
  centerX: number;
  centerY: number;
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
  authorId?: string;
  authorName?: string;
  updatedAt?: number;
}

export interface WhiteboardCursorState {
  x: number;
  y: number;
  tool?: 'pointer' | 'laser';
  button?: 'up' | 'down';
  active: boolean;
  teacherName?: string;
  userId?: string;
  role?: 'teacher' | 'student';
  updatedAt?: number;
}

export interface ContentStrokePoint {
  x: number;
  y: number;
  tokenId?: string;
  rx?: number;
  ry?: number;
  regionId?: ContentRegionId;
  regionRx?: number;
  regionRy?: number;
}

export interface ContentStroke {
  id: string;
  blockId: string;
  color: string;
  width: number;
  tool?: 'pen' | 'highlighter';
  opacity?: number;
  points: ContentStrokePoint[];
  anchorTokens?: string[];
  createdAt?: number;
  seqId?: number;
}

export interface ContentModeState {
  chapterId: string;
  lessonId: string;
  topicId: string;
  scrollAnchor: {
    blockId: string;
    offsetRatio: number;
    authorId?: string;
    updatedAt?: number;
  };
  penStrokes: ContentStroke[];
}

export interface LaserPointerState {
  blockId?: string;
  x: number;
  y: number;
  active: boolean;
  isDragging?: boolean;
  tool?: 'cursor' | 'laser' | 'pen' | 'highlighter' | 'eraser';
  sheetXPct?: number;
  sheetYPct?: number;
  sheetYPx?: number;
  tokenId?: string;
  rx?: number;
  ry?: number;
  regionId?: ContentRegionId;
  regionRx?: number;
  regionRy?: number;
  authorId?: string;
  authorName?: string;
  updatedAt?: number;
}

export interface InvitedTeacherEntry {
  teacherId: string;
  name: string;
  subject?: string;
  email?: string;
  avatar?: string;
  canUseWhiteboard: boolean;
  invitedAt: number;
  invitedBy?: string;
  isOnline?: boolean;
}

export interface AudioStageState {
  teacherMicActive: boolean;
  maxAllowedStudentMics: number;
  activeStudentMics: Array<{
    studentId: string;
    studentName: string;
    grantedAt: number;
  }>;
  raisedHands: Array<{
    studentId: string;
    studentName: string;
    raisedAt: number;
  }>;
  invitedTeachers?: InvitedTeacherEntry[];
  whiteboardEditors?: string[];
  allowStudentUnmute?: boolean;
  multiDeviceStudents?: string[];
}

const CLIENT_DEVICE_STORAGE_KEY = 'broadcast_client_device_id';

/**
 * Generates or retrieves a persistent per-device identifier so the backend can:
 * 1. Enforce single-device student join by default (unless Host allows multi-device for that student)
 * 2. Mint distinct LiveKit participant identities (`student_101__dev_xyz`) so multi-device mics work independently
 */
export function getOrCreateClientDeviceId(): string {
  if (typeof window === 'undefined') return 'dev_ssr';
  try {
    const params = new URLSearchParams(window.location.search);
    const urlDeviceId = params.get('deviceId');
    if (urlDeviceId && urlDeviceId.trim().length > 0) {
      return urlDeviceId.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    }
    const existing = window.localStorage.getItem(CLIENT_DEVICE_STORAGE_KEY);
    if (existing && existing.trim().length > 0) {
      return existing.trim();
    }
    const generated = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    window.localStorage.setItem(CLIENT_DEVICE_STORAGE_KEY, generated);
    return generated;
  } catch {
    return `dev_${Math.random().toString(36).slice(2, 10)}`;
  }
}

export interface StudentAttendanceSummary {
  studentId: string;
  studentName: string;
  totalJoinedSeconds: number;
  totalJoinedMinutes: number;
  totalJoinedHours: number;
  attendancePercentage: number;
  status: 'PRESENT' | 'PARTIAL' | 'LATE' | 'ABSENT';
  rejoinCount: number;
  isOnline: boolean;
  firstJoinedAt: number | null;
  lastSeenAt: number | null;
  leftAt: number | null;
}

export interface UseBroadcastSocketParams {
  sessionId: string;
  role: 'teacher' | 'student';
  token?: string;
  studentId?: string;
  teacherId?: string;
  deviceId?: string;
  restart?: boolean;
  onStudentTokenRefresh?: (token: string, autoActivate?: boolean) => void;
  onStudentMicRevoked?: () => void;
  onIncomingVoiceFrame?: (packet: any) => void;
  onSocketReconnected?: () => void;
}

export function useBroadcastSocket({
  sessionId,
  role,
  token,
  studentId,
  teacherId,
  deviceId: propDeviceId,
  restart,
  onStudentTokenRefresh,
  onStudentMicRevoked,
  onIncomingVoiceFrame,
  onSocketReconnected,
}: UseBroadcastSocketParams) {
  const socketRef = useRef<Socket | null>(null);
  const seqIdRef = useRef<number>(0);
  const hasConnectedOnceRef = useRef<boolean>(false);
  const restartRef = useRef<boolean>(Boolean(restart));
  useEffect(() => {
    if (restart) {
      restartRef.current = true;
    }
  }, [restart]);
  const clientDeviceIdRef = useRef<string>(propDeviceId || getOrCreateClientDeviceId());
  if (propDeviceId && clientDeviceIdRef.current !== propDeviceId) {
    clientDeviceIdRef.current = propDeviceId;
  }

  const onStudentMicRevokedRef = useRef(onStudentMicRevoked);
  useEffect(() => {
    onStudentMicRevokedRef.current = onStudentMicRevoked;
  }, [onStudentMicRevoked]);

  const onStudentTokenRefreshRef = useRef(onStudentTokenRefresh);
  useEffect(() => {
    onStudentTokenRefreshRef.current = onStudentTokenRefresh;
  }, [onStudentTokenRefresh]);

  const onIncomingVoiceFrameRef = useRef(onIncomingVoiceFrame);
  useEffect(() => {
    onIncomingVoiceFrameRef.current = onIncomingVoiceFrame;
  }, [onIncomingVoiceFrame]);

  const onSocketReconnectedRef = useRef(onSocketReconnected);
  useEffect(() => {
    onSocketReconnectedRef.current = onSocketReconnected;
  }, [onSocketReconnected]);

  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  const [mode, setModeState] = useState<'CONTENT' | 'WHITEBOARD' | 'ROUGH_PAD'>('CONTENT');
  const [teacherStatus, setTeacherStatus] = useState<'LIVE' | 'TEACHER_RECONNECTING' | 'ENDED'>('LIVE');
  const [onlineCount, setOnlineCount] = useState<number>(0);
  const [attendanceList, setAttendanceList] = useState<any[]>([]);
  const [seqId, setSeqId] = useState<number>(0);
  const [lastHeartbeat, setLastHeartbeat] = useState<number>(Date.now());

  // Whiteboard sync states
  const [teacherCam, setTeacherCam] = useState<any>({ Cx: 640, Cy: 360, Zt: 1.0, Wt: 1280, Ht: 720 });
  const [whiteboardCursor, setWhiteboardCursor] = useState<{
    Lx: number;
    Ly: number;
    tool?: 'pointer' | 'laser';
    button?: 'up' | 'down';
    active: boolean;
    teacherName?: string;
    userId?: string;
    role?: 'teacher' | 'student';
    updatedAt?: number;
  }>({ Lx: 0, Ly: 0, tool: 'pointer', button: 'up', active: false });
  const [incomingWhiteboardDelta, setIncomingWhiteboardDelta] = useState<any[]>([]);
  const [whiteboardFiles, setWhiteboardFiles] = useState<Record<string, any>>({});

  // Content sync states
  const [activeLessonId, setActiveLessonId] = useState<string>('');
  const [activeTopicId, setActiveTopicId] = useState<string>('');
  const [activeBlockId, setActiveBlockId] = useState<string>('blk_header');
  const [blockOffsetRatio, setBlockOffsetRatio] = useState<number>(0);
  const [scrollAuthorId, setScrollAuthorId] = useState<string | undefined>(undefined);
  const [scrollUpdatedAt, setScrollUpdatedAt] = useState<number>(0);
  const [penStrokes, setPenStrokes] = useState<any[]>([]);
  const [laserPointer, setLaserPointer] = useState<any>({ x: 0, y: 0, active: false });
  const localUserId =
    role === 'teacher'
      ? `teacher_${String(teacherId || '').replace(/^teacher_/, '')}`
      : `student_${String(studentId || '').replace(/^student_/, '')}`;

  // Audio Stage & Collaboration Permissions State
  // All microphones are muted by default (teacherMicActive = false)
  const [teacherMicActive, setTeacherMicActive] = useState<boolean>(false);
  const [activeStudentMics, setActiveStudentMics] = useState<string[]>([]);
  const [allowStudentUnmute, setAllowStudentUnmute] = useState<boolean>(false);
  const [raisedHands, setRaisedHands] = useState<any[]>([]);
  const [invitedTeachers, setInvitedTeachers] = useState<InvitedTeacherEntry[]>([]);
  const [whiteboardEditors, setWhiteboardEditors] = useState<string[]>([]);
  const [multiDeviceStudents, setMultiDeviceStudents] = useState<string[]>([]);
  const [multiDeviceBlocked, setMultiDeviceBlocked] = useState<{
    reason?: string;
    message: string;
    studentId?: string;
    existingDeviceIds?: string[];
  } | null>(null);
  const multiDeviceBlockedRef = useRef<boolean>(false);
  useEffect(() => {
    multiDeviceBlockedRef.current = Boolean(multiDeviceBlocked);
  }, [multiDeviceBlocked]);
  const [audioError, setAudioError] = useState<{
    message: string;
    canForceReplace?: boolean;
    studentId?: string;
  } | null>(null);
  const [hasLeftSession, setHasLeftSession] = useState<boolean>(false);
  const [sessionEndedInfo, setSessionEndedInfo] = useState<{
    endedBy?: string;
    endedByRole?: string;
    message?: string;
  } | null>(null);
  const intentionalLeaveRef = useRef<boolean>(false);

  const updateSeqId = useCallback((nextSeq: number) => {
    if (typeof nextSeq === 'number' && nextSeq > seqIdRef.current) {
      seqIdRef.current = nextSeq;
      setSeqId(nextSeq);
    }
  }, []);

  useEffect(() => {
    seqIdRef.current = 0;
    setSeqId(0);
    const validToken =
      token && token !== 'undefined' && token !== 'null' ? token.trim() : '';

    // Never connect socket without a valid classroom JWT token and sessionId
    if (!validToken || validToken.startsWith('DEV_TOKEN_') || !sessionId) {
      setIsConnected(false);
      setIsReconnecting(false);
      return;
    }

    const baseUrl = getApiBaseUrl();
    const cleanTeacherId = teacherId ? String(teacherId).replace(/^teacher_/, '') : '';
    const clientDeviceId = clientDeviceIdRef.current;

    const socket = io(baseUrl, {
      parser: msgpackParser,
      transports: ['websocket', 'polling'],
      auth: {
        token: validToken,
        role,
        studentId,
        teacherId: cleanTeacherId ? `teacher_${cleanTeacherId}` : '',
        sessionId,
        deviceId: clientDeviceId,
      },
      query: {
        sessionId,
        role,
        studentId: studentId || '',
        teacherId: cleanTeacherId ? `teacher_${cleanTeacherId}` : '',
        deviceId: clientDeviceId,
      },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      const isReconnect = hasConnectedOnceRef.current;
      hasConnectedOnceRef.current = true;
      setIsConnected(true);
      setIsReconnecting(false);
      setReconnectAttempt(0);

      // Trigger Join Room and catch-up with our highest known seqId from ref + per-device ID
      const shouldRestart = restartRef.current;
      restartRef.current = false;
      socket.emit('JOIN_ROOM', {
        sessionId,
        lastSeqId: seqIdRef.current,
        deviceId: clientDeviceId,
        ...(shouldRestart ? { restart: true } : {}),
      });

      if (isReconnect) {
        onSocketReconnectedRef.current?.();
      }
    });

    socket.on('connect_error', (err) => {
      if (intentionalLeaveRef.current) return;
      console.warn('[Socket] Connect error:', err.message);
      setIsConnected(false);
      setIsReconnecting(true);
      setReconnectAttempt((prev) => prev + 1);
    });

    socket.on('disconnect', (reason) => {
      console.warn('[Socket] Disconnected:', reason);
      setIsConnected(false);
      if (intentionalLeaveRef.current) {
        setIsReconnecting(false);
        return;
      }
      if (reason === 'io server disconnect') {
        socket.connect();
      } else {
        setIsReconnecting(true);
      }
    });

    // 1. Room Joined confirmation & Single-Device Enforcement
    socket.on('MULTI_DEVICE_BLOCKED', (data: any) => {
      setMultiDeviceBlocked({
        reason: data?.reason || 'MULTI_DEVICE_NOT_ALLOWED',
        message:
          data?.message ||
          'You are already joined from another device. Students can join from one device only unless the Host Teacher enables multi-device access for your account.',
        studentId: data?.studentId,
        existingDeviceIds: data?.existingDeviceIds,
      });
    });

    socket.on('ROOM_JOINED', (data: any) => {
      setMultiDeviceBlocked(null);
      if (data.onlineCount !== undefined) {
        setOnlineCount(data.onlineCount);
      }
      if (Array.isArray(data.students)) {
        setAttendanceList(data.students);
      }
      if (data.audioStage) {
        if (Array.isArray(data.audioStage.activeStudentMics)) {
          setActiveStudentMics(data.audioStage.activeStudentMics);
        }
        if (Array.isArray(data.audioStage.raisedHands)) {
          setRaisedHands(data.audioStage.raisedHands);
        }
        if (typeof data.audioStage.teacherMicActive === 'boolean') {
          setTeacherMicActive(data.audioStage.teacherMicActive);
        }
        if (typeof data.audioStage.allowStudentUnmute === 'boolean') {
          setAllowStudentUnmute(data.audioStage.allowStudentUnmute);
        }
        if (Array.isArray(data.audioStage.invitedTeachers)) {
          setInvitedTeachers(data.audioStage.invitedTeachers);
        }
        if (Array.isArray(data.audioStage.whiteboardEditors)) {
          setWhiteboardEditors(data.audioStage.whiteboardEditors);
        }
        if (Array.isArray(data.audioStage.multiDeviceStudents)) {
          setMultiDeviceStudents(data.audioStage.multiDeviceStudents);
        }
      }
    });

    // 2. Full Snapshot Catch-Up
    socket.on('FULL_SNAPSHOT', (data: any) => {
      const snap = data.snapshot;
      if (!snap) return;

      updateSeqId(snap.seqId || 0);
      setModeState(snap.mode || 'CONTENT');
      setTeacherStatus(snap.status || 'LIVE');

      if (snap.teacherCam) setTeacherCam(snap.teacherCam);
      if (snap.whiteboardCursor) setWhiteboardCursor(snap.whiteboardCursor);
      if (snap.excalidrawElements) setIncomingWhiteboardDelta(snap.excalidrawElements);
      if (snap.excalidrawFiles) setWhiteboardFiles(snap.excalidrawFiles);
      if (snap.contentState) {
        if (
          snap.contentState.activeLessonId &&
          snap.contentState.activeLessonId !== 'les_ohms_law'
        ) {
          setActiveLessonId(String(snap.contentState.activeLessonId));
        }
        if (
          snap.contentState.activeTopicId &&
          snap.contentState.activeTopicId !== 'top_resistance'
        ) {
          setActiveTopicId(String(snap.contentState.activeTopicId));
        }
        if (snap.contentState.activeBlockId) setActiveBlockId(snap.contentState.activeBlockId);
        if (snap.contentState.blockOffsetRatio !== undefined) {
          setBlockOffsetRatio(snap.contentState.blockOffsetRatio);
        }
        if (snap.contentState.scrollAuthorId) {
          setScrollAuthorId(snap.contentState.scrollAuthorId);
        }
        if (snap.contentState.scrollUpdatedAt) {
          setScrollUpdatedAt(snap.contentState.scrollUpdatedAt);
        }
        if (snap.contentState.penStrokes) setPenStrokes(snap.contentState.penStrokes);
      }
      if (snap.audioStage) {
        if (snap.audioStage.activeStudentMics) {
          setActiveStudentMics(snap.audioStage.activeStudentMics);
        }
        if (snap.audioStage.raisedHands) {
          setRaisedHands(snap.audioStage.raisedHands);
        }
        if (typeof snap.audioStage.teacherMicActive === 'boolean') {
          setTeacherMicActive(snap.audioStage.teacherMicActive);
        }
        if (typeof snap.audioStage.allowStudentUnmute === 'boolean') {
          setAllowStudentUnmute(snap.audioStage.allowStudentUnmute);
        }
        if (Array.isArray(snap.audioStage.invitedTeachers)) {
          setInvitedTeachers(snap.audioStage.invitedTeachers);
        }
        if (Array.isArray(snap.audioStage.whiteboardEditors)) {
          setWhiteboardEditors(snap.audioStage.whiteboardEditors);
        }
        if (Array.isArray(snap.audioStage.multiDeviceStudents)) {
          setMultiDeviceStudents(snap.audioStage.multiDeviceStudents);
        }
      }
    });

    // 3. Replay Missed Ring-Buffer Packets
    socket.on('MISSED_PACKETS_REPLAY', (data: any) => {
      const packets = data.packets as any[];
      if (!Array.isArray(packets)) return;

      for (const p of packets) {
        updateSeqId(p.seqId);
        if (p.type === 'MODE_CHANGE') setModeState(p.payload.mode);
        if (p.type === 'TEACHER_CAM_UPDATE') setTeacherCam(p.payload);
        if (p.type === 'WHITEBOARD_CLEAR') {
          setIncomingWhiteboardDelta([]);
          setWhiteboardFiles({});
        }
        if (p.type === 'WHITEBOARD_FILES_DELTA' && p.payload?.files && typeof p.payload.files === 'object') {
          setWhiteboardFiles((prev) => ({ ...prev, ...p.payload.files }));
        }
        if (p.type === 'WHITEBOARD_ELEMENTS_DELTA' && Array.isArray(p.payload?.elements)) {
          setIncomingWhiteboardDelta((prev) => {
            const map = new Map<string, any>();
            for (const el of prev) map.set(el.id, el);
            for (const el of p.payload.elements) {
              const existing = map.get(el.id);
              const incomingVer = el.version ?? 1;
              const existingVer = existing?.version ?? 0;
              if (
                !existing ||
                incomingVer > existingVer ||
                (incomingVer === existingVer &&
                  (el.versionNonce !== existing.versionNonce ||
                    (el.index ?? null) !== (existing.index ?? null) ||
                    Boolean(el.isDeleted) !== Boolean(existing.isDeleted))) ||
                (Boolean(el.isDeleted) && !Boolean(existing.isDeleted)) ||
                (!existing.fileId && Boolean(el.fileId))
              ) {
                map.set(el.id, el);
              }
            }
            return Array.from(map.values());
          });
        }
        if (p.type === 'CONTENT_SCROLL_SYNC') {
          setActiveBlockId(p.payload.activeBlockId);
          setBlockOffsetRatio(p.payload.blockOffsetRatio);
          if (p.payload.authorId) setScrollAuthorId(p.payload.authorId);
          setScrollUpdatedAt(p.payload.updatedAt || p.timestamp || Date.now());
        }
        if (p.type === 'NAV_STATE_CHANGE') {
          setActiveLessonId(p.payload.activeLessonId);
          setActiveTopicId(p.payload.activeTopicId);
          if (Array.isArray(p.payload.penStrokes)) {
            setPenStrokes(p.payload.penStrokes);
          }
        }
        if (p.type === 'CONTENT_STROKE_ADD') {
          setPenStrokes((prev) =>
            prev.some((s) => s.id === p.payload.id) ? prev : [...prev, p.payload]
          );
        }
        if (p.type === 'CONTENT_STROKE_DELETE') {
          setPenStrokes((prev) => prev.filter((s) => s.id !== p.payload.strokeId));
        }
        if (p.type === 'CONTENT_STROKES_CLEAR') {
          setPenStrokes([]);
        }
        if (p.type === 'ATTENDANCE_METRICS_UPDATE') {
          if (p.payload.onlineCount !== undefined) setOnlineCount(p.payload.onlineCount);
          if (Array.isArray(p.payload.students)) setAttendanceList(p.payload.students);
        }
      }
    });

    // 4. Mode Change Broadcast
    socket.on('MODE_CHANGE', (packet: any) => {
      if (packet?.seqId) updateSeqId(packet.seqId);
      const newMode = packet.payload ? packet.payload.mode : packet.mode;
      if (newMode) setModeState(newMode);
    });

    // 5. Teacher Cam & Live Cursor Broadcast
    socket.on('TEACHER_CAM_UPDATE', (cam: any) => {
      if (cam?.seqId) updateSeqId(cam.seqId);
      setTeacherCam(cam);
    });

    socket.on('WHITEBOARD_CURSOR_MOVE', (cursor: any) => {
      setWhiteboardCursor(cursor);
    });

    // 6. Whiteboard Delta Sync (Version-Map Merge), Clear & Files
    socket.on('WHITEBOARD_DELTA', (data: any) => {
      if (data?.seqId) updateSeqId(data.seqId);
      if (Array.isArray(data.elements)) {
        setIncomingWhiteboardDelta((prev) => {
          const map = new Map<string, any>();
          for (const el of prev) map.set(el.id, el);
          for (const el of data.elements) {
            const existing = map.get(el.id);
            const incomingVer = el.version ?? 1;
            const existingVer = existing?.version ?? 0;
            if (
              !existing ||
              incomingVer > existingVer ||
              (incomingVer === existingVer &&
                (el.versionNonce !== existing.versionNonce ||
                  (el.index ?? null) !== (existing.index ?? null) ||
                  Boolean(el.isDeleted) !== Boolean(existing.isDeleted))) ||
              (Boolean(el.isDeleted) && !Boolean(existing.isDeleted)) ||
              (!existing.fileId && Boolean(el.fileId))
            ) {
              map.set(el.id, el);
            }
          }
          return Array.from(map.values());
        });
      }
    });

    socket.on('WHITEBOARD_CLEAR', (data?: any) => {
      if (data?.seqId) updateSeqId(data.seqId);
      setIncomingWhiteboardDelta([]);
      setWhiteboardFiles({});
    });

    socket.on('WHITEBOARD_FILES_DELTA', (data: any) => {
      if (data?.seqId) updateSeqId(data.seqId);
      if (data?.files && typeof data.files === 'object') {
        setWhiteboardFiles((prev) => ({ ...prev, ...data.files }));
      }
    });

    // 7. Content Scroll Sync
    socket.on('CONTENT_SCROLL_SYNC', (data: any) => {
      if (data?.seqId) updateSeqId(data.seqId);
      setActiveBlockId(data.activeBlockId);
      setBlockOffsetRatio(data.blockOffsetRatio);
      if (data?.authorId) setScrollAuthorId(data.authorId);
      setScrollUpdatedAt(data?.updatedAt || Date.now());
    });

    // 8. Navigation State Sync
    socket.on('NAV_STATE_CHANGE', (data: any) => {
      if (data?.seqId) updateSeqId(data.seqId);
      setActiveLessonId((prev) => {
        if (Array.isArray(data.penStrokes)) {
          setPenStrokes(data.penStrokes);
        } else if (prev !== data.activeLessonId) {
          setPenStrokes([]);
        }
        return data.activeLessonId;
      });
      setActiveTopicId(data.activeTopicId);
    });

    // 9. Content Pen, Highlighter, Eraser & Laser
    socket.on('CONTENT_STROKE_ADD', (stroke: any) => {
      if (stroke?.seqId) updateSeqId(stroke.seqId);
      setPenStrokes((prev) => (prev.some((s) => s.id === stroke.id) ? prev : [...prev, stroke]));
    });

    socket.on('CONTENT_STROKE_DELETE', (data: { lessonId: string; strokeId: string; seqId?: number }) => {
      if (data?.seqId) updateSeqId(data.seqId);
      setPenStrokes((prev) => prev.filter((s) => s.id !== data.strokeId));
    });

    socket.on('CONTENT_STROKES_CLEAR', (data?: { lessonId?: string; seqId?: number }) => {
      if (data?.seqId) updateSeqId(data.seqId);
      setPenStrokes([]);
    });

    socket.on('CONTENT_LASER_MOVE', (laser: any) => {
      setLaserPointer(laser);
    });

    // 10. Teacher Status (Reconnecting / Live / Ended)
    socket.on('TEACHER_STATUS_CHANGE', (data: any) => {
      setTeacherStatus(data.status);
    });

    socket.on('SESSION_ENDED', (data?: any) => {
      intentionalLeaveRef.current = true;
      setTeacherStatus('ENDED');
      setSessionEndedInfo({
        endedBy: data?.endedBy,
        endedByRole: data?.endedByRole,
        message: data?.message,
      });
      if (typeof window !== 'undefined' && sessionId) {
        try {
          if (token) {
            window.sessionStorage.setItem('broadcast_ended_token', token);
            window.sessionStorage.setItem('broadcast_ended_session_id', sessionId);
          }
          window.sessionStorage.setItem('broadcast_session_ended', sessionId);
          window.sessionStorage.removeItem('broadcast_rejoin_token');
          window.sessionStorage.removeItem('broadcast_rejoin_session_id');
          window.sessionStorage.removeItem('broadcast_rejoin_authorized');
          window.sessionStorage.removeItem('broadcast_restart_authorized');
          window.sessionStorage.removeItem('broadcast_session_left');
          window.localStorage.removeItem(`broadcast_rec_ctx_${sessionId}`);
        } catch {
          // Ignore storage cleanup error
        }
      }
      setIsConnected(false);
      setIsReconnecting(false);
      socket.disconnect();
    });

    // 11. Attendance Metrics
    socket.on('ATTENDANCE_METRICS_UPDATE', (data: any) => {
      if (data.onlineCount !== undefined) {
        setOnlineCount(data.onlineCount);
      }
      if (Array.isArray(data.students)) {
        setAttendanceList(data.students);
      }
    });

    // 12. Audio Stage
    socket.on('AUDIO_HAND_RAISED', (data: any) => {
      setRaisedHands((prev) => {
        const filtered = prev.filter((h) => h.userId !== data.entry.userId);
        return [...filtered, data.entry];
      });
    });

    socket.on('AUDIO_HAND_LOWERED', (data: any) => {
      setRaisedHands((prev) => prev.filter((h) => h.userId !== data.userId));
    });

    socket.on('AUDIO_MIC_GRANTED', (data: any) => {
      setActiveStudentMics((prev) => {
        const cleanTarget = String(data.studentId || '').replace(/^student_/, '');
        const cleanEvicted = String(data.evictedStudentId || '').replace(/^student_/, '');
        let updated = prev.filter((id) => {
          const cleanExisting = String(id).replace(/^student_/, '');
          if (cleanEvicted && cleanExisting === cleanEvicted) return false;
          if (cleanTarget && cleanExisting === cleanTarget) return false;
          return true;
        });
        if (data.studentId) {
          updated = [...updated, data.studentId];
        }
        return updated;
      });
      setRaisedHands((prev) => prev.filter((h) => h.userId !== data.studentId));

      const myUserId = role === 'teacher' ? teacherId || '' : `student_${studentId || ''}`;
      const isTargetMe =
        data.studentId === myUserId ||
        data.studentId === studentId ||
        data.studentId === `student_${studentId}` ||
        `student_${data.studentId}` === myUserId;

      if (isTargetMe && !data.selfUnmuted) {
        const grantedToken =
          (data.deviceTokens && data.deviceTokens[clientDeviceId]) || data.token;
        const shouldAutoActivate =
          Boolean(data.autoActivate) &&
          (!data.targetDeviceId || data.targetDeviceId === clientDeviceId);
        if (grantedToken && onStudentTokenRefreshRef.current) {
          onStudentTokenRefreshRef.current(grantedToken, shouldAutoActivate);
        }
      }
    });

    socket.on('AUDIO_ALLOW_UNMUTE_CHANGED', (data: any) => {
      setAllowStudentUnmute(Boolean(data?.allowStudentUnmute));
    });

    socket.on('AUDIO_MIC_REVOKED', (data: any) => {
      if (!data?.anyDeviceMicActive) {
        const cleanTarget = String(data?.studentId || '').replace(/^student_/, '');
        setActiveStudentMics((prev) =>
          prev.filter(
            (id) =>
              id !== data.studentId &&
              String(id).replace(/^student_/, '') !== cleanTarget
          )
        );
      }
      if (role === 'student' && data?.studentId) {
        const isTargetMe =
          data.studentId === studentId ||
          data.studentId === `student_${studentId}` ||
          data.studentId.replace(/^student_/, '') === studentId;
        if (isTargetMe) {
          // If a specific deviceId was muted, only revoke local mic on that device
          if (data.deviceId && data.deviceId !== clientDeviceId) {
            return;
          }
          // Only revoke student mic permission when teacher explicitly revokes it (not when student self-mutes)
          if (!data.selfMuted || data.revokedByTeacher === true) {
            onStudentMicRevokedRef.current?.();
          }
        }
      }
    });

    socket.on(
      'STUDENT_MULTI_DEVICE_UPDATED',
      (data: {
        studentId?: string;
        allowMultiDevice?: boolean;
        multiDeviceStudents?: string[];
      }) => {
        if (Array.isArray(data?.multiDeviceStudents)) {
          setMultiDeviceStudents(data.multiDeviceStudents);
        }
        if (role === 'student' && data?.allowMultiDevice && multiDeviceBlockedRef.current) {
          const normMyId = `student_${String(studentId || '').replace(/^student_/, '')}`;
          if (!data.studentId || data.studentId === normMyId) {
            setMultiDeviceBlocked(null);
            socket.emit('JOIN_ROOM', {
              sessionId,
              lastSeqId: seqIdRef.current,
              deviceId: clientDeviceId,
            });
          }
        }
      }
    );

    socket.on('AUDIO_MUTE_ALL', (data?: { allowStudentUnmute?: boolean }) => {
      setActiveStudentMics([]);
      if (data?.allowStudentUnmute === false || data?.allowStudentUnmute === undefined) {
        setAllowStudentUnmute(false);
      }
      if (role === 'student') {
        onStudentMicRevokedRef.current?.();
      }
    });

    socket.on('AUDIO_ERROR', (err: any) => {
      setAudioError(err);
    });

    socket.on('TEACHER_MIC_STATE_CHANGE', (data: { active: boolean }) => {
      if (typeof data?.active === 'boolean') {
        setTeacherMicActive(data.active);
      }
    });

    socket.on('AUDIO_VOICE_FRAME', (data: any) => {
      if (data && data.pcm) {
        onIncomingVoiceFrameRef.current?.(data);
      }
    });

    socket.on(
      'CO_TEACHERS_UPDATED',
      (data: { invitedTeachers?: InvitedTeacherEntry[]; whiteboardEditors?: string[] }) => {
        if (Array.isArray(data?.invitedTeachers)) {
          setInvitedTeachers(data.invitedTeachers);
        }
        if (Array.isArray(data?.whiteboardEditors)) {
          setWhiteboardEditors(data.whiteboardEditors);
        }
      }
    );

    socket.on(
      'WHITEBOARD_ACCESS_UPDATED',
      (data: { whiteboardEditors?: string[]; invitedTeachers?: InvitedTeacherEntry[] }) => {
        if (Array.isArray(data?.whiteboardEditors)) {
          setWhiteboardEditors(data.whiteboardEditors);
        }
        if (Array.isArray(data?.invitedTeachers)) {
          setInvitedTeachers(data.invitedTeachers);
        }
      }
    );

    // Heartbeat ping interval for student (every 30 seconds)
    const heartbeatTimer = setInterval(() => {
      if (socket.connected && role === 'student') {
        socket.emit('HEARTBEAT', { deviceId: clientDeviceId });
        setLastHeartbeat(Date.now());
      }
    }, 30000);

    return () => {
      clearInterval(heartbeatTimer);
      socket.disconnect();
    };
  }, [sessionId, role, token, studentId, teacherId, updateSeqId]);

  // Client actions
  const changeMode = useCallback(
    (newMode: 'CONTENT' | 'WHITEBOARD' | 'ROUGH_PAD') => {
      setModeState(newMode);
      if (socketRef.current?.connected && role === 'teacher') {
        socketRef.current.emit('MODE_CHANGE', { mode: newMode });
      }
    },
    [role]
  );

  const broadcastTeacherCam = useCallback(
    (cam: any) => {
      const roundedCam = {
        ...cam,
        Cx: typeof cam?.Cx === 'number' ? Math.round(cam.Cx * 10) / 10 : 0,
        Cy: typeof cam?.Cy === 'number' ? Math.round(cam.Cy * 10) / 10 : 0,
        authorId: localUserId,
        updatedAt: Date.now(),
      };
      setTeacherCam((prev: any) => {
        if (
          prev &&
          prev.Cx === roundedCam.Cx &&
          prev.Cy === roundedCam.Cy &&
          prev.Zt === roundedCam.Zt &&
          prev.Wt === roundedCam.Wt &&
          prev.Ht === roundedCam.Ht
        ) {
          return prev;
        }
        return roundedCam;
      });
      if (socketRef.current?.connected) {
        socketRef.current.emit('TEACHER_CAM_UPDATE', roundedCam);
      }
    },
    [localUserId]
  );

  const broadcastWhiteboardCursor = useCallback(
    (cursor: {
      Lx: number;
      Ly: number;
      tool?: 'pointer' | 'laser';
      button?: 'up' | 'down';
      active: boolean;
      teacherName?: string;
    }) => {
      const payload = {
        ...cursor,
        Lx: Math.round((cursor.Lx ?? 0) * 10) / 10,
        Ly: Math.round((cursor.Ly ?? 0) * 10) / 10,
        updatedAt: Date.now(),
      };
      if (socketRef.current?.connected) {
        socketRef.current.emit('WHITEBOARD_CURSOR_MOVE', payload);
      }
    },
    []
  );

  const broadcastWhiteboardDelta = useCallback(
    (elements: any[], appState?: any) => {
      const roundedElements = Array.isArray(elements)
        ? elements.map((el) => {
            if (!el || typeof el !== 'object') return el;
            const nextEl: any = {
              ...el,
              x: typeof el.x === 'number' ? Math.round(el.x * 10) / 10 : el.x,
              y: typeof el.y === 'number' ? Math.round(el.y * 10) / 10 : el.y,
              width: typeof el.width === 'number' ? Math.round(el.width * 10) / 10 : el.width,
              height: typeof el.height === 'number' ? Math.round(el.height * 10) / 10 : el.height,
            };
            if (Array.isArray(el.points)) {
              nextEl.points = el.points.map((pt: any) =>
                Array.isArray(pt)
                  ? pt.map((val: any, idx: number) =>
                      idx < 2 && typeof val === 'number' && Number.isFinite(val)
                        ? Math.round(val * 10) / 10
                        : val
                    )
                  : pt
              );
            }
            return nextEl;
          })
        : elements;

      if (Array.isArray(roundedElements) && roundedElements.length > 0) {
        setIncomingWhiteboardDelta((prev) => {
          const map = new Map<string, any>();
          for (const el of prev) map.set(el.id, el);
          for (const el of roundedElements) {
            const existing = map.get(el.id);
            const incomingVer = el.version ?? 1;
            const existingVer = existing?.version ?? 0;
            if (
              !existing ||
              incomingVer > existingVer ||
              (incomingVer === existingVer &&
                (el.versionNonce !== existing.versionNonce ||
                  (el.index ?? null) !== (existing.index ?? null) ||
                  Boolean(el.isDeleted) !== Boolean(existing.isDeleted))) ||
              (Boolean(el.isDeleted) && !Boolean(existing.isDeleted)) ||
              (!existing.fileId && Boolean(el.fileId))
            ) {
              map.set(el.id, el);
            }
          }
          return Array.from(map.values());
        });
      }
      if (socketRef.current?.connected) {
        socketRef.current.emit('WHITEBOARD_DELTA', { elements: roundedElements, appState });
      }
    },
    []
  );

  const broadcastWhiteboardClear = useCallback(() => {
    setIncomingWhiteboardDelta([]);
    setWhiteboardFiles({});
    if (socketRef.current?.connected) {
      socketRef.current.emit('WHITEBOARD_CLEAR');
    }
  }, []);

  const broadcastWhiteboardFiles = useCallback(
    (files: Record<string, any>) => {
      if (!files || Object.keys(files).length === 0) return;
      setWhiteboardFiles((prev) => ({ ...prev, ...files }));
      if (socketRef.current?.connected) {
        socketRef.current.emit('WHITEBOARD_FILES_DELTA', { files });
      }
    },
    []
  );

  const sendContentBlockToWhiteboard = useCallback(
    (block: any) => {
      if (socketRef.current?.connected && role === 'teacher') {
        socketRef.current.emit('SEND_TO_WHITEBOARD', { block });
        setModeState('WHITEBOARD');
      }
    },
    [role]
  );

  const broadcastScrollSync = useCallback(
    (blockId: string, ratio: number) => {
      setActiveBlockId(blockId);
      setBlockOffsetRatio(ratio);
      setScrollAuthorId(localUserId);
      setScrollUpdatedAt(Date.now());
      if (socketRef.current?.connected) {
        socketRef.current.emit('CONTENT_SCROLL_SYNC', {
          activeBlockId: blockId,
          blockOffsetRatio: ratio,
          authorId: localUserId,
        });
      }
    },
    [localUserId]
  );

  const broadcastNavSync = useCallback(
    (lessonId: string, topicId: string) => {
      setActiveLessonId((prev) => {
        if (prev !== lessonId) {
          setPenStrokes([]);
        }
        return lessonId;
      });
      setActiveTopicId(topicId);
      if (socketRef.current?.connected && role === 'teacher') {
        socketRef.current.emit('NAV_STATE_CHANGE', {
          activeLessonId: lessonId,
          activeTopicId: topicId,
        });
      }
    },
    [role]
  );

  const broadcastStroke = useCallback(
    (stroke: any) => {
      const roundedStroke = {
        ...stroke,
        points: Array.isArray(stroke?.points)
          ? stroke.points.map((pt: any) => ({
              ...pt,
              x: typeof pt?.x === 'number' ? Math.round(pt.x * 10) / 10 : 0,
              y: typeof pt?.y === 'number' ? Math.round(pt.y * 10) / 10 : 0,
            }))
          : [],
      };
      setPenStrokes((prev) => [...prev, roundedStroke]);
      if (socketRef.current?.connected) {
        socketRef.current.emit('CONTENT_STROKE_ADD', roundedStroke);
      }
    },
    []
  );

  const broadcastDeleteStroke = useCallback(
    (lessonId: string, strokeId: string) => {
      setPenStrokes((prev) => prev.filter((s) => s.id !== strokeId));
      if (socketRef.current?.connected) {
        socketRef.current.emit('CONTENT_STROKE_DELETE', { lessonId, strokeId });
      }
    },
    []
  );

  const broadcastClearStrokes = useCallback(
    (lessonId: string) => {
      setPenStrokes([]);
      if (socketRef.current?.connected && role === 'teacher') {
        socketRef.current.emit('CONTENT_STROKES_CLEAR', { lessonId });
      }
    },
    [role]
  );

  const broadcastLaser = useCallback(
    (laser: any) => {
      const roundedLaser = {
        ...laser,
        x: typeof laser?.x === 'number' ? Math.round(laser.x * 10) / 10 : 0,
        y: typeof laser?.y === 'number' ? Math.round(laser.y * 10) / 10 : 0,
        authorId: localUserId,
        updatedAt: Date.now(),
      };
      // Avoid 33Hz local React state re-renders of the entire layout tree during normal cursor movement
      if (laser?.tool !== 'cursor') {
        setLaserPointer(roundedLaser);
      }
      if (socketRef.current?.connected) {
        socketRef.current.emit('CONTENT_LASER_MOVE', roundedLaser);
      }
    },
    [localUserId]
  );

  const raiseHand = useCallback(() => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('AUDIO_RAISE_HAND', { deviceId: clientDeviceIdRef.current });
    }
  }, []);

  const lowerHand = useCallback((targetUserId?: string) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('AUDIO_LOWER_HAND', { userId: targetUserId });
    }
  }, []);

  const grantMic = useCallback(
    (targetStudentId: string, forceReplaceOldest = false) => {
      if (socketRef.current?.connected && role === 'teacher') {
        socketRef.current.emit('AUDIO_GRANT_MIC', {
          studentId: targetStudentId,
          forceReplaceOldest,
        });
      }
    },
    [role]
  );

  const muteStudent = useCallback(
    (targetStudentId: string) => {
      if (socketRef.current?.connected && role === 'teacher') {
        socketRef.current.emit('AUDIO_MUTE_STUDENT', { studentId: targetStudentId });
      }
    },
    [role]
  );

  const muteAllStudents = useCallback(() => {
    if (socketRef.current?.connected && role === 'teacher') {
      socketRef.current.emit('AUDIO_MUTE_ALL');
    }
  }, [role]);

  // Host/Co-Host toggles "Allow Students to Unmute Themselves"
  const setAllowStudentUnmuteOption = useCallback(
    (allow: boolean) => {
      setAllowStudentUnmute(allow);
      if (socketRef.current?.connected && role === 'teacher') {
        socketRef.current.emit('AUDIO_SET_ALLOW_UNMUTE', { allow });
      }
    },
    [role]
  );

  // Student self unmute (used when host enables allowStudentUnmute or student has mic grant)
  const studentSelfUnmute = useCallback(() => {
    if (socketRef.current?.connected && role === 'student') {
      const normId = studentId ? `student_${studentId.replace(/^student_/, '')}` : undefined;
      socketRef.current.emit('AUDIO_STUDENT_SELF_UNMUTE', {
        studentId: normId,
        deviceId: clientDeviceIdRef.current,
      });
    }
  }, [role, studentId]);

  // Student self mute (scoped to this deviceId so another device of the same student stays unmuted independently)
  const studentSelfMute = useCallback(() => {
    if (socketRef.current?.connected && role === 'student') {
      const normId = studentId ? `student_${studentId.replace(/^student_/, '')}` : undefined;
      socketRef.current.emit('AUDIO_STUDENT_SELF_MUTE', {
        studentId: normId,
        deviceId: clientDeviceIdRef.current,
      });
    }
  }, [role, studentId]);

  // Notify server of this specific device's active microphone state
  const notifyDeviceMicActive = useCallback(
    (active: boolean) => {
      if (socketRef.current?.connected && role === 'student') {
        socketRef.current.emit('AUDIO_DEVICE_MIC_ACTIVE', {
          deviceId: clientDeviceIdRef.current,
          active,
          micActive: active,
        });
      }
    },
    [role]
  );

  // Emit real-time Port-443 WebAudio PCM Voice Frame over Socket.IO
  const broadcastVoiceFrame = useCallback(
    (frame: { pcm: string; sampleRate: number; seq: number; rms?: number }) => {
      const sock = socketRef.current;
      if (sock?.connected && frame?.pcm) {
        const payload = {
          ...frame,
          deviceId: clientDeviceIdRef.current,
        };
        if (sock.volatile) {
          sock.volatile.emit('AUDIO_VOICE_FRAME', payload);
        } else {
          sock.emit('AUDIO_VOICE_FRAME', payload);
        }
      }
    },
    []
  );

  // Host Teacher toggles multi-device join permission for a specific student
  const setStudentMultiDeviceAccess = useCallback(
    (targetStudentId: string, allow: boolean) => {
      const normId = `student_${String(targetStudentId).replace(/^student_/, '')}`;
      setMultiDeviceStudents((prev) =>
        allow ? Array.from(new Set([...prev, normId])) : prev.filter((id) => id !== normId)
      );
      if (socketRef.current?.connected && role === 'teacher') {
        socketRef.current.emit('AUDIO_SET_STUDENT_MULTI_DEVICE', {
          studentId: normId,
          allow,
        });
      }
    },
    [role]
  );

  const retryJoinRoom = useCallback(() => {
    setMultiDeviceBlocked(null);
    if (socketRef.current?.connected) {
      socketRef.current.emit('JOIN_ROOM', {
        sessionId,
        lastSeqId: seqIdRef.current,
        deviceId: clientDeviceIdRef.current,
      });
    } else {
      socketRef.current?.connect();
    }
  }, [sessionId]);

  const broadcastTeacherMicState = useCallback(
    (active: boolean) => {
      setTeacherMicActive(active);
      if (socketRef.current?.connected && role === 'teacher') {
        socketRef.current.emit('TEACHER_MIC_STATE_CHANGE', { active });
      }
    },
    [role]
  );

  const inviteCoTeacher = useCallback(
    (teacherId: string, name?: string, canUseWhiteboard = true) => {
      if (socketRef.current?.connected && role === 'teacher') {
        socketRef.current.emit('TEACHER_INVITE_CO_TEACHER', {
          teacherId,
          name,
          canUseWhiteboard,
        });
      }
    },
    [role]
  );

  const toggleCoTeacherWhiteboard = useCallback(
    (teacherId: string, canUseWhiteboard: boolean) => {
      if (socketRef.current?.connected && role === 'teacher') {
        socketRef.current.emit('TEACHER_TOGGLE_CO_TEACHER_WB', {
          teacherId,
          canUseWhiteboard,
        });
      }
    },
    [role]
  );

  const removeCoTeacher = useCallback(
    (teacherId: string) => {
      if (socketRef.current?.connected && role === 'teacher') {
        socketRef.current.emit('TEACHER_REMOVE_CO_TEACHER', { teacherId });
      }
    },
    [role]
  );

  const grantWhiteboardAccess = useCallback(
    (targetUserId: string) => {
      if (socketRef.current?.connected && role === 'teacher') {
        socketRef.current.emit('WHITEBOARD_GRANT_ACCESS', {
          userId: targetUserId,
          targetUserId,
        });
      }
    },
    [role]
  );

  const revokeWhiteboardAccess = useCallback(
    (targetUserId: string) => {
      if (socketRef.current?.connected && role === 'teacher') {
        socketRef.current.emit('WHITEBOARD_REVOKE_ACCESS', {
          userId: targetUserId,
          targetUserId,
        });
      }
    },
    [role]
  );

  const clearAudioError = useCallback(() => {
    setAudioError(null);
  }, []);

  const simulateDisconnect = useCallback(() => {
    if (socketRef.current) {
      setIsConnected(false);
      setIsReconnecting(true);
      socketRef.current.disconnect();
      window.setTimeout(() => {
        socketRef.current?.connect();
      }, 2800);
    }
  }, []);

  const manualReconnect = useCallback(() => {
    if (socketRef.current) {
      intentionalLeaveRef.current = false;
      setHasLeftSession(false);
      socketRef.current.connect();
    }
  }, []);

  const leaveSession = useCallback(() => {
    intentionalLeaveRef.current = true;
    setHasLeftSession(true);
    setIsReconnecting(false);
    const sock = socketRef.current;
    if (sock) {
      if (sock.connected) {
        sock.emit(
          'LEAVE_SESSION',
          { sessionId, deviceId: clientDeviceIdRef.current },
          () => {
            sock.disconnect();
          }
        );
        window.setTimeout(() => {
          sock.disconnect();
        }, 120);
      } else {
        sock.disconnect();
      }
    }
    setIsConnected(false);
  }, [sessionId]);

  const endSession = useCallback(() => {
    intentionalLeaveRef.current = true;
    setTeacherStatus('ENDED');
    setIsReconnecting(false);
    const sock = socketRef.current;
    if (sock && sock.connected) {
      sock.emit('END_SESSION', { sessionId }, () => {
        sock.disconnect();
      });
      window.setTimeout(() => {
        sock.disconnect();
        setIsConnected(false);
      }, 150);
    } else {
      sock?.disconnect();
      setIsConnected(false);
    }
  }, [sessionId]);

  const rejoinSession = useCallback(
    (options?: { restart?: boolean }) => {
      intentionalLeaveRef.current = false;
      setHasLeftSession(false);
      setSessionEndedInfo(null);
      setTeacherStatus('LIVE');
      if (options?.restart) {
        restartRef.current = true;
      }
      if (socketRef.current) {
        if (socketRef.current.connected) {
          const shouldRestart = restartRef.current;
          restartRef.current = false;
          socketRef.current.emit('JOIN_ROOM', {
            sessionId,
            lastSeqId: seqIdRef.current,
            deviceId: clientDeviceIdRef.current,
            ...(shouldRestart ? { restart: true } : {}),
          });
        } else {
          socketRef.current.connect();
        }
      }
    },
    [sessionId]
  );

  return {
    isConnected,
    isReconnecting,
    reconnectAttempt,
    mode,
    teacherStatus,
    hasLeftSession,
    sessionEndedInfo,
    onlineCount,
    attendanceList,
    setAttendanceList,
    seqId,
    lastHeartbeat,
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
    clientDeviceId: clientDeviceIdRef.current,
    audioError,
    // actions
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
  };
}
