import { IDataProvider } from './dataProvider.interface';
import {
  SessionContext,
  CurriculumSidebar,
  LessonContent,
  UserAuthPayload,
  SessionSnapshot,
  SessionFinalizationSummary,
} from '../types/broadcast.types';
import { SessionAttendanceSummary } from '../types/attendance.types';
import { JwtVerifier } from '../utils/jwtVerifier';
import { getStorageProvider } from './storage.provider';

export class LaravelApiDataProvider implements IDataProvider {
  public readonly mode = 'laravel_api' as const;

  private baseUrl: string;
  private apiSecret: string;
  private timeoutMs: number;

  constructor(baseUrl?: string, apiSecret?: string, timeoutMs = 8000) {
    this.baseUrl = (
      baseUrl ||
      process.env.LARAVEL_API_BASE_URL ||
      'https://api-academy.zerixtech.com'
    ).replace(/\/$/, '');
    this.apiSecret =
      apiSecret ||
      process.env.LARAVEL_INTERNAL_API_SECRET ||
      process.env.BROADCAST_INTERNAL_SECRET ||
      'zerix_internal_broadcast_secret_2026';
    this.timeoutMs = timeoutMs;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Internal-Secret': this.apiSecret,
      Authorization: `Bearer ${this.apiSecret}`,
      ...((options.headers as Record<string, string>) || {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Laravel API HTTP ${response.status} on ${endpoint}: ${errorText || response.statusText}`
        );
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  public async validateToken(token: string, sessionId?: string): Promise<UserAuthPayload | null> {
    if (!token) return null;
    const cleanToken = token.trim();

    // Fast-path: Verify HMAC-SHA256 JWT locally in < 0.05ms without making an HTTP call to Laravel
    if (JwtVerifier.looksLikeJwt(cleanToken)) {
      const verified = JwtVerifier.verify(cleanToken, { expectedSessionId: sessionId });
      if (verified.valid && verified.claims) {
        const claims = verified.claims;
        return {
          userId: String(claims.userId || claims.sub),
          name: claims.name || (claims.role === 'teacher' ? 'Teacher' : 'Student'),
          role: claims.role === 'teacher' ? 'teacher' : 'student',
          batchId: String(claims.batchId || sessionId || ''),
          sessionId: String(claims.sessionId || sessionId || ''),
          avatar: claims.avatarUrl,
          isCoTeacher: Boolean((claims as any).isCoTeacher),
          canUseWhiteboard:
            typeof claims.canUseWhiteboard === 'boolean'
              ? claims.canUseWhiteboard
              : claims.role === 'teacher' && !(claims as any).isCoTeacher,
        };
      }
      return null;
    }

    // Optional dev token fallback when ALLOW_DEV_TOKENS=true
    if (
      process.env.ALLOW_DEV_TOKENS === 'true' &&
      (cleanToken.startsWith('DEV_TOKEN_TEACHER_') || cleanToken.startsWith('DEV_TOKEN_STUDENT_'))
    ) {
      if (cleanToken.startsWith('DEV_TOKEN_TEACHER_')) {
        const suffix = cleanToken.replace(/^DEV_TOKEN_TEACHER_/, '') || '501';
        const isCoHost = ['502', '503', '504'].includes(suffix);
        return {
          userId: `teacher_${suffix}`,
          name: suffix === '501' ? 'Prof. Anand Sharma' : `Teacher #${suffix}`,
          role: 'teacher',
          batchId: String(sessionId || 'batch_physics_101'),
          sessionId: String(sessionId || 'batch_physics_101'),
          isCoTeacher: isCoHost,
          canUseWhiteboard: !isCoHost,
        };
      }
      const stSuffix = cleanToken.replace(/^DEV_TOKEN_STUDENT_/, '') || '101';
      return {
        userId: `student_${stSuffix}`,
        name: `Student #${stSuffix}`,
        role: 'student',
        batchId: String(sessionId || 'batch_physics_101'),
        sessionId: String(sessionId || 'batch_physics_101'),
      };
    }

