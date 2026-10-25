import { redis } from '../../config/redis';
import { generateLiveKitToken, livekitRoomService } from '../../config/livekit';
import { InvitedTeacherEntry, RaisedHandEntry, UserAuthPayload } from '../../types/broadcast.types';
import { RoomManager } from '../room/room.manager';

export class AudioStageController {
  public static MAX_CONCURRENT_STUDENT_MICS = 10;

  public static activeMicsKey(sessionId: string): string {
    return `room:${sessionId}:active_student_mics`;
  }

  public static allowStudentUnmuteKey(sessionId: string): string {
    return `room:${sessionId}:allow_student_unmute`;
  }

  private static raisedHandsKey(sessionId: string): string {
    return `room:${sessionId}:raised_hands`;
  }

  private static raisedHandsMetaKey(sessionId: string): string {
    return `room:${sessionId}:raised_hands_meta`;
  }

  private static teacherMicKey(sessionId: string): string {
    return `room:${sessionId}:teacher_mic_active`;
  }

  private static invitedTeachersKey(sessionId: string): string {
    return `room:${sessionId}:invited_teachers`;
  }

  private static whiteboardEditorsKey(sessionId: string): string {
    return `room:${sessionId}:whiteboard_editors`;
  }

  /**
   * Generates a LiveKit connection token for participant.
   */
  public static async getJoinToken(
    sessionId: string,
    userId: string,
    name: string,
    role: 'teacher' | 'student'
  ): Promise<{ token: string; canPublishAudio: boolean }> {
    let canPublish = false;

    if (role === 'teacher') {
      canPublish = true;
    } else {
      // Check if student currently has mic permission or if students are allowed to unmute
      const hasMic = await redis.sismember(this.activeMicsKey(sessionId), userId);
      const allowUnmute = await this.getAllowStudentUnmute(sessionId);
      canPublish = hasMic === 1 || allowUnmute;
    }

    const token = await generateLiveKitToken({
      roomName: sessionId,
      participantIdentity: userId,
      participantName: name,
      canPublishAudio: canPublish,
      canSubscribe: true,
    });

    return { token, canPublishAudio: canPublish };
  }

  /**
   * Student raises hand. Added to Redis sorted set by timestamp.
   */
  public static async raiseHand(
    sessionId: string,
    entry: RaisedHandEntry
  ): Promise<{ success: boolean; queuePosition: number }> {
    const handsKey = this.raisedHandsKey(sessionId);
    const metaKey = this.raisedHandsMetaKey(sessionId);

    await redis.zadd(handsKey, entry.raisedAt, entry.userId);
    await redis.hset(metaKey, entry.userId, JSON.stringify(entry));

    const rank = await redis.zrank(handsKey, entry.userId);
    const queuePosition = rank !== null ? rank + 1 : 1;

    await RoomManager.appendPacket(sessionId, 'AUDIO_HAND_RAISED', {
      entry,
      queuePosition,
    });

    return { success: true, queuePosition };
  }

  /**
   * Student lowers hand (or teacher clears student's hand).
   */
  public static async lowerHand(
    sessionId: string,
    userId: string
  ): Promise<boolean> {
    const handsKey = this.raisedHandsKey(sessionId);
    const metaKey = this.raisedHandsMetaKey(sessionId);

    await redis.zrem(handsKey, userId);
    await redis.hdel(metaKey, userId);

    await RoomManager.appendPacket(sessionId, 'AUDIO_HAND_LOWERED', { userId });
    return true;
  }

  /**
   * Retrieves current raised hands list in FIFO queue order.
   */
  public static async getRaisedHands(sessionId: string): Promise<RaisedHandEntry[]> {
    const handsKey = this.raisedHandsKey(sessionId);
    const metaKey = this.raisedHandsMetaKey(sessionId);

    const userIds = await redis.zrange(handsKey, 0, -1);
    if (!userIds || userIds.length === 0) return [];

    const metaJsons = await redis.hmget(metaKey, ...userIds);
    const entries: RaisedHandEntry[] = [];

    metaJsons.forEach((json, idx) => {
      if (json) {
        try {
          entries.push(JSON.parse(json));
        } catch {
          entries.push({ userId: userIds[idx], name: 'Student', raisedAt: Date.now() });
        }
      } else {
        entries.push({ userId: userIds[idx], name: 'Student', raisedAt: Date.now() });
      }
    });

    return entries;
  }

