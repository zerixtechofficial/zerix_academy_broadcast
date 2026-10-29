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
import { RoomManager } from '../modules/room/room.manager';

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

  private tokenCache = new Map<string, { user: UserAuthPayload; expiresAt: number }>();
  private userCompletionCache = new Map<
    string,
    { completedLessons: Set<string>; completedTopics: Set<string> }
  >();

  private normalizeUserKey(userId?: string): string {
    if (!userId) return 'anonymous';
    const raw = String(userId).trim();
    const numeric = raw.replace(/^(?:student|teacher|usr|user|cohost)[_-]?/i, '');
    return numeric || raw;
  }

  private getOrCreateUserCompletion(userId?: string): {
    completedLessons: Set<string>;
    completedTopics: Set<string>;
  } {
    const key = this.normalizeUserKey(userId);
    let entry = this.userCompletionCache.get(key);
    if (!entry) {
      entry = { completedLessons: new Set<string>(), completedTopics: new Set<string>() };
      this.userCompletionCache.set(key, entry);
    }
    return entry;
  }

  public async validateToken(token: string, sessionId?: string): Promise<UserAuthPayload | null> {
    if (!token) return null;
    const cleanToken = token.trim();
    if (!cleanToken || cleanToken === 'undefined' || cleanToken === 'null' || cleanToken.startsWith('DEV_TOKEN_')) {
      return null;
    }

    const cacheKey = `${cleanToken}::${sessionId || ''}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.user;
    }

    // Fast-path: Verify HMAC-SHA256 JWT locally when shared secret matches
    if (JwtVerifier.looksLikeJwt(cleanToken)) {
      let verified = JwtVerifier.verify(cleanToken, { expectedSessionId: sessionId });
      if (!verified.valid && verified.reason === 'JWT token has expired') {
        const verifiedIgnoreExp = JwtVerifier.verify(cleanToken, {
          expectedSessionId: sessionId,
          ignoreExpiration: true,
        });
        if (verifiedIgnoreExp.valid && verifiedIgnoreExp.claims) {
          const targetSess = String(sessionId || verifiedIgnoreExp.claims.sessionId || '');
          if (targetSess) {
            try {
              const room = await RoomManager.getOrInitRoom(targetSess);
              // Allow rejoining with a cryptographically valid session JWT while the class has not ended (or when teacher restarts)
              if (
                room.status !== 'ENDED' ||
                verifiedIgnoreExp.claims.role === 'teacher'
              ) {
                verified = verifiedIgnoreExp;
              }
            } catch {
              // Ignore room lookup errors
            }
          }
        }
      }
      if (verified.valid && verified.claims) {
        const claims = verified.claims as any;
        const userPayload: UserAuthPayload = {
          userId: String(claims.userId || claims.sub),
          name: claims.name || (claims.role === 'teacher' ? 'Teacher' : 'Student'),
          role: claims.role === 'teacher' ? 'teacher' : 'student',
          batchId: String(claims.batchId ?? sessionId ?? ''),
          sessionId: String(claims.sessionId || sessionId || ''),
          courseId: claims.courseId ? String(claims.courseId) : undefined,
          languageId: claims.languageId ? String(claims.languageId) : undefined,
          chapterId: claims.chapterId ? String(claims.chapterId) : undefined,
          lessonId: claims.lessonId ? String(claims.lessonId) : undefined,
          topicId: claims.topicId ? String(claims.topicId) : undefined,
          avatar: claims.avatarUrl,
          isCoTeacher: Boolean(claims.isCoTeacher),
          canUseWhiteboard:
            typeof claims.canUseWhiteboard === 'boolean'
              ? claims.canUseWhiteboard
              : claims.role === 'teacher' && !claims.isCoTeacher,
        };
        this.tokenCache.set(cacheKey, { user: userPayload, expiresAt: Date.now() + 60_000 });
        return userPayload;
      }
      // If local JWT verification fails (e.g. secret configured on Laravel side), fall through to Laravel API verification
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
        const userPayload: UserAuthPayload = {
          userId: resolvedUserId,
          name: String(rawUser.name || (rawUser.role === 'teacher' ? 'Teacher' : 'Student')),
          role: rawUser.role === 'teacher' ? 'teacher' : 'student',
          batchId: String(rawUser.batchId ?? sessionId ?? ''),
          sessionId: String(rawUser.sessionId || sessionId || ''),
          courseId: rawUser.courseId ? String(rawUser.courseId) : undefined,
          languageId: rawUser.languageId ? String(rawUser.languageId) : undefined,
          chapterId: rawUser.chapterId ? String(rawUser.chapterId) : undefined,
          lessonId: rawUser.lessonId ? String(rawUser.lessonId) : undefined,
          topicId: rawUser.topicId ? String(rawUser.topicId) : undefined,
          avatar: rawUser.avatar || rawUser.avatarUrl,
          isCoTeacher: Boolean(rawUser.isCoTeacher),
          canUseWhiteboard:
            typeof rawUser.canUseWhiteboard === 'boolean'
              ? rawUser.canUseWhiteboard
              : rawUser.role === 'teacher',
        };
        this.tokenCache.set(cacheKey, { user: userPayload, expiresAt: Date.now() + 60_000 });
        return userPayload;
      }
      return null;
    } catch (err: any) {
      console.error(`[LaravelApiDataProvider] Auth validation error for session ${sessionId}:`, err.message);
      return null;
    }
  }

  public async getSessionContext(sessionId: string, languageId?: string): Promise<SessionContext | null> {
    try {
      const qs = languageId ? `?language_id=${encodeURIComponent(languageId)}` : '';
      const result = await this.request<{ data: any }>(
        `/api/internal/broadcast/sessions/${encodeURIComponent(sessionId)}/context${qs}`
      );
      const raw = (result as any)?.data ?? (result as any);
      if (!raw) return null;

      return {
        sessionId: String(raw.sessionId || sessionId),
        branchId: String(raw.branchId ?? '1'),
        boardId: String(raw.boardId ?? '1'),
        languageId: String(raw.languageId ?? languageId ?? '1'),
        courseId: String(raw.courseId ?? '1'),
        courseName: String(raw.courseName || raw.title || 'Live Course'),
        subjectId: String(raw.subjectId ?? '1'),
        subjectName: raw.subjectName ? String(raw.subjectName) : undefined,
        chapterId: String(raw.chapterId ?? '1'),
        chapterTitle: String(raw.chapterTitle || 'Chapter 1'),
        lessonId: String(raw.lessonId ?? '1'),
        lessonTitle: String(raw.lessonTitle || 'Lesson 1'),
        topicId: String(raw.topicId ?? ''),
        topicTitle: raw.topicTitle ? String(raw.topicTitle) : undefined,
        batchId: String(raw.batchId ?? sessionId),
        batchName: raw.batchName ? String(raw.batchName) : undefined,
        teacherId: String(raw.teacherId ?? '1'),
        teacherName: String(raw.teacherName || 'Instructor'),
        title: String(raw.title || raw.lessonTitle || raw.courseName || 'Live Classroom'),
        startTime: String(raw.startTime || new Date().toISOString()),
        maxStudentMics: Number(raw.maxStudentMics || 10),
        mode: (raw.mode as any) || 'CONTENT',
        status: (raw.status as any) || 'LIVE',
      };
    } catch (err: any) {
      console.error(`[LaravelApiDataProvider] Failed to get session context for ${sessionId}:`, err.message);
      return null;
    }
  }

  public async getCurriculumSidebar(
    courseId: string,
    languageId?: string,
    userId?: string
  ): Promise<CurriculumSidebar | null> {
    try {
      const params = new URLSearchParams();
      if (languageId) params.set('language_id', String(languageId));
      if (userId) params.set('user_id', String(userId));
      const qs = params.toString() ? `?${params.toString()}` : '';
      const result = await this.request<{ data: any }>(
        `/api/internal/broadcast/courses/${encodeURIComponent(courseId)}/curriculum${qs}`
      );
      const raw = (result as any)?.data ?? result;
      if (!raw) return null;

      const userCache = this.getOrCreateUserCompletion(userId);
      if (Array.isArray(raw.completedLessonIds)) {
        for (const id of raw.completedLessonIds) {
          userCache.completedLessons.add(String(id));
        }
      }
      if (Array.isArray(raw.completedTopicIds)) {
        for (const id of raw.completedTopicIds) {
          userCache.completedTopics.add(String(id));
        }
      }

      const rawChapters = Array.isArray(raw.chapters) ? raw.chapters : [];
      return {
        courseId: String(raw.courseId ?? courseId),
        courseName: String(raw.courseName || raw.title || 'Course Curriculum'),
        boardId: String(raw.boardId ?? '1'),
        languageId: String(raw.languageId ?? languageId ?? '1'),
        completedLessonIds: Array.from(userCache.completedLessons),
        completedTopicIds: Array.from(userCache.completedTopics),
        chapters: rawChapters.map((ch: any, chIdx: number) => ({
          chapterId: String(ch.chapterId ?? ch.id ?? chIdx + 1),
          chapterNumber: Number(ch.chapterNumber ?? chIdx + 1),
          title: String(ch.title || ch.chapterTitle || `Chapter ${chIdx + 1}`),
          description: String(ch.description || ''),
          lessons: (Array.isArray(ch.lessons) ? ch.lessons : []).map(
            (les: any, lesIdx: number) => {
              const lesId = String(les.lessonId ?? les.id ?? lesIdx + 1);
              const lesCompleted = Boolean(
                les.isCompleted || userCache.completedLessons.has(lesId)
              );
              if (lesCompleted) {
                userCache.completedLessons.add(lesId);
              }
              return {
                lessonId: lesId,
                lessonNumber: String(les.lessonNumber ?? lesIdx + 1),
                title: String(les.title || les.lessonTitle || `Lesson ${lesIdx + 1}`),
                hasContent: Boolean(
                  les.hasContent || (les.description && String(les.description).trim() !== '')
                ),
                description: les.description ? String(les.description) : undefined,
                isCompleted: lesCompleted,
                topics: (Array.isArray(les.topics) ? les.topics : []).map(
                  (top: any, topIdx: number) => {
                    const topId = String(top.topicId ?? top.id ?? topIdx + 1);
                    const topCompleted = Boolean(
                      top.isCompleted || userCache.completedTopics.has(topId)
                    );
                    if (topCompleted) {
                      userCache.completedTopics.add(topId);
                    }
                    return {
                      topicId: topId,
                      title: String(top.title || top.topicTitle || `Topic ${topIdx + 1}`),
                      level: top.level || 'Foundation',
                      durationMinutes: Number(top.durationMinutes || 15),
                      boardId: String(top.boardId ?? raw.boardId ?? '1'),
                      languageId: String(
                        top.languageId ?? raw.languageId ?? languageId ?? '1'
                      ),
                      isCompleted: topCompleted,
                    };
                  }
                ),
              };
            }
          ),
        })),
      };
    } catch (err: any) {
      console.error(`[LaravelApiDataProvider] Failed to get curriculum for ${courseId}:`, err.message);
      return null;
    }
  }

  public async getLessonContent(
    lessonId: string,
    languageId?: string,
    topicId?: string,
    userId?: string
  ): Promise<LessonContent | null> {
    try {
      const params = new URLSearchParams();
      if (languageId) params.set('language_id', String(languageId));
      if (topicId) params.set('topic_id', String(topicId));
      if (userId) params.set('user_id', String(userId));
      const qs = params.toString() ? `?${params.toString()}` : '';

      const result = await this.request<{ data: any }>(
        `/api/internal/broadcast/lessons/${encodeURIComponent(lessonId)}/content${qs}`
      );
      const raw = (result as any)?.data ?? result;
      if (!raw) return null;

      const userCache = this.getOrCreateUserCompletion(userId);
      const resolvedLessonId = String(raw.lessonId ?? lessonId);
      const resolvedChapterId = String(raw.chapterId ?? '1');
      const resolvedLessonTitle = String(raw.lessonTitle || raw.title || 'Lesson');
      const resolvedLessonHtml = raw.contentHtml || raw.description ? String(raw.contentHtml || raw.description) : undefined;
      const isLessonCompleted = Boolean(
        raw.isCompleted || userCache.completedLessons.has(resolvedLessonId)
      );
      if (isLessonCompleted) {
        userCache.completedLessons.add(resolvedLessonId);
      }

      const lessonBlocks = Array.isArray(raw.lessonBlocks)
        ? raw.lessonBlocks.map((b: any, idx: number) => ({
            blockId: String(b.blockId || `blk_les_${resolvedLessonId}_${idx + 1}`),
            topicId: undefined,
            topicTitle: undefined,
            type: b.type || 'paragraph',
            title: String(b.title || resolvedLessonTitle),
            order: Number(b.order ?? idx + 1),
            content: String(b.content ?? ''),
            contentHtml: b.contentHtml ? String(b.contentHtml) : undefined,
            formulaLatex: b.formulaLatex,
            svgDiagram: b.svgDiagram,
            calloutType: b.calloutType,
            supportsSendToBoard: b.supportsSendToBoard ?? true,
          }))
        : resolvedLessonHtml
        ? [
            {
              blockId: `blk_les_${resolvedLessonId}_intro`,
              topicId: undefined,
              topicTitle: undefined,
              type: 'paragraph' as const,
              title: resolvedLessonTitle,
              order: 1,
              content: resolvedLessonHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
              contentHtml: resolvedLessonHtml,
              formulaLatex: undefined,
              svgDiagram: undefined,
              calloutType: undefined,
              supportsSendToBoard: true,
            },
          ]
        : [];

      const rawTopics = Array.isArray(raw.topics) ? raw.topics : [];
      const topics = rawTopics.map((top: any, topIdx: number) => {
        const topId = String(top.topicId ?? top.id ?? topIdx + 1);
        const topCompleted = Boolean(top.isCompleted || userCache.completedTopics.has(topId));
        if (topCompleted) {
          userCache.completedTopics.add(topId);
        }
        return {
          topicId: topId,
          title: String(top.title || top.topicTitle || `Topic ${topIdx + 1}`),
          contentHtml: top.contentHtml ? String(top.contentHtml) : undefined,
          isCompleted: topCompleted,
          blocks: Array.isArray(top.blocks)
            ? top.blocks.map((b: any, idx: number) => ({
                blockId: String(b.blockId || `blk_topic_${top.topicId ?? topIdx + 1}_${idx + 1}`),
                topicId: String(b.topicId ?? top.topicId ?? top.id ?? topIdx + 1),
                topicTitle: String(b.topicTitle || top.title || top.topicTitle || `Topic ${topIdx + 1}`),
                type: b.type || 'paragraph',
                title: String(b.title || top.title || `Section ${idx + 1}`),
                order: Number(b.order ?? idx + 1),
                content: String(b.content ?? ''),
                contentHtml: b.contentHtml ? String(b.contentHtml) : undefined,
                formulaLatex: b.formulaLatex,
                svgDiagram: b.svgDiagram,
                calloutType: b.calloutType,
                supportsSendToBoard: b.supportsSendToBoard ?? true,
              }))
            : undefined,
        };
      });

      let blocks = Array.isArray(raw.blocks)
        ? raw.blocks.map((b: any, idx: number) => ({
            blockId: String(b.blockId || `blk_${resolvedLessonId}_${idx + 1}`),
            topicId: b.topicId ? String(b.topicId) : undefined,
            topicTitle: b.topicTitle ? String(b.topicTitle) : undefined,
            type: b.type || 'paragraph',
            title: String(b.title || `Section ${idx + 1}`),
            order: Number(b.order ?? idx + 1),
            content: String(b.content ?? ''),
            contentHtml: b.contentHtml ? String(b.contentHtml) : undefined,
            formulaLatex: b.formulaLatex,
            svgDiagram: b.svgDiagram,
            calloutType: b.calloutType,
            supportsSendToBoard: b.supportsSendToBoard ?? true,
          }))
        : [];

      if (blocks.length === 0) {
        if (raw.description) {
          blocks.push({
            blockId: `blk_les_${resolvedLessonId}_intro`,
            topicId: undefined,
            topicTitle: undefined,
            type: 'heading',
            title: resolvedLessonTitle,
            order: 1,
            content: String(raw.description),
            contentHtml: String(raw.description),
            formulaLatex: undefined,
            svgDiagram: undefined,
            calloutType: undefined,
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
            topicId: topId,
            topicTitle: topTitle,
            type: 'paragraph',
            title: topTitle,
            order: blocks.length + 1,
            content: cleanText || topTitle,
            contentHtml: rawHtml || undefined,
            formulaLatex: top.formulaLatex,
            svgDiagram: top.svgDiagram,
            calloutType: undefined,
            supportsSendToBoard: true,
          });
        }

        if (blocks.length === 0) {
          blocks.push({
            blockId: `blk_les_${resolvedLessonId}_default`,
            topicId: topics[0]?.topicId,
            topicTitle: topics[0]?.title,
            type: 'heading',
            title: resolvedLessonTitle,
            order: 1,
            content: resolvedLessonTitle,
            contentHtml: undefined,
            formulaLatex: undefined,
            svgDiagram: undefined,
            calloutType: undefined,
            supportsSendToBoard: true,
          });
        }
      }

      return {
        lessonId: resolvedLessonId,
        lessonTitle: resolvedLessonTitle,
        chapterId: resolvedChapterId,
        languageId: String(raw.languageId ?? languageId ?? '1'),
        description: resolvedLessonHtml,
        contentHtml: resolvedLessonHtml,
        isCompleted: isLessonCompleted,
        lessonBlocks,
        topics,
        blocks,
      };
    } catch (err: any) {
      console.error(`[LaravelApiDataProvider] Failed to get content for ${lessonId}:`, err.message);
      return null;
    }
  }

  public async markContentComplete(
    contentId: string,
    payload: {
      type: 'lesson' | 'topic';
      userId: string;
      role?: string;
      courseId?: string;
      sessionId?: string;
    }
  ): Promise<any> {
    const cleanId = String(contentId).trim();
    const userCache = this.getOrCreateUserCompletion(payload.userId);
    if (payload.type === 'lesson') {
      userCache.completedLessons.add(cleanId);
    } else {
      userCache.completedTopics.add(cleanId);
    }

    try {
      const result = await this.request<{ data?: any }>(
        `/api/internal/broadcast/content/${encodeURIComponent(cleanId)}/complete`,
        {
          method: 'POST',
          body: JSON.stringify({
            type: payload.type,
            user_id: payload.userId,
            userId: payload.userId,
            role: payload.role,
            course_id: payload.courseId,
            courseId: payload.courseId,
            session_id: payload.sessionId,
            sessionId: payload.sessionId,
          }),
        }
      );
      const rawData = (result as any)?.data ?? result;
      return {
        contentId: cleanId,
        type: payload.type,
        userId: payload.userId,
        role: payload.role,
        isCompleted: true,
        completedAt: rawData?.completed_at || new Date().toISOString(),
        completedLessons: Array.from(userCache.completedLessons),
        completedTopics: Array.from(userCache.completedTopics),
        progress: rawData,
      };
    } catch (err: any) {
      console.warn(
        `[LaravelApiDataProvider] markContentComplete fallback for ${payload.type} ${cleanId} (user ${payload.userId}): ${err.message}`
      );
      return {
        contentId: cleanId,
        type: payload.type,
        userId: payload.userId,
        role: payload.role,
        isCompleted: true,
        completedAt: new Date().toISOString(),
        completedLessons: Array.from(userCache.completedLessons),
        completedTopics: Array.from(userCache.completedTopics),
      };
    }
  }

  public async getCourseProgress(
    courseId: string,
    userId: string
  ): Promise<{
    completedLessons: string[];
    completedTopics: string[];
    lessons: Record<string, any>;
    topics: Record<string, any>;
  }> {
    const userCache = this.getOrCreateUserCompletion(userId);
    try {
      const qs = `?user_id=${encodeURIComponent(userId)}`;
      const result = await this.request<{ data?: any }>(
        `/api/internal/broadcast/courses/${encodeURIComponent(courseId)}/progress${qs}`
      );
      const raw = (result as any)?.data ?? result ?? {};
      const lessonsList: string[] = Array.isArray(raw.completed_lessons)
        ? raw.completed_lessons.map((id: any) => String(id))
        : [];
      const topicsList: string[] = Array.isArray(raw.completed_topics)
        ? raw.completed_topics.map((id: any) => String(id))
        : [];

      for (const id of lessonsList) userCache.completedLessons.add(id);
      for (const id of topicsList) userCache.completedTopics.add(id);

      return {
        completedLessons: Array.from(userCache.completedLessons),
        completedTopics: Array.from(userCache.completedTopics),
        lessons: raw.lessons || {},
        topics: raw.topics || {},
      };
    } catch {
      return {
        completedLessons: Array.from(userCache.completedLessons),
        completedTopics: Array.from(userCache.completedTopics),
        lessons: {},
        topics: {},
      };
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

    const relCtx = summary.relationalContext || ({} as any);
    const taughtSegments = (summary.publishedLessonArtifacts || summary.taughtArtifacts || []).map(
      (item) => ({
        chapterId: item.relationalContext?.chapterId,
        chapterNumber: item.relationalContext?.chapterNumber,
        chapterTitle: item.relationalContext?.chapterTitle,
        lessonId: item.relationalContext?.lessonId,
        lessonNumber: item.relationalContext?.lessonNumber,
        lessonTitle: item.relationalContext?.lessonTitle,
        topicId: item.relationalContext?.topicId,
        topicTitle: item.relationalContext?.topicTitle,
        mode: item.mode || 'taught',
        videoRelativePath: item.videoRelativePath,
        videoPublicUrl: item.videoPublicUrl,
        videoMimeType: item.videoMimeType,
        videoSizeBytes: item.videoSizeBytes,
        durationSec: item.videoDurationSeconds,
        startOffsetSec: item.videoStartOffsetSec,
        endOffsetSec: item.videoEndOffsetSec,
        whiteboardGzipRelativePath: item.whiteboardGzipRelativePath,
        whiteboardPublicUrl: item.whiteboardPublicUrl,
        whiteboardPagesCount: item.whiteboardPageCount,
        whiteboardElementsCount: item.whiteboardElementCount,
        timelineMarkers: item.timelineMarkers,
        relationalContext: item.relationalContext,
      })
    );

    const laravelPayload = {
      ...summary,
      courseId: relCtx.courseId,
      linkedVodCourseId: relCtx.linkedVodCourseId,
      languageId: relCtx.languageId,
      boardId: relCtx.boardId,
      version: relCtx.version,
      academicYear: relCtx.academicYear,
      publishToVodCourse: relCtx.publishToVodCourse ?? true,
      isPrimaryVod: relCtx.isPrimaryVod ?? true,
      recording_url: summary.sessionVideoRelativePath,
      sessionVideo: {
        relativePath: summary.sessionVideoRelativePath,
        publicUrl: summary.sessionVideoPublicUrl,
        mimeType: summary.videoMimeType,
        sizeBytes: summary.videoSizeBytes,
        durationSeconds: summary.videoDurationSeconds,
        storageDriver: summary.storageDriver,
      },
      taughtSegments,
      referenceOnlySegments: summary.referenceSegments || summary.skippedReferenceLessons || [],
    };

    try {
      await this.request(
        `/api/v1/broadcast/sessions/${encodeURIComponent(summary.sessionId)}/complete`,
        {
          method: 'POST',
          body: JSON.stringify(laravelPayload),
        }
      );
    } catch (err: any) {
      console.warn(
        `[LaravelApiDataProvider] Warning posting finalized artifacts to Laravel for ${summary.sessionId}: ${err.message}`
      );
    }
  }
}
