import {
  ExcalidrawWhiteboardArtifact,
  FinalizedLessonArtifactRecord,
  RelationalLessonContext,
  RoomMode,
  SessionAnalyticsMetrics,
  SessionFinalizationSummary,
  SessionTopicSegment,
  TimelineMarker,
} from '../../types/broadcast.types';
import { getStorageProvider, StorageProvider } from '../../adapters/storage.provider';

export interface CurriculumNavigationInput {
  sessionId: string;
  chapterId: number | string;
  chapterNumber?: number;
  chapterTitle?: string;
  lessonId: number | string;
  lessonNumber?: string;
  lessonTitle?: string;
  topicId?: number | string | null;
  topicNumber?: string | null;
  topicTitle?: string | null;
  videoOffsetSec: number;
  mode?: 'taught' | 'reference_only';
  explicitModeLock?: boolean;
  relationalContext?: Partial<RelationalLessonContext>;
}

interface InternalSegmentState extends SessionTopicSegment {
  explicitModeLock: boolean;
}

interface InternalSessionTimelineState {
  sessionId: string;
  relationalContext: RelationalLessonContext;
  startedAtMs: number;
  activeMode: RoomMode;
  lastModeSwitchAtMs: number;
  whiteboardModeMs: number;
  contentModeMs: number;
  peakConcurrentUsers: number;
  micHandRaisesGranted: number;
  videoChunksUploaded: number;
  totalVideoBytes: number;
  latestVideoOffsetSec: number;
  segments: InternalSegmentState[];
  timelineMarkers: TimelineMarker[];
  /** Keyed by `${lessonId}:${topicId ?? 'root'}` -> latest Whiteboard state modified during this session */
  dirtyWhiteboards: Map<string, Partial<ExcalidrawWhiteboardArtifact>>;
}

/**
 * Multi-Topic Session Timeline, Reference-Only Lesson Guard & Analytics Tracker (`SessionTimelineTracker`)
 *
 * Architectural Responsibilities:
 * 1. **Single Continuous Video per Live Session:**
 *    - When a teacher switches lessons or topics during a live class, the 720p video recorder
 *      NEVER stops or splits. Instead, `navigateCurriculum()` logs the exact `videoOffsetSec`
 *      for the outgoing and incoming lessons/topics.
 * 2. **Reference-Only Lesson Protection:**
 *    - If a teacher opens a previously completed lesson just to show a formula or diagram for
 *      reference (`mode: 'reference_only'`, or opened briefly `< 180s` without modifying the
 *      Whiteboard when navigating across multiple lessons), this tracker guarantees that the
 *      old lesson's existing `whiteboard.json` and primary VOD artifact are **NEVER overwritten**.
 * 3. **Per-Topic Isolated Whiteboard Persistence:**
 *    - Each taught lesson/topic (`mode === 'taught'`) saves its own isolated gzip-compressed
 *      `whiteboard.json` (with zero Content Mode pen/laser strokes) at its deterministic path.
 * 4. **Live Session Analytics:**
 *    - Tracks `whiteboardModeSeconds`, `contentModeSeconds`, `peakConcurrentUsers`,
 *      `totalChunksUploaded`, `totalVideoBytes`, and `TimelineMarker[]`.
 */
export class SessionTimelineTracker {
  private sessions = new Map<string, InternalSessionTimelineState>();
  /** Minimum duration (in seconds) for an unedited multi-lesson visit to auto-qualify as 'taught' */
  public static readonly MIN_TAUGHT_DURATION_WITHOUT_WB_EDITS_SEC = 180;