  /**
   * Retrieves currently active student mics.
   */
  public static async getActiveStudentMics(sessionId: string): Promise<string[]> {
    return await redis.smembers(this.activeMicsKey(sessionId));
  }

  /**
   * Retrieves complete audio stage & collaboration permissions state.
   */
  public static async getStageState(sessionId: string): Promise<{
    activeStudentMics: string[];
    raisedHands: RaisedHandEntry[];
    maxStudentMics: number;
    teacherMicActive: boolean;
    invitedTeachers: InvitedTeacherEntry[];
    whiteboardEditors: string[];
    allowStudentUnmute: boolean;
  }> {
    const [
      activeStudentMics,
      raisedHands,
      teacherMicActive,
      invitedTeachers,
      whiteboardEditors,
      allowStudentUnmute,
    ] = await Promise.all([
      this.getActiveStudentMics(sessionId),
      this.getRaisedHands(sessionId),
      this.getTeacherMicActive(sessionId),
      this.getInvitedTeachers(sessionId),
      this.getWhiteboardEditors(sessionId),
      this.getAllowStudentUnmute(sessionId),
    ]);
    return {
      activeStudentMics,
      raisedHands,
      maxStudentMics: this.MAX_CONCURRENT_STUDENT_MICS,
      teacherMicActive,
      invitedTeachers,
      whiteboardEditors,
      allowStudentUnmute,
    };
  }

  /**
   * Retrieves whether the host has enabled "Allow Students to Unmute Themselves" (Open Mic mode).
   */
  public static async getAllowStudentUnmute(sessionId: string): Promise<boolean> {
    const raw = await redis.get(this.allowStudentUnmuteKey(sessionId));
    return raw === '1' || raw === 'true';
  }

  /**
   * Host or co-host toggles "Allow Students to Unmute Themselves".
   */
  public static async setAllowStudentUnmute(
    sessionId: string,
    allow: boolean
  ): Promise<boolean> {
    await redis.set(this.allowStudentUnmuteKey(sessionId), allow ? '1' : '0');
    await RoomManager.appendPacket(sessionId, 'AUDIO_ALLOW_UNMUTE_CHANGED', {
      allowStudentUnmute: allow,
    });
    return allow;
  }

  /**
   * Gets whether the host teacher's microphone is currently unmuted (default false — muted by default).
   */
  public static async getTeacherMicActive(sessionId: string): Promise<boolean> {
    const raw = await redis.get(this.teacherMicKey(sessionId));
    return raw === '1' || raw === 'true';
  }

  /**
   * Updates teacher microphone active state (all mics start muted by default).
   */
  public static async setTeacherMicActive(sessionId: string, active: boolean): Promise<boolean> {
    await redis.set(this.teacherMicKey(sessionId), active ? '1' : '0');
    await RoomManager.appendPacket(sessionId, 'TEACHER_MIC_STATE_CHANGE', { active });
    return active;
  }

  /**
   * Retrieves all invited co-teachers for the session.
   */
  public static async getInvitedTeachers(sessionId: string): Promise<InvitedTeacherEntry[]> {
    const rawMap = await redis.hgetall(this.invitedTeachersKey(sessionId));
    if (!rawMap) return [];
    const list: InvitedTeacherEntry[] = [];
    for (const val of Object.values(rawMap)) {
      try {
        list.push(JSON.parse(val));
      } catch {
        // ignore malformed entry
      }
    }
    return list.sort((a, b) => a.invitedAt - b.invitedAt);
  }

