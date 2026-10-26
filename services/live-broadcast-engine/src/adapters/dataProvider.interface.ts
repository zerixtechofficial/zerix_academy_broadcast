import {
  SessionContext,
  CurriculumSidebar,
  LessonContent,
  UserAuthPayload,
  SessionSnapshot,
  SessionFinalizationSummary,
} from '../types/broadcast.types';
import { SessionAttendanceSummary } from '../types/attendance.types';

export interface IDataProvider {
  readonly mode: 'laravel_api';

  /**
   * Validate incoming classroom JWT token
   */
  validateToken(token: string, sessionId?: string): Promise<UserAuthPayload | null>;

  /**
   * Resolve session relational metadata
   */
  getSessionContext(sessionId: string, languageId?: string): Promise<SessionContext | null>;

  /**
   * Fetch curriculum hierarchy (Chapters -> Lessons -> Topics)
   */
  getCurriculumSidebar(courseId: string, languageId?: string): Promise<CurriculumSidebar | null>;

  /**
   * Fetch 800px virtual stage blocks for a specific lesson (and optional topic/language)
   */
  getLessonContent(
    lessonId: string,
    languageId?: string,
    topicId?: string
  ): Promise<LessonContent | null>;

  /**
   * Persist room checkpoint (R2 or local disk fallback)
   */
  saveCheckpoint(sessionId: string, snapshot: SessionSnapshot): Promise<void>;

  /**
   * Publish finalized attendance and session metrics on session end or grace timeout
   */
  publishSessionCompleted(summary: SessionAttendanceSummary): Promise<void>;

  /**
   * Publish finalized session recording artifacts (`video_720p.webm`, `whiteboard.json`),
   * multi-topic timeline offsets, and analytics to Laravel / Mock JSON storage.
   */
  publishSessionFinalizedArtifacts?(summary: SessionFinalizationSummary): Promise<void>;
}