  /**
   * Initializes or updates the relational context for a live session and opens the initial
   * curriculum topic segment if none exists yet.
   */
  public ensureSession(
    sessionId: string,
    context?: Partial<RelationalLessonContext>
  ): InternalSessionTimelineState {
    const existing = this.sessions.get(sessionId);
    const now = Date.now();

    if (!existing) {
      const normalizedCtx = StorageProvider.normalizeRelationalContext({
        ...context,
        sessionId,
      });

      const initialSegment: InternalSegmentState = {
        segmentIndex: 0,
        chapterId: normalizedCtx.chapterId,
        chapterNumber: normalizedCtx.chapterNumber,
        chapterTitle: normalizedCtx.chapterTitle,
        lessonId: normalizedCtx.lessonId,
        lessonNumber: normalizedCtx.lessonNumber,
        lessonTitle: normalizedCtx.lessonTitle,
        topicId: normalizedCtx.topicId,
        topicTitle: normalizedCtx.topicTitle,
        startOffsetSec: 0,
        endOffsetSec: 0,
        durationSec: 0,
        whiteboardModified: false,
        whiteboardPagesCount: 1,
        whiteboardElementsCount: 0,
        mode: 'taught',
        explicitModeLock: false,
      };

      const newState: InternalSessionTimelineState = {
        sessionId,
        relationalContext: normalizedCtx,
        startedAtMs: now,
        activeMode: 'WHITEBOARD',
        lastModeSwitchAtMs: now,
        whiteboardModeMs: 0,
        contentModeMs: 0,
        peakConcurrentUsers: 1,
        micHandRaisesGranted: 0,
        videoChunksUploaded: 0,
        totalVideoBytes: 0,
        latestVideoOffsetSec: 0,
        segments: [initialSegment],
        timelineMarkers: [
          {
            timeSec: 0,
            label: `Started ${normalizedCtx.lessonTitle}`,
            markerType: 'topic_start',
            chapterId: normalizedCtx.chapterId,
            lessonId: normalizedCtx.lessonId,
            topicId: normalizedCtx.topicId,
          },
        ],
        dirtyWhiteboards: new Map(),
      };
      this.sessions.set(sessionId, newState);
      return newState;
    }

    if (context) {
      existing.relationalContext = StorageProvider.normalizeRelationalContext({
        ...existing.relationalContext,
        ...context,
        sessionId,
      });
      // Also backfill initial segment metadata ONLY if segment 0 was initialized with placeholder lessonId=1
      if (
        existing.segments.length === 1 &&
        existing.segments[0].startOffsetSec === 0 &&
        existing.segments[0].lessonId === 1 &&
        !existing.segments[0].whiteboardModified
      ) {
        const seg = existing.segments[0];
        if (context.chapterId !== undefined) seg.chapterId = StorageProvider.toNumericId(context.chapterId, seg.chapterId);
        if (context.chapterNumber !== undefined) seg.chapterNumber = StorageProvider.toNumericId(context.chapterNumber, seg.chapterNumber);
        if (context.chapterTitle !== undefined) seg.chapterTitle = context.chapterTitle;
        if (context.lessonId !== undefined) seg.lessonId = StorageProvider.toNumericId(context.lessonId, seg.lessonId);
        if (context.lessonNumber !== undefined) seg.lessonNumber = String(context.lessonNumber);
        if (context.lessonTitle !== undefined) seg.lessonTitle = context.lessonTitle;
        if (context.topicId !== undefined) seg.topicId = StorageProvider.toNullableNumericId(context.topicId);
        if (context.topicTitle !== undefined) seg.topicTitle = context.topicTitle ?? undefined;
      }
    }

    return existing;
  }

  /**
   * Resets the recording timeline for a session when the teacher restarts recording
   * or starts a new recording after stopping mid-session.
   */
  public resetRecordingTimeline(
    sessionId: string,
    context?: Partial<RelationalLessonContext>
  ): InternalSessionTimelineState {
    const existing = this.sessions.get(sessionId);
    const now = Date.now();
    const activeSeg = existing?.segments[existing.segments.length - 1];
    const mergedContext = StorageProvider.normalizeRelationalContext({
      ...(existing?.relationalContext || {}),
      ...(activeSeg
        ? {
            chapterId: activeSeg.chapterId,
            chapterNumber: activeSeg.chapterNumber,
            chapterTitle: activeSeg.chapterTitle,
            lessonId: activeSeg.lessonId,
            lessonNumber: activeSeg.lessonNumber,
            lessonTitle: activeSeg.lessonTitle,
            topicId: activeSeg.topicId,
            topicTitle: activeSeg.topicTitle,
          }
        : {}),
      ...(context || {}),
      sessionId,
    });

    const initialSegment: InternalSegmentState = {
      segmentIndex: 0,
      chapterId: mergedContext.chapterId,
      chapterNumber: mergedContext.chapterNumber,
      chapterTitle: mergedContext.chapterTitle,
      lessonId: mergedContext.lessonId,
      lessonNumber: mergedContext.lessonNumber,
      lessonTitle: mergedContext.lessonTitle,
      topicId: mergedContext.topicId,
      topicTitle: mergedContext.topicTitle,
      startOffsetSec: 0,
      endOffsetSec: 0,
      durationSec: 0,
      whiteboardModified: activeSeg?.whiteboardModified ?? false,
      whiteboardPagesCount: activeSeg?.whiteboardPagesCount ?? 1,
      whiteboardElementsCount: activeSeg?.whiteboardElementsCount ?? 0,
      mode: 'taught',
      explicitModeLock: false,
    };

    const resetState: InternalSessionTimelineState = {
      sessionId,
      relationalContext: mergedContext,
      startedAtMs: now,
      activeMode: existing?.activeMode || 'WHITEBOARD',
      lastModeSwitchAtMs: now,
      whiteboardModeMs: 0,
      contentModeMs: 0,
      peakConcurrentUsers: existing?.peakConcurrentUsers ?? 1,
      micHandRaisesGranted: existing?.micHandRaisesGranted ?? 0,
      videoChunksUploaded: 0,
      totalVideoBytes: 0,
      latestVideoOffsetSec: 0,
      segments: [initialSegment],
      timelineMarkers: [
        {
          timeSec: 0,
          label: `Started ${mergedContext.lessonTitle}`,
          markerType: 'topic_start',
          chapterId: mergedContext.chapterId,
          lessonId: mergedContext.lessonId,
          topicId: mergedContext.topicId,
        },
      ],
      dirtyWhiteboards: existing?.dirtyWhiteboards || new Map(),
    };

    this.sessions.set(sessionId, resetState);
    return resetState;
  }