  /**
   * Host invites another teacher (co-teacher) to the session, optionally granting Whiteboard access.
   */
  public static async inviteCoTeacher(
    sessionId: string,
    entry: InvitedTeacherEntry
  ): Promise<InvitedTeacherEntry[]> {
    const cleanId = entry.teacherId.startsWith('teacher_')
      ? entry.teacherId
      : `teacher_${entry.teacherId}`;
    const normalized: InvitedTeacherEntry = {
      ...entry,
      teacherId: cleanId,
      invitedAt: entry.invitedAt || Date.now(),
      isOnline: true,
    };

    await redis.hset(this.invitedTeachersKey(sessionId), cleanId, JSON.stringify(normalized));
    if (normalized.canUseWhiteboard) {
      await redis.sadd(this.whiteboardEditorsKey(sessionId), cleanId);
    } else {
      await redis.srem(this.whiteboardEditorsKey(sessionId), cleanId);
    }

    const updated = await this.getInvitedTeachers(sessionId);
    const whiteboardEditors = await this.getWhiteboardEditors(sessionId);
    await RoomManager.appendPacket(sessionId, 'CO_TEACHERS_UPDATED', {
      invitedTeachers: updated,
      whiteboardEditors,
    });
    return updated;
  }

  /**
   * Host toggles an invited co-teacher's Whiteboard access.
   */
  public static async setCoTeacherWhiteboardAccess(
    sessionId: string,
    teacherId: string,
    canUseWhiteboard: boolean
  ): Promise<{ invitedTeachers: InvitedTeacherEntry[]; whiteboardEditors: string[] }> {
    const cleanId = teacherId.startsWith('teacher_') ? teacherId : `teacher_${teacherId}`;
    const existingRaw = await redis.hget(this.invitedTeachersKey(sessionId), cleanId);
    if (existingRaw) {
      try {
        const parsed = JSON.parse(existingRaw) as InvitedTeacherEntry;
        parsed.canUseWhiteboard = canUseWhiteboard;
        await redis.hset(this.invitedTeachersKey(sessionId), cleanId, JSON.stringify(parsed));
      } catch {
        // ignore
      }
    }

    if (canUseWhiteboard) {
      await redis.sadd(this.whiteboardEditorsKey(sessionId), cleanId);
    } else {
      await redis.srem(this.whiteboardEditorsKey(sessionId), cleanId);
    }

    const [invitedTeachers, whiteboardEditors] = await Promise.all([
      this.getInvitedTeachers(sessionId),
      this.getWhiteboardEditors(sessionId),
    ]);
    await RoomManager.appendPacket(sessionId, 'CO_TEACHERS_UPDATED', {
      invitedTeachers,
      whiteboardEditors,
    });
    return { invitedTeachers, whiteboardEditors };
  }

  /**
   * Host removes an invited co-teacher from the session.
   */
  public static async removeCoTeacher(
    sessionId: string,
    teacherId: string
  ): Promise<{ invitedTeachers: InvitedTeacherEntry[]; whiteboardEditors: string[] }> {
    const cleanId = teacherId.startsWith('teacher_') ? teacherId : `teacher_${teacherId}`;
    await redis.hdel(this.invitedTeachersKey(sessionId), cleanId);
    await redis.srem(this.whiteboardEditorsKey(sessionId), cleanId);

    const [invitedTeachers, whiteboardEditors] = await Promise.all([
      this.getInvitedTeachers(sessionId),
      this.getWhiteboardEditors(sessionId),
    ]);
    await RoomManager.appendPacket(sessionId, 'CO_TEACHERS_UPDATED', {
      invitedTeachers,
      whiteboardEditors,
    });
    return { invitedTeachers, whiteboardEditors };
  }

  /**
   * Retrieves list of userIds (students or co-teachers) currently granted Whiteboard edit access.
   */
  public static async getWhiteboardEditors(sessionId: string): Promise<string[]> {
    return await redis.smembers(this.whiteboardEditorsKey(sessionId));
  }

