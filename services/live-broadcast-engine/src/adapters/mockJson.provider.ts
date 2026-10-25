import * as path from 'path';
import * as fs from 'fs';
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
import { FileCache } from '../utils/fileCache';
import { JwtVerifier } from '../utils/jwtVerifier';
import { getStorageProvider } from './storage.provider';

export class MockJsonDataProvider implements IDataProvider {
  public readonly mode = 'mock_json' as const;

  private mockDataDir: string;
  private storageDir: string;

  constructor(mockDataDir?: string, storageDir?: string) {
    this.mockDataDir =
      mockDataDir ||
      path.resolve(__dirname, '../../mock-data');
    this.storageDir =
      storageDir ||
      path.resolve(__dirname, '../../../../storage');
  }

  private getFilePath(filename: string): string {
    return path.join(this.mockDataDir, filename);
  }

  public async validateToken(token: string, sessionId?: string): Promise<UserAuthPayload | null> {
    if (!token) return null;
    const cleanToken = token.trim();

    // 0. Fast-Path Zero-DB HMAC-SHA256 JWT Verification (< 0.05ms for 1,000+ concurrent joins)
    if (JwtVerifier.looksLikeJwt(cleanToken)) {
      const verified = JwtVerifier.verify(cleanToken, { expectedSessionId: sessionId });
      if (verified.valid && verified.claims) {
        const claims = verified.claims;
        return {
          userId: String(claims.userId || claims.sub),
          name: claims.name || (claims.role === 'teacher' ? 'Teacher' : 'Student'),
          role: claims.role === 'teacher' ? 'teacher' : 'student',
          batchId: String(claims.batchId || sessionId || 'batch_physics_101'),
          sessionId: String(claims.sessionId || sessionId || 'batch_physics_101'),
          avatar: claims.avatarUrl,
          isCoTeacher: Boolean((claims as any).isCoTeacher),
          canUseWhiteboard:
            typeof claims.canUseWhiteboard === 'boolean'
              ? claims.canUseWhiteboard
              : claims.role === 'teacher' && !(claims as any).isCoTeacher,
        };
      }
      // If a real 3-part JWT fails cryptographic signature, expiration, or sessionId binding, reject immediately
      return null;
    }

    // Reject any dotted token that is not a valid 3-part HMAC-verified JWT (blocks 2-part base64 bypasses)
    if (cleanToken.includes('.')) {
      return null;
    }

    // Disallow static dev tokens when running in production or when explicitly disabled
    if (process.env.NODE_ENV === 'production' || process.env.ALLOW_DEV_TOKENS === 'false') {
      return null;
    }

    const devTokensData = await FileCache.readJson<any>(this.getFilePath('dev-tokens.json'));
    const teacher = devTokensData.teacher;
    const coTeachers = (devTokensData.coTeachers || []) as any[];
    const students = devTokensData.students as any[];

    // 1. Direct Teacher Token / ID Match
    if (
      cleanToken === teacher.token ||
      cleanToken === teacher.jwt ||
      cleanToken === teacher.userId ||
      cleanToken === 'teacher'
    ) {
      return {
        userId: teacher.userId,
        name: teacher.name,
        role: 'teacher',
        batchId: sessionId || 'batch_physics_101',
        sessionId: sessionId || 'batch_physics_101',
        email: teacher.email,
        avatar: teacher.avatar,
      };
    }

    // 1b. Co-Teacher Token / ID Match
    for (const coTeacher of coTeachers) {
      if (
        cleanToken === coTeacher.token ||
        cleanToken === coTeacher.userId ||
        cleanToken === `DEV_TOKEN_TEACHER_${coTeacher.userId.replace(/^teacher_/, '')}`
      ) {
        return {
          userId: coTeacher.userId,
          name: coTeacher.name,
          role: 'teacher',
          batchId: sessionId || 'batch_physics_101',
          sessionId: sessionId || 'batch_physics_101',
          email: coTeacher.email,
          avatar: coTeacher.avatar,
          isCoTeacher: true,
        };
      }
    }
    if (cleanToken.startsWith('DEV_TOKEN_TEACHER_') || cleanToken.startsWith('teacher_')) {
      const suffix = cleanToken.replace(/^DEV_TOKEN_TEACHER_/, '').replace(/^teacher_/, '');
      return {
        userId: `teacher_${suffix}`,
        name: suffix === '501' ? 'Prof. Anand Sharma' : `Co-Teacher #${suffix}`,
        role: 'teacher',
        batchId: sessionId || 'batch_physics_101',
        sessionId: sessionId || 'batch_physics_101',
        isCoTeacher: suffix !== '501',
      };
    }

    // 2. Direct Student Token / ID Match
    for (const student of students) {
      if (
        cleanToken === student.token ||
        cleanToken === student.jwt ||
        cleanToken === student.userId ||
        cleanToken === `student_${student.userId.replace('student_', '')}`
      ) {
        return {
          userId: student.userId,
          name: student.name,
          role: 'student',
          batchId: sessionId || 'batch_physics_101',
          sessionId: sessionId || 'batch_physics_101',
          email: student.email,
          avatar: student.avatar,
          rollNumber: student.rollNumber,
        };
      }
    }

    // 3. Fallback for query params like "101" or "student_101"
    const matchedById = students.find(
      (s) => s.userId === cleanToken || s.userId === `student_${cleanToken}`
    );
    if (matchedById) {
      return {
        userId: matchedById.userId,
        name: matchedById.name,
        role: 'student',
        batchId: sessionId || 'batch_physics_101',
        sessionId: sessionId || 'batch_physics_101',
        email: matchedById.email,
        avatar: matchedById.avatar,
        rollNumber: matchedById.rollNumber,
      };
    }

    return null;
  }