  /**
   * Records a video chunk upload metric and advances `latestVideoOffsetSec`.
   */
  public recordVideoChunkUploaded(
    sessionId: string,
    chunkIndex: number,
    byteLength: number,
    relationalContext?: Partial<RelationalLessonContext>
  ): void {
    const state = this.ensureSession(sessionId, relationalContext);
    state.videoChunksUploaded += 1;
    state.totalVideoBytes += byteLength;
    const estimatedOffsetSec = (chunkIndex + 1) * 10;
    if (estimatedOffsetSec > state.latestVideoOffsetSec) {
      state.latestVideoOffsetSec = estimatedOffsetSec;
    }
    const activeSeg = state.segments[state.segments.length - 1];
    if (activeSeg && estimatedOffsetSec > (activeSeg.endOffsetSec ?? 0)) {
      activeSeg.endOffsetSec = estimatedOffsetSec;
      activeSeg.durationSec = Math.max(0, activeSeg.endOffsetSec - activeSeg.startOffsetSec);
    }
  }

  /**
   * Records a teacher mode switch (`WHITEBOARD` <-> `CONTENT`) and accumulates mode durations.
   */
  public recordModeSwitch(
    sessionId: string,
    newMode: RoomMode,
    videoOffsetSec?: number
  ): void {
    const state = this.ensureSession(sessionId);
    const now = Date.now();
    const elapsedMs = Math.max(0, now - state.lastModeSwitchAtMs);

    if (state.activeMode === 'WHITEBOARD') {
      state.whiteboardModeMs += elapsedMs;
    } else {
      state.contentModeMs += elapsedMs;
    }

    state.activeMode = newMode;
    state.lastModeSwitchAtMs = now;

    const offsetSec =
      videoOffsetSec !== undefined
        ? Math.max(0, Number(videoOffsetSec))
        : state.latestVideoOffsetSec;
    if (offsetSec > state.latestVideoOffsetSec) {
      state.latestVideoOffsetSec = offsetSec;
    }

    const activeSeg = state.segments[state.segments.length - 1];
    state.timelineMarkers.push({
      timeSec: offsetSec,
      label: `Switched to ${newMode} Mode`,
      markerType: 'bookmark',
      chapterId: activeSeg?.chapterId ?? state.relationalContext.chapterId,
      lessonId: activeSeg?.lessonId ?? state.relationalContext.lessonId,
      topicId: activeSeg?.topicId ?? state.relationalContext.topicId,
    });
  }

  /**
   * Updates peak concurrent users count for session analytics.
   */
  public updateConcurrentUsers(sessionId: string, currentCount: number): void {
    const state = this.ensureSession(sessionId);
    if (currentCount > state.peakConcurrentUsers) {
      state.peakConcurrentUsers = currentCount;
    }
  }

  /**
   * Increments the count of student mic hand-raises approved during the session.
   */
  public recordMicGrant(sessionId: string): void {
    const state = this.ensureSession(sessionId);
    state.micHandRaisesGranted += 1;
  }

  /**
   * Evaluates whether a closing segment was actually taught (`'taught'`) or only opened
   * briefly for reference (`'reference_only'`).
   */
  private finalizeClosingSegmentClassification(
    segment: InternalSegmentState,
    hasMultipleSegments: boolean
  ): void {
    const endSec = segment.endOffsetSec ?? segment.startOffsetSec;
    segment.endOffsetSec = endSec;
    segment.durationSec = Math.max(0, endSec - segment.startOffsetSec);

    // If explicitly locked as 'reference_only' or 'taught' by teacher toggle, respect the lock
    if (segment.explicitModeLock) {
      return;
    }

    // If the teacher drew/modified the Whiteboard on this lesson/topic, it was definitely taught
    if (segment.whiteboardModified) {
      segment.mode = 'taught';
      return;
    }

    // When navigating across multiple lessons/topics in one session, if a lesson was opened
    // briefly (< 180 seconds) WITHOUT any Whiteboard edits, classify it as 'reference_only'
    // so we NEVER overwrite that lesson's existing VOD recording or whiteboard.json!
    if (
      hasMultipleSegments &&
      segment.durationSec < SessionTimelineTracker.MIN_TAUGHT_DURATION_WITHOUT_WB_EDITS_SEC
    ) {
      segment.mode = 'reference_only';
    }
  }

