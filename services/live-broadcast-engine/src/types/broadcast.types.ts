export type UserRole = 'teacher' | 'student';

export interface UserAuthPayload {
  userId: string;
  name: string;
  role: UserRole;
  batchId: string;
  sessionId: string;
  email?: string;
  avatar?: string;
  rollNumber?: string;
  isCoTeacher?: boolean;
  canUseWhiteboard?: boolean;
}

export type BroadcastMode = 'CONTENT' | 'WHITEBOARD' | 'ROUGH_PAD';

export type SessionStatus = 'LIVE' | 'TEACHER_RECONNECTING' | 'ENDED' | 'SCHEDULED';

export interface SessionContext {
  sessionId: string;
  branchId: string;
  boardId: string;
  languageId: string;
  courseId: string;
  courseName?: string;
  subjectId: string;
  subjectName?: string;
  chapterId: string;
  chapterTitle?: string;
  lessonId: string;
  lessonTitle?: string;
  topicId: string;
  topicTitle?: string;
  batchId: string;
  batchName?: string;
  teacherId: string;
  teacherName: string;
  title: string;
  startTime: string;
  maxStudentMics: number;
  mode: BroadcastMode;
  status: SessionStatus;
}

export interface TopicItem {
  topicId: string;
  title: string;
  level: 'Foundation' | 'Growth' | 'Mastery';
  durationMinutes: number;
  boardId: string;
  languageId: string;
}

export interface LessonItem {
  lessonId: string;
  lessonNumber: string;
  title: string;
  topics: TopicItem[];
}

export interface ChapterItem {
  chapterId: string;
  chapterNumber: number;
  title: string;
  description: string;
  lessons: LessonItem[];
}

export interface CurriculumSidebar {
  courseId: string;
  courseName: string;
  boardId: string;
  languageId: string;
  chapters: ChapterItem[];
}

export type ContentBlockType = 'heading' | 'paragraph' | 'callout' | 'formula' | 'diagram';

export interface ContentBlock {
  blockId: string;
  type: ContentBlockType;
  title: string;
  order: number;
  content?: string;
  formulaLatex?: string;
  svgDiagram?: string;
  calloutType?: 'info' | 'warning' | 'danger' | 'success';
  supportsSendToBoard?: boolean;
}

export interface LessonContent {
  lessonId: string;
  lessonTitle: string;
  chapterId: string;
  blocks: ContentBlock[];
}

export interface TeacherCam {
  Cx: number;
  Cy: number;
  Zt: number;
  Wt: number;
  Ht: number;
  authorId?: string;
  authorName?: string;
  updatedAt?: number;
}

export interface LaserPointerState {
  x: number;
  y: number;
  active: boolean;
  blockId?: string;
  tokenId?: string;
  rx?: number;
  ry?: number;
  regionId?: string;
  regionRx?: number;
  regionRy?: number;
  authorId?: string;
  authorName?: string;
  updatedAt?: number;
}

export interface WhiteboardCursorState {
  Lx: number;
  Ly: number;
  tool?: 'pointer' | 'laser';
  button?: 'up' | 'down';
  active: boolean;
  teacherName?: string;
  userId?: string;
  role?: UserRole;
  updatedAt?: number;
}

export interface ContentStrokePoint {
  x: number;
  y: number;
  pressure?: number;
  tokenId?: string;
  rx?: number;
  ry?: number;
  regionId?: string;
  regionRx?: number;
  regionRy?: number;
}

export interface ContentStroke {
  id: string;
  blockId: string;
  color: string;
  size?: number;
  width?: number;
  tool?: 'pen' | 'highlighter';
  opacity?: number;
  anchorTokens?: string[];
  points: ContentStrokePoint[];
  timestamp?: number;
  seqId?: number;
}

export interface ContentSyncState {
  sessionId: string;
  activeLessonId: string;
  activeTopicId: string;
  activeBlockId: string;
  blockOffsetRatio: number;
  scrollAuthorId?: string;
  scrollUpdatedAt?: number;
  penStrokes: ContentStroke[];
  laserPointer: LaserPointerState;
}