    try {
      const result = await this.request<{
        valid?: boolean;
        user?: UserAuthPayload;
        claims?: Record<string, any>;
        data?: {
          valid?: boolean;
          user?: UserAuthPayload;
          claims?: Record<string, any>;
        };
      }>('/api/internal/broadcast/auth/verify-token', {
        method: 'POST',
        body: JSON.stringify({ token: cleanToken, sessionId }),
      });

      const payload = result?.data ?? result;
      const rawUser: Record<string, any> | undefined = (payload?.user || payload?.claims) as any;

      if (payload?.valid && rawUser) {
        if (
          sessionId &&
          rawUser.sessionId &&
          String(rawUser.sessionId) !== String(sessionId)
        ) {
          return null;
        }
        const resolvedUserId = String(rawUser.userId || rawUser.sub || rawUser.id || '');
        if (!resolvedUserId) return null;
        return {
          userId: resolvedUserId,
          name: String(rawUser.name || (rawUser.role === 'teacher' ? 'Teacher' : 'Student')),
          role: rawUser.role === 'teacher' ? 'teacher' : 'student',
          batchId: String(rawUser.batchId ?? sessionId ?? ''),
          sessionId: String(rawUser.sessionId || sessionId || ''),
          avatar: rawUser.avatar || rawUser.avatarUrl,
          isCoTeacher: Boolean(rawUser.isCoTeacher),
          canUseWhiteboard:
            typeof rawUser.canUseWhiteboard === 'boolean'
              ? rawUser.canUseWhiteboard
              : rawUser.role === 'teacher',
        };
      }
      return null;
    } catch (err: any) {
      console.error(`[LaravelApiDataProvider] Auth validation error for session ${sessionId}:`, err.message);
      return null;
    }
  }

  public async getSessionContext(sessionId: string): Promise<SessionContext | null> {
    try {
      const result = await this.request<{ data: SessionContext }>(
        `/api/internal/broadcast/sessions/${encodeURIComponent(sessionId)}/context`
      );
      return (result as any)?.data ?? (result as any);
    } catch (err: any) {
      console.error(`[LaravelApiDataProvider] Failed to get session context for ${sessionId}:`, err.message);
      return null;
    }
  }

  public async getCurriculumSidebar(courseId: string): Promise<CurriculumSidebar | null> {
    try {
      const result = await this.request<{ data: any }>(
        `/api/internal/broadcast/courses/${encodeURIComponent(courseId)}/curriculum`
      );
      const raw = (result as any)?.data ?? result;
      if (!raw) return null;

      const rawChapters = Array.isArray(raw.chapters) ? raw.chapters : [];
      return {
        courseId: String(raw.courseId ?? courseId),
        courseName: String(raw.courseName || raw.title || 'Course Curriculum'),
        boardId: String(raw.boardId ?? '1'),
        languageId: String(raw.languageId ?? '1'),
        chapters: rawChapters.map((ch: any, chIdx: number) => ({
          chapterId: String(ch.chapterId ?? ch.id ?? chIdx + 1),
          chapterNumber: Number(ch.chapterNumber ?? chIdx + 1),
          title: String(ch.title || ch.chapterTitle || `Chapter ${chIdx + 1}`),
          description: String(ch.description || ''),
          lessons: (Array.isArray(ch.lessons) ? ch.lessons : []).map(
            (les: any, lesIdx: number) => ({
              lessonId: String(les.lessonId ?? les.id ?? lesIdx + 1),
              lessonNumber: String(les.lessonNumber ?? lesIdx + 1),
              title: String(les.title || les.lessonTitle || `Lesson ${lesIdx + 1}`),
              topics: (Array.isArray(les.topics) ? les.topics : []).map(
                (top: any, topIdx: number) => ({
                  topicId: String(top.topicId ?? top.id ?? topIdx + 1),
                  title: String(top.title || top.topicTitle || `Topic ${topIdx + 1}`),
                  level: top.level || 'Foundation',
                  durationMinutes: Number(top.durationMinutes || 15),
                  boardId: String(top.boardId ?? raw.boardId ?? '1'),
                  languageId: String(top.languageId ?? raw.languageId ?? '1'),
                })
              ),
            })
          ),
        })),
      };
    } catch (err: any) {
      console.error(`[LaravelApiDataProvider] Failed to get curriculum for ${courseId}:`, err.message);
      return null;
    }
  }

  public async getLessonContent(lessonId: string): Promise<LessonContent | null> {
    try {
      const result = await this.request<{ data: any }>(
        `/api/internal/broadcast/lessons/${encodeURIComponent(lessonId)}/content`
      );
      const raw = (result as any)?.data ?? result;
      if (!raw) return null;

      const resolvedLessonId = String(raw.lessonId ?? lessonId);
      const resolvedChapterId = String(raw.chapterId ?? '1');
      const resolvedLessonTitle = String(raw.lessonTitle || raw.title || 'Lesson');

      let blocks = Array.isArray(raw.blocks)
        ? raw.blocks.map((b: any, idx: number) => ({
            blockId: String(b.blockId || `blk_${resolvedLessonId}_${idx + 1}`),
            type: b.type || 'paragraph',
            title: String(b.title || `Section ${idx + 1}`),
            order: Number(b.order ?? idx + 1),
            content: String(b.content ?? ''),
            formulaLatex: b.formulaLatex,
            svgDiagram: b.svgDiagram,
            calloutType: b.calloutType,
            supportsSendToBoard: b.supportsSendToBoard ?? true,
          }))
        : [];

      if (blocks.length === 0) {
        const rawTopics = Array.isArray(raw.topics) ? raw.topics : [];
        if (raw.description) {
          blocks.push({
            blockId: `blk_les_${resolvedLessonId}_intro`,
            type: 'heading',
            title: resolvedLessonTitle,
            order: 1,
            content: String(raw.description),
            supportsSendToBoard: true,
          });
        }

        for (let i = 0; i < rawTopics.length; i++) {
          const top = rawTopics[i];
          const topId = String(top.topicId ?? top.id ?? i + 1);
          const topTitle = String(top.title || top.topicTitle || `Topic ${i + 1}`);
          const rawHtml = String(top.contentHtml || top.content || top.description || '');
          const cleanText = rawHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

          blocks.push({
            blockId: `blk_topic_${topId}`,
            type: 'paragraph',
            title: topTitle,
            order: blocks.length + 1,
            content: cleanText || topTitle,
            formulaLatex: top.formulaLatex,
            svgDiagram: top.svgDiagram,
            supportsSendToBoard: true,
          });
        }

        if (blocks.length === 0) {
          blocks.push({
            blockId: `blk_les_${resolvedLessonId}_default`,
            type: 'heading',
            title: resolvedLessonTitle,
            order: 1,
            content: resolvedLessonTitle,
            supportsSendToBoard: true,
          });
        }
      }

      return {
        lessonId: resolvedLessonId,
        lessonTitle: resolvedLessonTitle,
        chapterId: resolvedChapterId,
        blocks,
      };
    } catch (err: any) {
      console.error(`[LaravelApiDataProvider] Failed to get content for ${lessonId}:`, err.message);
      return null;
    }
  }

  public async saveCheckpoint(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    const storageProvider = getStorageProvider();
    await storageProvider.saveCheckpoint(sessionId, snapshot);

    try {
      await this.request(`/api/internal/broadcast/sessions/${encodeURIComponent(sessionId)}/checkpoint`, {
        method: 'POST',
        body: JSON.stringify(snapshot),
      });
    } catch (err: any) {
      console.error(`[LaravelApiDataProvider] Failed to save checkpoint for ${sessionId}:`, err.message);
    }
  }

  public async publishSessionCompleted(summary: SessionAttendanceSummary): Promise<void> {
    const storageProvider = getStorageProvider();
    await storageProvider.saveSessionSummary(summary);

    try {
      await this.request(
        `/api/internal/broadcast/sessions/${encodeURIComponent(summary.sessionId)}/auto-complete`,
        {
          method: 'POST',
          body: JSON.stringify(summary),
        }
      );
      console.log(`[LaravelApiDataProvider] Session ${summary.sessionId} summary published to Laravel.`);
    } catch (err: any) {
      console.error(`[LaravelApiDataProvider] Failed to publish session summary:`, err.message);
      throw err;
    }
  }

  /**
   * Publishes finalized session recording artifacts (`video_720p.webm`, `whiteboard.json`),
   * multi-topic timeline offsets, and analytics to `storage_cache/` and Laravel webhook.
   */
  public async publishSessionFinalizedArtifacts(
    summary: SessionFinalizationSummary
  ): Promise<void> {
    const storageProvider = getStorageProvider();
    await storageProvider.putJson(
      `sessions/${summary.sessionId}/session_finalized_artifacts.json`,
      summary
    );

    try {
      await this.request(
        `/api/v1/broadcast/sessions/${encodeURIComponent(summary.sessionId)}/complete`,
        {
          method: 'POST',
          body: JSON.stringify(summary),
        }
      );
    } catch (err: any) {
      console.warn(
        `[LaravelApiDataProvider] Warning posting finalized artifacts to Laravel for ${summary.sessionId}: ${err.message}`
      );
    }
  }
}