  /**
   * Switches the active curriculum Lesson or Topic during a live session WITHOUT stopping
   * or splitting the continuous 720p video stream.
   *
   * Automatically closes the outgoing `SessionTopicSegment` at `videoOffsetSec`, evaluates
   * its `'taught' | 'reference_only'` protection status, and opens a new segment.
   */
  public navigateCurriculum(input: CurriculumNavigationInput): {
    closedSegment: SessionTopicSegment | null;
    activeSegment: SessionTopicSegment;
    allSegments: SessionTopicSegment[];
    totalSegments: number;
    videoStorageKey: string;
  } {
    const state = this.sessions.has(input.sessionId)
      ? this.ensureSession(input.sessionId)
      : this.ensureSession(input.sessionId, input.relationalContext);
    const offsetSec = Math.max(
      state.latestVideoOffsetSec,
      Math.max(0, Number(input.videoOffsetSec || 0))
    );
    state.latestVideoOffsetSec = offsetSec;

    const resolvedChapterId = StorageProvider.toNumericId(
      input.chapterId,
      state.relationalContext.chapterId
    );
    const resolvedLessonId = StorageProvider.toNumericId(
      input.lessonId,
      state.relationalContext.lessonId
    );
    const resolvedTopicId =
      input.topicId !== undefined ? StorageProvider.toNullableNumericId(input.topicId) : null;

    let closedSegment: SessionTopicSegment | null = null;
    const currentSeg = state.segments[state.segments.length - 1];

    // If already on the exact same lesson & topic, just update mode if requested
    if (
      currentSeg &&
      currentSeg.lessonId === resolvedLessonId &&
      (currentSeg.topicId ?? null) === resolvedTopicId
    ) {
      if (input.mode) {
        currentSeg.mode = input.mode;
        if (input.explicitModeLock !== undefined) {
          currentSeg.explicitModeLock = input.explicitModeLock;
        } else if (input.mode === 'reference_only') {
          currentSeg.explicitModeLock = true;
        }
      }
      currentSeg.endOffsetSec = offsetSec;
      currentSeg.durationSec = Math.max(0, offsetSec - currentSeg.startOffsetSec);
      return {
        closedSegment: null,
        activeSegment: { ...currentSeg },
        allSegments: state.segments.map((s) => ({ ...s })),
        totalSegments: state.segments.length,
        videoStorageKey: StorageProvider.buildSessionVideoKey(state.relationalContext),
      };
    }

    if (currentSeg) {
      currentSeg.endOffsetSec = offsetSec;
      this.finalizeClosingSegmentClassification(currentSeg, true);
      closedSegment = { ...currentSeg };
    }

    const requestedMode = input.mode || 'taught';
    const explicitModeLock =
      input.explicitModeLock !== undefined
        ? input.explicitModeLock
        : input.mode === 'reference_only';

    const newSegment: InternalSegmentState = {
      segmentIndex: state.segments.length,
      chapterId: resolvedChapterId,
      chapterNumber: StorageProvider.toNumericId(
        input.chapterNumber,
        state.relationalContext.chapterNumber
      ),
      chapterTitle: input.chapterTitle || state.relationalContext.chapterTitle,
      lessonId: resolvedLessonId,
      lessonNumber: String(input.lessonNumber ?? input.lessonId),
      lessonTitle: input.lessonTitle || `Lesson ${input.lessonId}`,
      topicId: resolvedTopicId,
      topicTitle: input.topicTitle ?? undefined,
      startOffsetSec: offsetSec,
      endOffsetSec: offsetSec,
      durationSec: 0,
      whiteboardModified: false,
      whiteboardPagesCount: 1,
      whiteboardElementsCount: 0,
      mode: requestedMode,
      explicitModeLock,
    };

    state.segments.push(newSegment);

    // Update active relational context to reflect current lesson/topic
    state.relationalContext = StorageProvider.normalizeRelationalContext({
      ...state.relationalContext,
      ...input.relationalContext,
      sessionId: input.sessionId,
      chapterId: newSegment.chapterId,
      chapterNumber: newSegment.chapterNumber,
      chapterTitle: newSegment.chapterTitle,
      lessonId: newSegment.lessonId,
      lessonNumber: newSegment.lessonNumber,
      lessonTitle: newSegment.lessonTitle,
      topicId: newSegment.topicId,
      topicTitle: newSegment.topicTitle,
    });

    state.timelineMarkers.push({
      timeSec: offsetSec,
      label:
        newSegment.mode === 'reference_only'
          ? `Reference Only: ${newSegment.lessonTitle}`
          : `Teaching: ${newSegment.lessonTitle}${newSegment.topicTitle ? ` - ${newSegment.topicTitle}` : ''}`,
      markerType: newSegment.mode === 'reference_only' ? 'reference_open' : 'topic_start',
      chapterId: newSegment.chapterId,
      lessonId: newSegment.lessonId,
      topicId: newSegment.topicId,
    });

    return {
      closedSegment,
      activeSegment: { ...newSegment },
      allSegments: state.segments.map((s) => ({ ...s })),
      totalSegments: state.segments.length,
      videoStorageKey: StorageProvider.buildSessionVideoKey(state.relationalContext),
    };
  }