export interface BroadcastPacket<T = any> {
  seqId: number;
  type: string;
  timestamp: number;
  payload: T;
}

export interface RaisedHandEntry {
  userId: string;
  name: string;
  avatar?: string;
  rollNumber?: string;
  raisedAt: number;
  deviceId?: string;
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
  activeStudentMics: string[];
  raisedHands: RaisedHandEntry[];
  maxStudentMics: number;
  teacherMicActive?: boolean;
  invitedTeachers?: InvitedTeacherEntry[];
  whiteboardEditors?: string[];
  allowStudentUnmute?: boolean;
  multiDeviceStudents?: string[];
}

export interface SessionSnapshot {
  sessionId: string;
  seqId: number;
  mode: BroadcastMode;
  status: SessionStatus;
  sessionContext: SessionContext;
  teacherCam: TeacherCam;
  whiteboardCursor?: WhiteboardCursorState;
  excalidrawElements: any[];
  excalidrawFiles?: Record<string, any>;
  contentState: ContentSyncState;
  audioStage: AudioStageState;
  lastSavedAt: number;
}

// ============================================================================
// PHASE 1: RELATIONAL LARAVEL MAPPING, CONTINUOUS 720p SESSION VIDEO,
// MULTI-TOPIC TIMELINE SEGMENTS & GZIP WHITEBOARD ARTIFACT TYPES
// ============================================================================

export type RoomMode = BroadcastMode;

/**
 * Supported live broadcast context types across all academic, competitive exam,
 * test series, current affairs, and skill verticals.
 */
export type RelationalContextType =
  | 'course_lesson'
  | 'curriculum_lesson'
  | 'mock_test_solution'
  | 'pyq_solution'
  | 'current_affairs'
  | 'demo_masterclass'
  | 'doubt_session';

/**
 * Complete relational hierarchy mapping a live broadcast session and its
 * recorded artifacts to Zerix Academy's organizational, batch, course,
 * competitive exam, and curriculum structure.
 */
export interface RelationalLessonContext {
  sessionId: string;
  liveClassSessionId?: number | null;
  contextType?: RelationalContextType;
  branchId: number;                  // e.g., 4 (Muzaffarpur / Bihar Branch)
  batchId: number;                   // e.g., 105 (Evening 5 PM Live Batch)
  programId?: number | null;
  boardId: number | null;            // e.g., 2 (BSEB / CBSE / NULL for Competitive or Skill Courses)
  examId?: number | null;            // e.g., 14 (SSC CGL / NEET / JEE / Banking / CA)
  languageId: number;                // e.g., 1 (Hindi / English / Bilingual)
  courseId: number;                  // e.g., 12 (Master Live Course ID)
  linkedVodCourseId: number | null;  // e.g., 212 (Auto-linked Sellable Recorded VOD Course ID)
  subjectId: number;
  learningStageId?: number | null;
  chapterId: number;
  chapterNumber: number;
  chapterTitle: string;
  lessonId: number;
  lessonNumber: string;              // Supports delta insertions like "2", "2.1", "2.2"
  lessonTitle: string;
  topicId: number | null;
  topicTitle?: string;
  assessmentId?: number | null;      // Populated when solving a Mock Test / PYQ paper live
  teacherId: number;
  academicYear: number;              // e.g., 2026
  version: number;                   // e.g., 1 (v1), 2 (v2 re-recorded upgrade)
  publishToVodCourse: boolean;       // If true, auto-publishes to the sellable VOD course
  isPrimaryVod: boolean;             // Marks this recording as the active version in VOD course
}

/**
 * Tracks a single curriculum navigation segment during a continuous live session.
 * Distinguishes between topics actually taught vs. lessons opened briefly for reference
 * so reference-only opens never overwrite an existing lesson's primary recording or whiteboard.
 */
