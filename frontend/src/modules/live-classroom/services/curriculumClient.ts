export type RelationalContextType =
  | 'course_lesson'
  | 'test_paper_solution'
  | 'current_affairs_session'
  | 'exam_bootcamp'
  | 'doubt_clearing_session';

export type CurriculumTeachingMode = 'taught' | 'reference_only';

/**
 * Full Relational Hierarchy Context mapping a Live Session and its recorded VOD/Whiteboard
 * artifacts to Zerix Academy's organizational hierarchy (Branch, Batch, Board, Language,
 * Master Course, Linked VOD Course, Chapter, Lesson, Topic, and Version).
 */
export interface RelationalLessonContext {
  sessionId: string;
  contextType?: RelationalContextType;
  contextId?: number;
  examCategoryId?: number | null;
  branchId: number;
  batchId: number;
  boardId: number | null;
  languageId: number;
  courseId: number;
  linkedVodCourseId: number;
  subjectId: number;
  chapterId: number | string;
  chapterNumber: number;
  chapterTitle: string;
  lessonId: number | string;
  lessonNumber: string;
  lessonTitle: string;
  topicId: number | string | null;
  teacherId: number | string;
  academicYear: number;
  version: number;
  publishToVodCourse: boolean;
  isPrimaryVod: boolean;
}

export interface CurriculumSegment {
  segmentIndex: number;
  chapterId: number | string;
  lessonId: number | string;
  topicId: number | string | null;
  mode: CurriculumTeachingMode;
  startOffsetSec: number;
  endOffsetSec: number | null;
  startedAtIso: string;
  endedAtIso: string | null;
  whiteboardStorageKey?: string | null;
}

/**
 * Strictly sanitizes Whiteboard JSON payload before saving so Content Mode pen/laser strokes
 * or ephemeral cursor states are NEVER persisted to cloud/disk storage.
 */
export function sanitizeWhiteboardPayloadForStorage(payload: {
  elements?: any[];
  appState?: Record<string, any>;
  files?: Record<string, any>;
  pages?: any[];
  penStrokes?: any;
  contentStrokes?: any;
  laserPointer?: any;
}) {
  const rawElements = Array.isArray(payload.elements) ? payload.elements : [];
  // Filter out deleted elements and any accidental content-mode stroke artifacts
  const cleanElements = rawElements.filter(
    (el) =>
      el &&
      typeof el === 'object' &&
      !el.isDeleted &&
      el.type !== 'content_stroke' &&
      el.type !== 'laser_pointer'
  );

  const safeAppState: Record<string, any> = {
    viewBackgroundColor: payload.appState?.viewBackgroundColor || '#ffffff',
    gridSize: payload.appState?.gridSize ?? null,
  };

  return {
    elements: cleanElements,
    appState: safeAppState,
    files: payload.files && typeof payload.files === 'object' ? payload.files : {},
    ...(Array.isArray(payload.pages) ? { pages: payload.pages } : {}),
  };
}

export function getApiBaseUrl(): string {
  if (
    process.env.NEXT_PUBLIC_BROADCAST_API_URL &&
    !process.env.NEXT_PUBLIC_BROADCAST_API_URL.includes('localhost') &&
    !process.env.NEXT_PUBLIC_BROADCAST_API_URL.includes('127.0.0.1')
  ) {
    return process.env.NEXT_PUBLIC_BROADCAST_API_URL.replace(/\/+$/, '');
  }
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname || 'localhost';
    const protocol = window.location.protocol || 'http:';
    if (protocol === 'https:') {
      return `${protocol}//${window.location.host}`;
    }
    return `${protocol}//${hostname}:4000`;
  }
  return process.env.NEXT_PUBLIC_BROADCAST_API_URL || 'http://127.0.0.1:4000';
}