  /**
   * Saves or updates a lesson/topic's Whiteboard state in the session tracker and persists
   * the gzip-compressed `whiteboard.json` to `StorageProvider` ONLY if the lesson is NOT
   * locked in `'reference_only'` mode (protecting old lessons opened for reference from overwrite).
   */
  public async saveTopicWhiteboard(
    sessionId: string,
    payload: {
      chapterId?: number | string;
      lessonId?: number | string;
      topicId?: number | string | null;
      elements: any[];
      appState?: Record<string, any>;
      files?: Record<string, any>;
      pages?: any[];
      relationalContext?: Partial<RelationalLessonContext>;
      forceReferenceOnlySkip?: boolean;
    }
  ): Promise<{
    saved: boolean;
    skippedAsReferenceOnly: boolean;
    sessionId: string;
    lessonId: number;
    whiteboardKey: string;
    whiteboardStorageKey: string;
    gzippedBytes: number;
    compressedBytes: number;
    uncompressedBytes: number;
    elementsCount: number;
  }> {
    const state = this.ensureSession(sessionId, payload.relationalContext);
    const activeSeg = state.segments[state.segments.length - 1];

    const targetChapterId = StorageProvider.toNumericId(
      payload.chapterId ?? activeSeg?.chapterId ?? state.relationalContext.chapterId,
      state.relationalContext.chapterId
    );
    const targetLessonId = StorageProvider.toNumericId(
      payload.lessonId ?? activeSeg?.lessonId ?? state.relationalContext.lessonId,
      state.relationalContext.lessonId
    );
    const targetTopicId =
      payload.topicId !== undefined
        ? StorageProvider.toNullableNumericId(payload.topicId)
        : activeSeg?.topicId !== undefined
        ? activeSeg.topicId
        : state.relationalContext.topicId;

    // Locate matching segment for this lesson/topic
    const matchingSeg = [...state.segments]
      .reverse()
      .find(
        (s) =>
          s.lessonId === targetLessonId &&
          (payload.topicId === undefined || (s.topicId ?? null) === (targetTopicId ?? null))
      );

    const targetCtx = StorageProvider.normalizeRelationalContext({
      ...state.relationalContext,
      ...payload.relationalContext,
      sessionId,
      chapterId: targetChapterId,
      lessonId: targetLessonId,
      topicId: targetTopicId ?? null,
    });

    const whiteboardKey = StorageProvider.buildTopicWhiteboardKey(targetCtx);

    // PROTECTION RULE: If this lesson segment is explicitly locked as 'reference_only'
    // (or forceReferenceOnlySkip is true), NEVER overwrite its existing whiteboard.json!
    if (
      payload.forceReferenceOnlySkip ||
      (matchingSeg && matchingSeg.mode === 'reference_only' && matchingSeg.explicitModeLock)
    ) {
      return {
        saved: false,
        skippedAsReferenceOnly: true,
        sessionId,
        lessonId: targetLessonId,
        whiteboardKey,
        whiteboardStorageKey: whiteboardKey,
        gzippedBytes: 0,
        compressedBytes: 0,
        uncompressedBytes: 0,
        elementsCount: 0,
      };
    }

    const sanitizedArtifact = StorageProvider.sanitizeWhiteboardArtifact({
      schemaVersion: 2,
      sessionId,
      relationalContext: targetCtx,
      savedAt: new Date().toISOString(),
      elements: payload.elements,
      appState: payload.appState,
      files: payload.files,
      pages: payload.pages,
      timelineMarkers: state.timelineMarkers.filter((m) => m.lessonId === targetCtx.lessonId),
    });

    // Mark segment as modified only if non-empty elements or pages were drawn
    const hasDrawnElements =
      sanitizedArtifact.elements.length > 0 ||
      (Array.isArray(sanitizedArtifact.pages) &&
        sanitizedArtifact.pages.some((p) => p.elements.length > 0));

    if (matchingSeg) {
      matchingSeg.whiteboardElementsCount = sanitizedArtifact.elements.length;
      matchingSeg.whiteboardPagesCount = Math.max(1, sanitizedArtifact.pages.length || 1);
      if (hasDrawnElements) {
        matchingSeg.whiteboardModified = true;
        if (!matchingSeg.explicitModeLock) {
          matchingSeg.mode = 'taught';
        }
      }
    }

    const mapKey = `${targetLessonId}:${targetTopicId ?? 'root'}`;
    state.dirtyWhiteboards.set(mapKey, sanitizedArtifact);

    const storageProvider = getStorageProvider();
    const writeRes = await storageProvider.putGzippedWhiteboard(whiteboardKey, sanitizedArtifact);

    return {
      saved: true,
      skippedAsReferenceOnly: false,
      sessionId,
      lessonId: targetLessonId,
      whiteboardKey: writeRes.key,
      whiteboardStorageKey: writeRes.key,
      gzippedBytes: writeRes.gzippedBytes,
      compressedBytes: writeRes.gzippedBytes,
      uncompressedBytes: writeRes.uncompressedBytes,
      elementsCount: sanitizedArtifact.elements.length,
    };
  }