  public async getSessionContext(sessionId: string): Promise<SessionContext | null> {
    try {
      const data = await FileCache.readJson<any>(this.getFilePath('session-context.json'));
      const session = data.sessions?.[sessionId];
      if (session) {
        return session as SessionContext;
      }

      // If active session exists, use it as template
      const defaultSession = data.sessions?.[data.activeSessionId];
      if (defaultSession) {
        return {
          ...defaultSession,
          sessionId,
          batchId: sessionId,
        } as SessionContext;
      }

      return null;
    } catch (err) {
      console.error('[MockJsonDataProvider] Error reading session-context.json:', err);
      return null;
    }
  }

  public async getCurriculumSidebar(courseId: string): Promise<CurriculumSidebar | null> {
    try {
      const data = await FileCache.readJson<CurriculumSidebar>(
        this.getFilePath('curriculum-sidebar.json')
      );
      return data;
    } catch (err) {
      console.error('[MockJsonDataProvider] Error reading curriculum-sidebar.json:', err);
      return null;
    }
  }

  public async getLessonContent(lessonId: string): Promise<LessonContent | null> {
    try {
      const data = await FileCache.readJson<Record<string, LessonContent>>(
        this.getFilePath('lesson-contents.json')
      );
      if (data[lessonId]) {
        return data[lessonId];
      }
      // Return first available lesson if exact ID not found
      const firstKey = Object.keys(data)[0];
      return data[firstKey] || null;
    } catch (err) {
      console.error('[MockJsonDataProvider] Error reading lesson-contents.json:', err);
      return null;
    }
  }

  public async saveCheckpoint(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    // 1. Write to unified Cloud-Agnostic StorageProvider (storage_cache/ mirror + R2/S3 when enabled)
    const storageProvider = getStorageProvider();
    await storageProvider.saveCheckpoint(sessionId, snapshot);

    // 2. Maintain backward-compatible local-r2 files so existing standalone scripts/tests never break
    const latestPath = path.join(
      this.storageDir,
      `local-r2/sessions/${sessionId}/autosave_latest.json`
    );
    const checkpointsDir = path.join(
      this.storageDir,
      `local-r2/sessions/${sessionId}/checkpoints`
    );
    const historyPath = path.join(checkpointsDir, `checkpoint_${Date.now()}.json`);
    const serialized = JSON.stringify(snapshot, null, 2);

    await FileCache.writeJson(latestPath, snapshot, serialized);
    await FileCache.writeJson(historyPath, snapshot, serialized);

    // Prune older local-r2 checkpoints (retain at most 3 per session)
    try {
      if (fs.existsSync(checkpointsDir)) {
        const files = (await fs.promises.readdir(checkpointsDir))
          .filter((f) => f.startsWith('checkpoint_') && f.endsWith('.json'))
          .sort();
        if (files.length > 3) {
          for (const file of files.slice(0, files.length - 3)) {
            const fullPath = path.join(checkpointsDir, file);
            FileCache.invalidate(fullPath);
            await fs.promises.unlink(fullPath).catch(() => {});
          }
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  public async publishSessionCompleted(summary: SessionAttendanceSummary): Promise<void> {
    // 1. Write to unified Cloud-Agnostic StorageProvider (storage_cache/ mirror + R2/S3 when enabled)
    const storageProvider = getStorageProvider();
    await storageProvider.saveSessionSummary(summary);

    // 2. Maintain backward-compatible local-r2 & webhook summary files
    const sessionR2Path = path.join(
      this.storageDir,
      `local-r2/sessions/${summary.sessionId}/session_completed_summary.json`
    );
    await FileCache.writeJson(sessionR2Path, summary);

    const summariesWebhookPath = path.join(
      this.storageDir,
      'local-webhooks/session-summaries.json'
    );

    let allSummaries: SessionAttendanceSummary[] = [];
    try {
      if (fs.existsSync(summariesWebhookPath)) {
        allSummaries = await FileCache.readJson<SessionAttendanceSummary[]>(summariesWebhookPath);
      }
    } catch {
      allSummaries = [];
    }

    // Upsert session summary
    const index = allSummaries.findIndex((s) => s.sessionId === summary.sessionId);
    if (index >= 0) {
      allSummaries[index] = summary;
    } else {
      allSummaries.push(summary);
    }

    await FileCache.writeJson(summariesWebhookPath, allSummaries);
    console.log(`[MockJsonDataProvider] Successfully published session ${summary.sessionId} summary.`);
  }

  /**
   * Persists finalized session recording metadata, multi-topic teaching segments,
   * and VOD artifact paths (`video_720p.webm`, `whiteboard.json`) to `storage_cache/` and `mock-data/`.
   */
  public async publishSessionFinalizedArtifacts(
    summary: SessionFinalizationSummary
  ): Promise<void> {
    const storageProvider = getStorageProvider();
    await storageProvider.putJson(
      `sessions/${summary.sessionId}/session_finalized_artifacts.json`,
      summary
    );

    const mockSummaryPath = this.getFilePath('session_completed_summary.json');
    let existingList: SessionFinalizationSummary[] = [];
    try {
      if (fs.existsSync(mockSummaryPath)) {
        const parsed = await FileCache.readJson<any>(mockSummaryPath);
        existingList = Array.isArray(parsed) ? parsed : [parsed];
      }
    } catch {
      existingList = [];
    }

    const idx = existingList.findIndex((item) => item && item.sessionId === summary.sessionId);
    if (idx >= 0) {
      existingList[idx] = summary;
    } else {
      existingList.push(summary);
    }

    await FileCache.writeJson(mockSummaryPath, existingList);
  }
}