export interface SessionTopicSegment {
  segmentIndex: number;
  chapterId: number;
  chapterNumber: number;
  chapterTitle: string;
  lessonId: number;
  lessonNumber: string;
  lessonTitle: string;
  topicId: number | null;
  topicTitle?: string;
  startOffsetSec: number;            // Exact second offset in session video_720p.webm where segment began
  endOffsetSec: number | null;       // Exact second offset in session video_720p.webm where segment ended
  durationSec: number;               // Elapsed seconds spent on this topic/lesson
  whiteboardModified: boolean;       // True ONLY if teacher added/modified Excalidraw whiteboard elements
  whiteboardPagesCount: number;
  whiteboardElementsCount: number;
  mode: 'taught' | 'reference_only'; // 'reference_only' protects old lessons from being overwritten
}

/**
 * Timestamped bookmark within the continuous session video allowing 1-click seeking
 * to specific Whiteboard pages, sub-topics, or reference explanations in `/learn`.
 */
export interface TimelineMarker {
  timeSec: number;
  label: string;
  markerType: 'topic_start' | 'whiteboard_page' | 'reference_open' | 'bookmark';
  chapterId?: number;
  lessonId?: number;
  topicId?: number | null;
  pageId?: string;
  pageNumber?: number;
}

/**
 * Represents a single page/slide in the Teacher's multi-page Whiteboard explanation.
 */
export interface WhiteboardPageState {
  pageId: string;
  pageNumber: number;
  title?: string;
  elements: any[];
  appState?: Record<string, any>;
  files?: Record<string, any>;
  updatedAt: number;
}

/**
 * Strictly persisted Whiteboard JSON artifact (`whiteboard.json`, compressed with gzip).
 * NOTE: Content Mode pen/laser strokes are ephemeral and are NEVER included in this artifact.
 */
export interface ExcalidrawWhiteboardArtifact {
  schemaVersion: number;
  sessionId: string;
  relationalContext: RelationalLessonContext;
  elements: any[];
  appState: Record<string, any>;
  files: Record<string, any>;
  pages: WhiteboardPageState[];
  timelineMarkers: TimelineMarker[];
  savedAt: string;
}

/**
 * Comprehensive broadcast timing and engagement analytics captured per session.
 */
export interface SessionAnalyticsMetrics {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  totalDurationSeconds: number;
  whiteboardModeSeconds: number;
  contentModeSeconds: number;
  peakConcurrentUsers: number;
  avgConcurrentUsers: number;
  totalUniqueStudents: number;
  totalChunksUploaded: number;
  totalVideoBytes: number;
  whiteboardPagesCount: number;
  topicsCovered: SessionTopicSegment[];
  timelineMarkers: TimelineMarker[];
}

/**
 * Recorded artifact descriptor produced for each taught topic/lesson when a session finalizes.
 */
export interface FinalizedLessonArtifactRecord {
  sessionId: string;
  liveClassSessionId?: number | null;
  contextType: RelationalContextType;
  relationalContext: RelationalLessonContext;
  videoRelativePath: string;
  videoPublicUrl: string;
  videoMimeType: string;
  videoSizeBytes: number;
  videoDurationSeconds: number;
  videoStartOffsetSec: number;
  videoEndOffsetSec: number;
  whiteboardGzipRelativePath: string | null;
  whiteboardPublicUrl: string | null;
  whiteboardPageCount: number;
  whiteboardElementCount: number;
  storageDriver: 'local_disk' | 'cloudflare_r2' | 'aws_s3';
  timelineMarkers: TimelineMarker[];
  mode: 'taught' | 'reference_only';
  publishToVodCourse: boolean;
  isPrimaryVod: boolean;
  recordedAt: string;
}

/**
 * Complete payload returned when a live broadcast session is finalized.
 */
export interface SessionFinalizationSummary {
  sessionId: string;
  relationalContext?: RelationalLessonContext;
  sessionVideoRelativePath: string;
  sessionVideoPublicUrl: string;
  videoMimeType: string;
  videoSizeBytes: number;
  videoDurationSeconds: number;
  storageDriver: 'local_disk' | 'cloudflare_r2' | 'aws_s3';
  taughtArtifacts: FinalizedLessonArtifactRecord[];
  publishedLessonArtifacts: FinalizedLessonArtifactRecord[];
  referenceSegments: SessionTopicSegment[];
  skippedReferenceLessons: SessionTopicSegment[];
  analytics: SessionAnalyticsMetrics;
  finalizedAt: string;
}