  /**
   * Teacher grants Whiteboard edit access to a student (or co-teacher).
   */
  public static async grantWhiteboardAccess(
    sessionId: string,
    targetUserId: string
  ): Promise<string[]> {
    const normalizedId =
      targetUserId.startsWith('student_') || targetUserId.startsWith('teacher_')
        ? targetUserId
        : `student_${targetUserId}`;

    await redis.sadd(this.whiteboardEditorsKey(sessionId), normalizedId);

    // If this is an invited co-teacher, keep their hset flag in sync
    if (normalizedId.startsWith('teacher_')) {
      const raw = await redis.hget(this.invitedTeachersKey(sessionId), normalizedId);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as InvitedTeacherEntry;
          parsed.canUseWhiteboard = true;
          await redis.hset(
            this.invitedTeachersKey(sessionId),
            normalizedId,
            JSON.stringify(parsed)
          );
        } catch {
          // ignore
        }
      }
    }

    const editors = await this.getWhiteboardEditors(sessionId);
    await RoomManager.appendPacket(sessionId, 'WHITEBOARD_ACCESS_UPDATED', {
      whiteboardEditors: editors,
      targetUserId: normalizedId,
      canEdit: true,
    });
    return editors;
  }

  /**
   * Teacher revokes Whiteboard edit access from a student (or co-teacher).
   */
  public static async revokeWhiteboardAccess(
    sessionId: string,
    targetUserId: string
  ): Promise<string[]> {
    const normalizedId =
      targetUserId.startsWith('student_') || targetUserId.startsWith('teacher_')
        ? targetUserId
        : `student_${targetUserId}`;

    await redis.srem(this.whiteboardEditorsKey(sessionId), normalizedId);
    await redis.srem(this.whiteboardEditorsKey(sessionId), targetUserId);

    if (normalizedId.startsWith('teacher_')) {
      const raw = await redis.hget(this.invitedTeachersKey(sessionId), normalizedId);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as InvitedTeacherEntry;
          parsed.canUseWhiteboard = false;
          await redis.hset(
            this.invitedTeachersKey(sessionId),
            normalizedId,
            JSON.stringify(parsed)
          );
        } catch {
          // ignore
        }
      }
    }

    const editors = await this.getWhiteboardEditors(sessionId);
    await RoomManager.appendPacket(sessionId, 'WHITEBOARD_ACCESS_UPDATED', {
      whiteboardEditors: editors,
      targetUserId: normalizedId,
      canEdit: false,
    });
    return editors;
  }

  private static DEMO_CO_TEACHER_IDS = new Set(['teacher_502', 'teacher_503', 'teacher_504']);

  /**
   * Normalizes teacher ID comparisons (e.g., "42" vs "teacher_42" vs 42).
   */
  public static teacherIdsMatch(
    a?: string | number | null,
    b?: string | number | null
  ): boolean {
    if (a === undefined || a === null || b === undefined || b === null) return false;
    const normA = String(a).trim().replace(/^teacher_/, '');
    const normB = String(b).trim().replace(/^teacher_/, '');
    return normA.length > 0 && normA === normB;
  }

  /**
   * Determines whether a teacher user is the Primary Host Teacher for the session
   * (supporting both real numeric Laravel teacher IDs and mock teacher_501),
   * versus an Invited Co-Teacher.
   */
  public static async isHostTeacher(
    sessionId: string,
    user: UserAuthPayload,
    sessionTeacherId?: string | number | null
  ): Promise<boolean> {
    if (!user || user.role !== 'teacher') return false;
    if (user.isCoTeacher) return false;
    if (this.DEMO_CO_TEACHER_IDS.has(user.userId)) return false;

    const cleanId = user.userId.startsWith('teacher_') ? user.userId : `teacher_${user.userId}`;
    const invitedEntry =
      (await redis.hget(this.invitedTeachersKey(sessionId), cleanId)) ||
      (await redis.hget(this.invitedTeachersKey(sessionId), user.userId));

    // If explicitly registered in the invited Co-Teachers map and not the session owner, they are a Co-Teacher
    if (invitedEntry) {
      if (sessionTeacherId && this.teacherIdsMatch(user.userId, sessionTeacherId)) {
        return true;
      }
      return false;
    }

    if (sessionTeacherId && sessionTeacherId !== 'teacher_501') {
      return this.teacherIdsMatch(user.userId, sessionTeacherId);
    }

    return true;
  }

  /**
   * Determines whether a participant is authorized to edit the live Whiteboard:
   * - Primary Host Teacher (real Laravel session owner or mock teacher_501) is always authorized.
   * - Invited Co-Teacher (role === 'teacher') is authorized if in whiteboardEditors or invited with canUseWhiteboard.
   * - Student is authorized if their studentId / userId is in whiteboardEditors.
   */
  public static async canUserEditWhiteboard(
    sessionId: string,
    user: UserAuthPayload
  ): Promise<boolean> {
    if (!user) return false;
    // Host teacher always has full Whiteboard control
    if (user.role === 'teacher' && (await this.isHostTeacher(sessionId, user))) {
      return true;
    }

    const editorsKey = this.whiteboardEditorsKey(sessionId);
    const isMember = await redis.sismember(editorsKey, user.userId);
    if (isMember === 1) return true;

    if (user.role === 'student') {
      const cleanNum = user.userId.replace(/^student_/, '');
      const altMember = await redis.sismember(editorsKey, `student_${cleanNum}`);
      return altMember === 1;
    }

    if (user.role === 'teacher') {
      const cleanId = user.userId.startsWith('teacher_') ? user.userId : `teacher_${user.userId}`;
      const raw =
        (await redis.hget(this.invitedTeachersKey(sessionId), cleanId)) ||
        (await redis.hget(this.invitedTeachersKey(sessionId), user.userId));
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as InvitedTeacherEntry;
          return Boolean(parsed.canUseWhiteboard);
        } catch {
          return false;
        }
      }
    }

    return false;
  }

  /**
   * Teacher approves student mic. Enforces Strict Max 10 Concurrent Student Mics Rule.
   */
  public static async grantStudentMic(
    sessionId: string,
    studentId: string,
    forceReplaceOldest = false
  ): Promise<{ success: boolean; studentId: string; token?: string; evictedStudentId?: string; autoActivate?: boolean }> {
    const micsKey = this.activeMicsKey(sessionId);
    const activeCount = await redis.scard(micsKey);

    let evictedStudentId: string | undefined;

    // Check concurrency limit (Formula B / Rule 2)
    if (activeCount >= this.MAX_CONCURRENT_STUDENT_MICS) {
      const alreadyActive = await redis.sismember(micsKey, studentId);
      if (!alreadyActive) {
        if (!forceReplaceOldest) {
          throw new Error(
            'Maximum 10 students can have an open microphone simultaneously. Please mute an active student first.'
          );
        }

        // Evict oldest speaker
        const activeMembers = await redis.smembers(micsKey);
        evictedStudentId = activeMembers[0];
        if (evictedStudentId) {
          await this.muteStudent(sessionId, evictedStudentId);
        }
      }
    }

    await redis.sadd(micsKey, studentId);
    await this.lowerHand(sessionId, studentId);

    // Update LiveKit participant permission
    try {
      await livekitRoomService.updateParticipant(sessionId, studentId, undefined, {
        canPublish: true,
      });
    } catch (err: any) {
      console.warn(`[AudioStageController] LiveKit SFU update participant note: ${err.message}`);
    }

    // Generate fresh LiveKit token with publish permission
    const token = await generateLiveKitToken({
      roomName: sessionId,
      participantIdentity: studentId,
      participantName: `Student-${studentId}`,
      canPublishAudio: true,
      canSubscribe: true,
    });

    await RoomManager.appendPacket(sessionId, 'AUDIO_MIC_GRANTED', {
      studentId,
      evictedStudentId,
      autoActivate: true,
    });

    return { success: true, studentId, token, evictedStudentId, autoActivate: true };
  }

  /**
   * Teacher mutes individual student mic.
   */
  public static async muteStudent(
    sessionId: string,
    studentId: string
  ): Promise<boolean> {
    const micsKey = this.activeMicsKey(sessionId);
    await redis.srem(micsKey, studentId);

    try {
      await livekitRoomService.updateParticipant(sessionId, studentId, undefined, {
        canPublish: false,
      });
    } catch (err: any) {
      console.warn(`[AudioStageController] LiveKit mute note: ${err.message}`);
    }

    await RoomManager.appendPacket(sessionId, 'AUDIO_MIC_REVOKED', { studentId });
    return true;
  }

  /**
   * Teacher executes emergency "Mute All Students".
   */
  public static async muteAllStudents(sessionId: string): Promise<string[]> {
    const micsKey = this.activeMicsKey(sessionId);
    const mutedStudents = await redis.smembers(micsKey);

    await redis.del(micsKey);

    for (const studentId of mutedStudents) {
      try {
        await livekitRoomService.updateParticipant(sessionId, studentId, undefined, {
          canPublish: false,
        });
      } catch {
        // Silently continue
      }
    }

    await RoomManager.appendPacket(sessionId, 'AUDIO_MUTE_ALL', {
      mutedStudents,
      timestamp: Date.now(),
    });

    return mutedStudents;
  }
}