export class CurriculumClient {
  private static async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const baseUrl = getApiBaseUrl();
    const url = `${baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...((options.headers as Record<string, string>) || {}),
      },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || `Request failed with status ${res.status}`);
    }

    return await res.json();
  }

  public static async fetchDevUsers() {
    const res = await this.request<{ success: boolean; data: any }>('/api/v1/dev/users');
    return res.data;
  }

  public static async fetchCurriculum(courseId: string) {
    const res = await this.request<{ success: boolean; data: any }>(`/api/v1/curriculum/${courseId}`);
    return res.data;
  }

  public static async fetchLessonContent(lessonId: string) {
    const res = await this.request<{ success: boolean; data: any }>(`/api/v1/lessons/${lessonId}/content`);
    return res.data;
  }

  public static async initSession(params: {
    sessionId: string;
    token?: string;
    role?: 'teacher' | 'student';
    studentId?: string;
    teacherId?: string;
    deviceId?: string;
  }) {
    const res = await this.request<{ success: boolean; data: any }>('/api/v1/sessions/init', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    return res.data;
  }

  public static async grantStudentMic(
    sessionId: string,
    studentId: string,
    token: string,
    forceReplaceOldest = false
  ) {
    return await this.request<{ success: boolean; message: string; data?: any }>(
      `/api/v1/sessions/${sessionId}/audio/grant`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ studentId, forceReplaceOldest }),
      }
    );
  }

  public static async muteStudent(sessionId: string, studentId: string, token: string) {
    return await this.request<{ success: boolean; message: string }>(
      `/api/v1/sessions/${sessionId}/audio/mute`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ studentId }),
      }
    );
  }

  public static async muteAllStudents(sessionId: string, token: string) {
    return await this.request<{ success: boolean; message: string; data: any }>(
      `/api/v1/sessions/${sessionId}/audio/mute-all`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  }

  public static async raiseHand(sessionId: string, token: string) {
    return await this.request<{ success: boolean; message: string }>(
      `/api/v1/sessions/${sessionId}/audio/raise-hand`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  }

  public static async lowerHand(sessionId: string, token: string) {
    return await this.request<{ success: boolean; message: string }>(
      `/api/v1/sessions/${sessionId}/audio/lower-hand`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  }

  public static async endSession(sessionId: string, token: string) {
    return await this.request<{ success: boolean; data: any }>(
      `/api/v1/sessions/${sessionId}/end`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  }

  public static async fetchSessionStatus(sessionId: string) {
    const res = await this.request<{
      success: boolean;
      data: {
        sessionId: string;
        status: 'LIVE' | 'ENDED' | 'TEACHER_RECONNECTING';
        isActive: boolean;
        roomName: string;
        title: string;
        batchName?: string;
        courseName?: string;
        subjectName?: string;
        teacherName?: string;
        lessonTitle?: string;
        onlineCount?: number;
      };
    }>(`/api/v1/sessions/${sessionId}/status`);
    return res.data;
  }

  /**
   * Streams a 10-second 720p compressed video chunk to the broadcast engine's
   * progressive session video file (`video_720p.webm`).
   */
  public static async uploadVideoChunk(
    sessionId: string,
    chunkData: Blob | Uint8Array | ArrayBuffer,
    options: {
      chunkIndex: number;
      mimeType?: string;
      relationalContext?: Partial<RelationalLessonContext>;
      lessonId?: string | number;
      token?: string;
    }
  ) {
    const baseUrl = getApiBaseUrl();
    const endpoint = options.lessonId
      ? `/api/v1/sessions/${sessionId}/lessons/${options.lessonId}/video-chunk`
      : `/api/v1/sessions/${sessionId}/video-chunk`;

    const authToken = options.token || 'DEV_TOKEN_TEACHER_501';
    const headers: Record<string, string> = {
      'Content-Type': options.mimeType || 'video/webm;codecs=vp9,opus',
      'x-chunk-index': String(options.chunkIndex),
      Authorization: `Bearer ${authToken}`,
    };

    if (options.relationalContext) {
      headers['x-relational-context'] = JSON.stringify(options.relationalContext);
    }

    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body: chunkData as BodyInit,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || `Video chunk #${options.chunkIndex} upload failed (${res.status})`);
    }

    return await res.json();
  }

  /**
   * Logs a multi-topic curriculum navigation event in the live session's timeline
   * without splitting or restarting the continuous 720p video stream.
   * Supports `'taught'` mode (publishes to VOD & saves whiteboard) and `'reference_only'`
   * mode (opens lesson for reference while protecting old VOD & whiteboard).
   */
  public static async navigateCurriculum(
    sessionId: string,
    payload: {
      chapterId: string | number;
      lessonId: string | number;
      topicId?: string | number | null;
      videoOffsetSec: number;
      mode?: CurriculumTeachingMode;
      relationalContext?: Partial<RelationalLessonContext>;
      token?: string;
    }
  ) {
    const { token, ...restPayload } = payload;
    const authToken = token || 'DEV_TOKEN_TEACHER_501';
    return await this.request<{
      success: boolean;
      message: string;
      data: {
        activeSegment: CurriculumSegment;
        totalSegments: number;
        videoStorageKey: string;
      };
    }>(`/api/v1/sessions/${sessionId}/curriculum-navigate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        ...restPayload,
        mode: restPayload.mode || 'taught',
      }),
    });
  }

  /**
   * Saves a Gzip-compressed Excalidraw Whiteboard JSON (`whiteboard.json`) for a taught lesson.
   * Explicitly strips Content Mode pen/laser strokes before transmitting.
   */
  public static async saveWhiteboard(
    sessionId: string,
    payload: {
      chapterId?: string | number;
      lessonId: string | number;
      topicId?: string | number | null;
      elements: any[];
      appState?: Record<string, any>;
      files?: Record<string, any>;
      pages?: any[];
      relationalContext?: Partial<RelationalLessonContext>;
      token?: string;
    }
  ) {
    const authToken = payload.token || 'DEV_TOKEN_TEACHER_501';
    const sanitized = sanitizeWhiteboardPayloadForStorage(payload);
    return await this.request<{
      success: boolean;
      message: string;
      data: {
        sessionId: string;
        lessonId: string | number;
        whiteboardStorageKey: string;
        compressedBytes: number;
        uncompressedBytes: number;
        elementsCount: number;
      };
    }>(`/api/v1/sessions/${sessionId}/whiteboard-save`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        chapterId: payload.chapterId,
        lessonId: payload.lessonId,
        topicId: payload.topicId ?? null,
        elements: sanitized.elements,
        appState: sanitized.appState,
        files: sanitized.files,
        ...(sanitized.pages ? { pages: sanitized.pages } : {}),
        relationalContext: payload.relationalContext,
      }),
    });
  }

  /**
   * Finalizes the live session recording, closes the active curriculum segment,
   * optionally saves the final taught lesson's whiteboard, and triggers the signed
   * HMAC-SHA256 webhook to Zerix Academy (Laravel) to publish the VOD course & attendance.
   */
  public static async finalizeSession(
    sessionId: string,
    payload: {
      totalDurationSec?: number;
      relationalContext?: Partial<RelationalLessonContext>;
      whiteboard?: {
        elements: any[];
        appState?: Record<string, any>;
        files?: Record<string, any>;
        pages?: any[];
      };
      token?: string;
    }
  ) {
    const authToken = payload.token || 'DEV_TOKEN_TEACHER_501';
    const bodyPayload: Record<string, any> = {
      totalDurationSec: payload.totalDurationSec,
      relationalContext: payload.relationalContext,
    };
    if (payload.whiteboard) {
      bodyPayload.whiteboard = sanitizeWhiteboardPayloadForStorage(payload.whiteboard);
    }

    return await this.request<{
      success: boolean;
      message: string;
      data: any;
    }>(`/api/v1/sessions/${sessionId}/finalize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(bodyPayload),
    });
  }

  /**
   * Fetches the multi-topic timeline, storage keys, and chunk metrics for a live or recorded session.
   */
  public static async fetchSessionTimeline(sessionId: string) {
    return await this.request<{
      success: boolean;
      data: {
        sessionId: string;
        startedAtIso: string;
        endedAtIso: string | null;
        totalDurationSec: number;
        videoStorageKey: string;
        chunksReceived: number;
        totalVideoBytes: number;
        relationalContext: RelationalLessonContext;
        segments: CurriculumSegment[];
      };
    }>(`/api/v1/sessions/${sessionId}/timeline`);
  }

  public static getVideoStreamUrl(storageKey: string): string {
    const cleanKey = storageKey.replace(/^\/+/, '');
    return `${getApiBaseUrl()}/api/v1/stream/video/${cleanKey}`;
  }

  public static getWhiteboardStreamUrl(storageKey: string): string {
    const cleanKey = storageKey.replace(/^\/+/, '');
    return `${getApiBaseUrl()}/api/v1/stream/whiteboard/${cleanKey}`;
  }
}