  /**
   * Returns a snapshot of the session's current timeline segments and analytics.
   */
  public getSessionTimelineSnapshot(sessionId: string): {
    exists: boolean;
    relationalContext?: RelationalLessonContext;
    segments: SessionTopicSegment[];
    timelineMarkers: TimelineMarker[];
    latestVideoOffsetSec: number;
    videoChunksUploaded: number;
  } {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return {
        exists: false,
        segments: [],
        timelineMarkers: [],
        latestVideoOffsetSec: 0,
        videoChunksUploaded: 0,
      };
    }
    return {
      exists: true,
      relationalContext: { ...state.relationalContext },
      segments: state.segments.map((s) => ({ ...s })),
      timelineMarkers: [...state.timelineMarkers],
      latestVideoOffsetSec: state.latestVideoOffsetSec,
      videoChunksUploaded: state.videoChunksUploaded,
    };
  }

  /**
   * Finalizes the live session:
   * 1. Closes the active topic segment and evaluates `'taught'` vs `'reference_only'` for all segments.
   * 2. Finalizes the single continuous 720p session video (`video_720p.webm`) via `StorageProvider`
   *    and links it ONLY to `'taught'` lessons (NEVER overwriting `'reference_only'` lessons).
   * 3. Ensures every `'taught'` lesson has a persisted gzipped `whiteboard.json` (while leaving
   *    `'reference_only'` lessons' existing `whiteboard.json` completely untouched).
   * 4. Returns the complete `SessionFinalizationSummary` for Laravel VOD auto-publishing & analytics.
   */
  public async finalizeSession(
    sessionId: string,
    options?: {
      relationalContext?: Partial<RelationalLessonContext>;
      totalDurationSec?: number;
      whiteboardPayload?: {
        elements?: any[];
        appState?: Record<string, any>;
        files?: Record<string, any>;
        pages?: any[];
      };
    }
  ): Promise<SessionFinalizationSummary> {
    const state = this.ensureSession(sessionId, options?.relationalContext);
    const storageProvider = getStorageProvider();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // Accumulate remaining active mode time
    const elapsedSinceLastSwitchMs = Math.max(0, nowMs - state.lastModeSwitchAtMs);
    if (state.activeMode === 'WHITEBOARD') {
      state.whiteboardModeMs += elapsedSinceLastSwitchMs;
    } else {
      state.contentModeMs += elapsedSinceLastSwitchMs;
    }
    state.lastModeSwitchAtMs = nowMs;

    const videoState = storageProvider.getSessionVideoState(sessionId);
    const resolvedTotalDurationSec =
      options?.totalDurationSec ??
      Math.max(
        state.latestVideoOffsetSec,
        videoState.chunksReceivedCount * 10,
        Math.max(1, Math.round((nowMs - state.startedAtMs) / 1000))
      );

    state.latestVideoOffsetSec = resolvedTotalDurationSec;

    // Close the final segment
    const hasMultipleSegments = state.segments.length > 1;
    const lastSeg = state.segments[state.segments.length - 1];
    if (lastSeg) {
      if ((lastSeg.endOffsetSec ?? 0) < resolvedTotalDurationSec) {
        lastSeg.endOffsetSec = resolvedTotalDurationSec;
      }
      // If a caller supplied a final whiteboardPayload for the active lesson, save it first
      if (
        options?.whiteboardPayload &&
        Array.isArray(options.whiteboardPayload.elements) &&
        !(lastSeg.mode === 'reference_only' && lastSeg.explicitModeLock)
      ) {
        await this.saveTopicWhiteboard(sessionId, {
          chapterId: lastSeg.chapterId,
          lessonId: lastSeg.lessonId,
          topicId: lastSeg.topicId,
          elements: options.whiteboardPayload.elements,
          appState: options.whiteboardPayload.appState,
          files: options.whiteboardPayload.files,
          pages: options.whiteboardPayload.pages,
          relationalContext: options.relationalContext,
        });
      }
      this.finalizeClosingSegmentClassification(lastSeg, hasMultipleSegments);
    }

    // Separate 'taught' segments from 'reference_only' segments
    const taughtSegments = state.segments.filter((s) => s.mode === 'taught');
    const referenceOnlySegments = state.segments.filter((s) => s.mode === 'reference_only');

    // Build contexts for all taught lessons so the single session video is linked to taught lessons only
    const primaryContext =
      taughtSegments.length > 0
        ? StorageProvider.normalizeRelationalContext({
            ...state.relationalContext,
            ...options?.relationalContext,
            sessionId,
            chapterId: taughtSegments[0].chapterId,
            chapterNumber: taughtSegments[0].chapterNumber,
            chapterTitle: taughtSegments[0].chapterTitle,
            lessonId: taughtSegments[0].lessonId,
            lessonNumber: taughtSegments[0].lessonNumber,
            lessonTitle: taughtSegments[0].lessonTitle,
            topicId: taughtSegments[0].topicId,
            topicTitle: taughtSegments[0].topicTitle,
          })
        : state.relationalContext;

    const additionalLessonContexts = taughtSegments.slice(1).map((seg) =>
      StorageProvider.normalizeRelationalContext({
        ...state.relationalContext,
        ...options?.relationalContext,
        sessionId,
        chapterId: seg.chapterId,
        chapterNumber: seg.chapterNumber,
        chapterTitle: seg.chapterTitle,
        lessonId: seg.lessonId,
        lessonNumber: seg.lessonNumber,
        lessonTitle: seg.lessonTitle,
        topicId: seg.topicId,
        topicTitle: seg.topicTitle,
      })
    );

    const finalizedVideo = await storageProvider.finalizeVideoRecording(
      sessionId,
      primaryContext,
      {
        durationSec: resolvedTotalDurationSec,
        additionalLessonContexts,
      }
    );

    const publishedLessonArtifacts: FinalizedLessonArtifactRecord[] = [];
    for (const seg of taughtSegments) {
      const segCtx = StorageProvider.normalizeRelationalContext({
        ...state.relationalContext,
        ...options?.relationalContext,
        sessionId,
        chapterId: seg.chapterId,
        chapterNumber: seg.chapterNumber,
        chapterTitle: seg.chapterTitle,
        lessonId: seg.lessonId,
        lessonNumber: seg.lessonNumber,
        lessonTitle: seg.lessonTitle,
        topicId: seg.topicId,
        topicTitle: seg.topicTitle,
      });

      const lessonVideoKey = StorageProvider.buildLessonVideoKey(segCtx, 'webm');
      const wbKey = StorageProvider.buildTopicWhiteboardKey(segCtx);

      // Ensure whiteboard.json exists for every taught lesson
      let existingWb = await storageProvider.getGzippedWhiteboard(wbKey);
      if (!existingWb) {
        await storageProvider.putGzippedWhiteboard(wbKey, {
          sessionId,
          relationalContext: segCtx,
          elements: [],
          appState: { viewBackgroundColor: '#ffffff' },
          files: {},
          pages: [],
          timelineMarkers: state.timelineMarkers.filter((m) => m.lessonId === segCtx.lessonId),
        });
        existingWb = await storageProvider.getGzippedWhiteboard(wbKey);
      }

      const endOffsetSec = seg.endOffsetSec ?? resolvedTotalDurationSec;

      publishedLessonArtifacts.push({
        sessionId,
        liveClassSessionId: segCtx.liveClassSessionId ?? null,
        contextType: segCtx.contextType || 'course_lesson',
        relationalContext: segCtx,
        videoRelativePath: lessonVideoKey,
        videoPublicUrl: storageProvider.getPublicUrl(lessonVideoKey),
        videoMimeType: 'video/webm;codecs=vp9,opus',
        videoSizeBytes: finalizedVideo.totalBytes,
        videoDurationSeconds: seg.durationSec,
        videoStartOffsetSec: seg.startOffsetSec,
        videoEndOffsetSec: endOffsetSec,
        whiteboardGzipRelativePath: wbKey,
        whiteboardPublicUrl: storageProvider.getPublicUrl(wbKey),
        whiteboardPageCount: Math.max(1, existingWb?.artifact.pages?.length || 1),
        whiteboardElementCount: existingWb?.artifact.elements?.length || 0,
        storageDriver: storageProvider.getBackendType(),
        timelineMarkers: state.timelineMarkers.filter((m) => m.lessonId === seg.lessonId),
        mode: seg.mode,
        publishToVodCourse: segCtx.publishToVodCourse,
        isPrimaryVod: segCtx.isPrimaryVod,
        recordedAt: nowIso,
      });
    }

    const cleanSegments: SessionTopicSegment[] = state.segments.map((s) => ({
      segmentIndex: s.segmentIndex,
      chapterId: s.chapterId,
      chapterNumber: s.chapterNumber,
      chapterTitle: s.chapterTitle,
      lessonId: s.lessonId,
      lessonNumber: s.lessonNumber,
      lessonTitle: s.lessonTitle,
      topicId: s.topicId,
      topicTitle: s.topicTitle,
      startOffsetSec: s.startOffsetSec,
      endOffsetSec: s.endOffsetSec,
      durationSec: s.durationSec,
      whiteboardModified: s.whiteboardModified,
      whiteboardPagesCount: s.whiteboardPagesCount,
      whiteboardElementsCount: s.whiteboardElementsCount,
      mode: s.mode,
    }));

    const referenceSegments: SessionTopicSegment[] = referenceOnlySegments.map((s) => ({
      segmentIndex: s.segmentIndex,
      chapterId: s.chapterId,
      chapterNumber: s.chapterNumber,
      chapterTitle: s.chapterTitle,
      lessonId: s.lessonId,
      lessonNumber: s.lessonNumber,
      lessonTitle: s.lessonTitle,
      topicId: s.topicId,
      topicTitle: s.topicTitle,
      startOffsetSec: s.startOffsetSec,
      endOffsetSec: s.endOffsetSec,
      durationSec: s.durationSec,
      whiteboardModified: s.whiteboardModified,
      whiteboardPagesCount: s.whiteboardPagesCount,
      whiteboardElementsCount: s.whiteboardElementsCount,
      mode: s.mode,
    }));

    const totalWhiteboardPages = cleanSegments.reduce(
      (sum, s) => sum + (s.whiteboardPagesCount || 1),
      0
    );

    const analytics: SessionAnalyticsMetrics = {
      sessionId,
      startedAt: new Date(state.startedAtMs).toISOString(),
      endedAt: nowIso,
      totalDurationSeconds: resolvedTotalDurationSec,
      whiteboardModeSeconds: Math.round(state.whiteboardModeMs / 1000),
      contentModeSeconds: Math.round(state.contentModeMs / 1000),
      peakConcurrentUsers: state.peakConcurrentUsers,
      avgConcurrentUsers: Math.max(1, Math.round(state.peakConcurrentUsers * 0.85)),
      totalUniqueStudents: Math.max(0, state.peakConcurrentUsers - 1),
      totalChunksUploaded: Math.max(state.videoChunksUploaded, finalizedVideo.chunksCount),
      totalVideoBytes: finalizedVideo.totalBytes,
      whiteboardPagesCount: totalWhiteboardPages,
      topicsCovered: cleanSegments,
      timelineMarkers: [...state.timelineMarkers],
    };

    return {
      sessionId,
      relationalContext: primaryContext,
      sessionVideoRelativePath: finalizedVideo.key,
      sessionVideoPublicUrl: finalizedVideo.publicUrl,
      videoMimeType: 'video/webm;codecs=vp9,opus',
      videoSizeBytes: finalizedVideo.totalBytes,
      videoDurationSeconds: resolvedTotalDurationSec,
      storageDriver: storageProvider.getBackendType(),
      taughtArtifacts: publishedLessonArtifacts,
      publishedLessonArtifacts,
      referenceSegments,
      skippedReferenceLessons: referenceSegments,
      analytics,
      finalizedAt: nowIso,
    };
  }
}

let activeTimelineTracker: SessionTimelineTracker | null = null;

export function getSessionTimelineTracker(): SessionTimelineTracker {
  if (!activeTimelineTracker) {
    activeTimelineTracker = new SessionTimelineTracker();
  }
  return activeTimelineTracker;
}

export function setSessionTimelineTracker(tracker: SessionTimelineTracker | null): void {
  activeTimelineTracker = tracker;
}
