import { redis } from '../../config/redis';
import { env } from '../../config/env';
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

  private static multiDeviceStudentsKey(sessionId: string): string {
    return `room:${sessionId}:multi_device_students`;
  }

  private static studentDevicesKey(sessionId: string, studentId: string): string {
    const norm = this.normalizeStudentId(studentId);
    return `room:${sessionId}:student_devices:${norm}`;
  }

  public static DEVICE_STALE_MS = 45_000;

  public static normalizeStudentId(studentId: string): string {
    const clean = String(studentId || '').trim();
    if (!clean) return clean;
    if (clean.startsWith('student_') || clean.startsWith('teacher_')) return clean;
    return `student_${clean}`;
  }

  public static buildParticipantIdentity(userId: string, deviceId?: string): string {
    const cleanDevice = typeof deviceId === 'string' ? deviceId.trim() : '';
    return cleanDevice ? `${userId}__${cleanDevice}` : userId;
  }

  /**
   * Generates a LiveKit connection token for participant.
   * When deviceId is provided, mints a per-device LiveKit identity (`${userId}__${deviceId}`)
   * so multiple authorized devices for the same student never collide or disconnect each other in LiveKit SFU.
   */
  public static async getJoinToken(
    sessionId: string,
    userId: string,
    name: string,
    role: 'teacher' | 'student',
    deviceIdOrForcePublish?: string | boolean,
    maybeDeviceId?: string
  ): Promise<{ token: string; url: string; canPublishAudio: boolean; participantIdentity: string }> {
    let canPublish = false;
    const deviceId =
      typeof deviceIdOrForcePublish === 'string'
        ? deviceIdOrForcePublish
        : typeof maybeDeviceId === 'string'
        ? maybeDeviceId
        : undefined;
    const forcePublish =
      typeof deviceIdOrForcePublish === 'boolean' ? deviceIdOrForcePublish : undefined;

    if (forcePublish !== undefined) {
      canPublish = forcePublish;
    } else if (role === 'teacher') {
      canPublish = true;
    } else {
      // Check if student currently has mic permission or if students are allowed to unmute
      const normId = this.normalizeStudentId(userId);
      const [hasMicRaw, hasMicNorm, allowUnmute] = await Promise.all([
        redis.sismember(this.activeMicsKey(sessionId), userId),
        redis.sismember(this.activeMicsKey(sessionId), normId),
        this.getAllowStudentUnmute(sessionId),
      ]);
      canPublish = hasMicRaw === 1 || hasMicNorm === 1 || allowUnmute;
    }

    const participantIdentity = this.buildParticipantIdentity(userId, deviceId);

    const token = await generateLiveKitToken({
      roomName: sessionId,
      participantIdentity,
      participantName: name,
      canPublishAudio: canPublish,
      canSubscribe: true,
    });

    return {
      token,
      url: env.LIVEKIT_PUBLIC_URL || env.LIVEKIT_URL,
      canPublishAudio: canPublish,
      participantIdentity,
    };
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
    multiDeviceStudents: string[];
  }> {
    const [
      activeStudentMics,
      raisedHands,
      teacherMicActive,
      invitedTeachers,
      whiteboardEditors,
      allowStudentUnmute,
      multiDeviceStudents,
    ] = await Promise.all([
      this.getActiveStudentMics(sessionId),
      this.getRaisedHands(sessionId),
      this.getTeacherMicActive(sessionId),
      this.getInvitedTeachers(sessionId),
      this.getWhiteboardEditors(sessionId),
      this.getAllowStudentUnmute(sessionId),
      this.getMultiDeviceStudents(sessionId),
    ]);
    return {
      activeStudentMics,
      raisedHands,
      maxStudentMics: this.MAX_CONCURRENT_STUDENT_MICS,
      teacherMicActive,
      invitedTeachers,
      whiteboardEditors,
      allowStudentUnmute,
      multiDeviceStudents,
    };
  }

  /**
   * Retrieves list of students whom the Host Teacher has allowed to join from multiple devices simultaneously.
   */
  public static async getMultiDeviceStudents(sessionId: string): Promise<string[]> {
    return await redis.smembers(this.multiDeviceStudentsKey(sessionId));
  }

  /**
   * Checks whether a particular student is permitted by the Host Teacher to join from multiple devices.
   */
  public static async isStudentMultiDeviceAllowed(
    sessionId: string,
    studentId: string
  ): Promise<boolean> {
    const norm = this.normalizeStudentId(studentId);
    const [rawMember, normMember] = await Promise.all([
      redis.sismember(this.multiDeviceStudentsKey(sessionId), studentId),
      redis.sismember(this.multiDeviceStudentsKey(sessionId), norm),
    ]);
    return rawMember === 1 || normMember === 1;
  }

  /**
   * Host Teacher enables or disables multi-device join access for a specific student.
   */
  public static async setStudentMultiDeviceAccess(
    sessionId: string,
    studentId: string,
    allow: boolean
  ): Promise<string[]> {
    const norm = this.normalizeStudentId(studentId);
    const rawClean = String(studentId || '').replace(/^student_/, '');
    const key = this.multiDeviceStudentsKey(sessionId);

    if (allow) {
      await redis.sadd(key, norm, rawClean);
    } else {
      await redis.srem(key, norm, rawClean, studentId);
    }

    const multiDeviceStudents = await this.getMultiDeviceStudents(sessionId);
    await RoomManager.appendPacket(sessionId, 'STUDENT_MULTI_DEVICE_UPDATED', {
      studentId: norm,
      allow,
      multiDeviceStudents,
    });
    return multiDeviceStudents;
  }

  /**
   * Retrieves active (non-stale) connected devices for a student in the session.
   */
  public static async getStudentActiveDevices(
    sessionId: string,
    studentId: string,
    activeSocketIds?: Set<string>
  ): Promise<
    Array<{
      deviceId: string;
      socketId?: string;
      lastSeenAt: number;
      micActive: boolean;
    }>
  > {
    const key = this.studentDevicesKey(sessionId, studentId);
    const rawMap = await redis.hgetall(key);
    if (!rawMap) return [];

    const now = Date.now();
    const valid: Array<{
      deviceId: string;
      socketId?: string;
      lastSeenAt: number;
      micActive: boolean;
    }> = [];
    const staleDeviceIds: string[] = [];

    for (const [devId, rawJson] of Object.entries(rawMap)) {
      try {
        const parsed = JSON.parse(rawJson);
        const lastSeenAt = Number(parsed?.lastSeenAt || 0);
        const isTimeStale = now - lastSeenAt > this.DEVICE_STALE_MS;
        const isSocketGone =
          activeSocketIds &&
          activeSocketIds.size > 0 &&
          parsed?.socketId &&
          !activeSocketIds.has(parsed.socketId);

        if (isTimeStale || isSocketGone) {
          staleDeviceIds.push(devId);
        } else {
          valid.push({
            deviceId: parsed.deviceId || devId,
            socketId: parsed.socketId,
            lastSeenAt,
            micActive: Boolean(parsed.micActive),
          });
        }
      } catch {
        staleDeviceIds.push(devId);
      }
    }

    if (staleDeviceIds.length > 0) {
      await redis.hdel(key, ...staleDeviceIds);
    }

    return valid;
  }

  /**
   * Enforces Single-Device Student Join Rule (unless Host Teacher enabled multi-device for this student).
   * - Same deviceId reconnecting/refreshing is always allowed.
   * - Different deviceId while another device is active is blocked unless multi-device is enabled for this student.
   */
  public static async canStudentDeviceJoin(
    sessionId: string,
    studentId: string,
    deviceId?: string,
    socketId?: string,
    activeSocketIds?: Set<string>
  ): Promise<{
    allowed: boolean;
    activeDeviceId?: string;
    allowMultiDevice: boolean;
  }> {
    const effectiveDeviceId =
      (typeof deviceId === 'string' && deviceId.trim()) || socketId || 'default_device';
    const allowMultiDevice = await this.isStudentMultiDeviceAllowed(sessionId, studentId);
    const activeDevices = await this.getStudentActiveDevices(
      sessionId,
      studentId,
      activeSocketIds
    );

    const otherActiveDevice = activeDevices.find((d) => d.deviceId !== effectiveDeviceId);
    if (!allowMultiDevice && otherActiveDevice) {
      return {
        allowed: false,
        activeDeviceId: otherActiveDevice.deviceId,
        allowMultiDevice: false,
      };
    }

    const existingSameDevice = activeDevices.find((d) => d.deviceId === effectiveDeviceId);
    const key = this.studentDevicesKey(sessionId, studentId);
    await redis.hset(
      key,
      effectiveDeviceId,
      JSON.stringify({
        deviceId: effectiveDeviceId,
        socketId: socketId || existingSameDevice?.socketId,
        lastSeenAt: Date.now(),
        micActive: existingSameDevice ? Boolean(existingSameDevice.micActive) : false,
      })
    );

    return {
      allowed: true,
      activeDeviceId: effectiveDeviceId,
      allowMultiDevice,
    };
  }

  /**
   * Refreshes heartbeat timestamp for a student's active device.
   */
  public static async touchStudentDevice(
    sessionId: string,
    studentId: string,
    deviceId?: string,
    socketId?: string
  ): Promise<void> {
    const effectiveDeviceId =
      (typeof deviceId === 'string' && deviceId.trim()) || socketId || 'default_device';
    const key = this.studentDevicesKey(sessionId, studentId);
    const existingRaw = await redis.hget(key, effectiveDeviceId);
    let micActive = false;
    let resolvedSocketId = socketId;
    if (existingRaw) {
      try {
        const parsed = JSON.parse(existingRaw);
        micActive = Boolean(parsed.micActive);
        resolvedSocketId = socketId || parsed.socketId;
      } catch {
        // ignore
      }
    }
    await redis.hset(
      key,
      effectiveDeviceId,
      JSON.stringify({
        deviceId: effectiveDeviceId,
        socketId: resolvedSocketId,
        lastSeenAt: Date.now(),
        micActive,
      })
    );
  }

  /**
   * Removes a disconnected student device from Redis and returns whether any remaining device still has an active mic.
   */
  public static async removeStudentDevice(
    sessionId: string,
    studentId: string,
    deviceId?: string,
    socketId?: string
  ): Promise<{ remainingDevices: number; anyDeviceMicActive: boolean }> {
    const key = this.studentDevicesKey(sessionId, studentId);
    const rawMap = await redis.hgetall(key);
    if (!rawMap) {
      return { remainingDevices: 0, anyDeviceMicActive: false };
    }

    const toDelete: string[] = [];
    for (const [devId, rawJson] of Object.entries(rawMap)) {
      if (deviceId && devId === deviceId) {
        toDelete.push(devId);
        continue;
      }
      if (socketId) {
        try {
          const parsed = JSON.parse(rawJson);
          if (parsed?.socketId === socketId) {
            toDelete.push(devId);
          }
        } catch {
          toDelete.push(devId);
        }
      }
    }

    if (toDelete.length > 0) {
      await redis.hdel(key, ...toDelete);
    }

    const remaining = await this.getStudentActiveDevices(sessionId, studentId);
    const anyDeviceMicActive = remaining.some((d) => d.micActive);
    return {
      remainingDevices: remaining.length,
      anyDeviceMicActive,
    };
  }

  /**
   * Updates per-device microphone state for a student so multiple devices have independent mic state.
   */
  public static async setStudentDeviceMicState(
    sessionId: string,
    studentId: string,
    deviceId: string | undefined,
    micActive: boolean
  ): Promise<{ anyDeviceMicActive: boolean }> {
    const effectiveDeviceId =
      (typeof deviceId === 'string' && deviceId.trim()) || 'default_device';
    const key = this.studentDevicesKey(sessionId, studentId);
    const existingRaw = await redis.hget(key, effectiveDeviceId);
    let socketId: string | undefined;
    if (existingRaw) {
      try {
        socketId = JSON.parse(existingRaw)?.socketId;
      } catch {
        // ignore
      }
    }

    await redis.hset(
      key,
      effectiveDeviceId,
      JSON.stringify({
        deviceId: effectiveDeviceId,
        socketId,
        lastSeenAt: Date.now(),
        micActive,
      })
    );

    if (micActive) {
      await redis.sadd(this.activeMicsKey(sessionId), studentId);
    }

    const activeDevices = await this.getStudentActiveDevices(sessionId, studentId);
    const anyDeviceMicActive = activeDevices.some((d) => d.micActive);
    return { anyDeviceMicActive };
  }

  /**
   * Mutes a single student device (`deviceId`) without muting or revoking audio on the student's other active devices.
   * Only removes `studentId` from `activeStudentMics` when ALL of the student's devices are muted.
   */
  public static async muteStudentDevice(
    sessionId: string,
    studentId: string,
    deviceId?: string
  ): Promise<{ studentId: string; deviceId?: string; anyDeviceMicActive: boolean }> {
    if (!deviceId) {
      await this.muteStudent(sessionId, studentId);
      return { studentId, anyDeviceMicActive: false };
    }

    const { anyDeviceMicActive } = await this.setStudentDeviceMicState(
      sessionId,
      studentId,
      deviceId,
      false
    );

    if (!anyDeviceMicActive) {
      const norm = this.normalizeStudentId(studentId);
      const rawClean = String(studentId || '').replace(/^student_/, '');
      await redis.srem(this.activeMicsKey(sessionId), studentId, norm, rawClean);
    }

    return {
      studentId,
      deviceId,
      anyDeviceMicActive,
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
   * Also mints per-device LiveKit tokens (`deviceTokens`) for all active devices of the student
   * so multiple authorized devices can use their microphones independently without LiveKit identity collisions.
   */
  public static async grantStudentMic(
    sessionId: string,
    studentId: string,
    forceReplaceOldest = false,
    targetDeviceId?: string
  ): Promise<{
    success: boolean;
    studentId: string;
    token?: string;
    deviceTokens?: Record<string, string>;
    targetDeviceId?: string;
    evictedStudentId?: string;
    autoActivate?: boolean;
  }> {
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

    // Check if student raised hand from a specific device before clearing hand
    let raisedHandDeviceId: string | undefined;
    try {
      const handMetaRaw = await redis.hget(this.raisedHandsMetaKey(sessionId), studentId);
      if (handMetaRaw) {
        const parsedHand = JSON.parse(handMetaRaw);
        if (parsedHand?.deviceId) {
          raisedHandDeviceId = String(parsedHand.deviceId);
        }
      }
    } catch {
      // ignore
    }

    await redis.sadd(micsKey, studentId);
    await this.lowerHand(sessionId, studentId);

    const activeDevices = await this.getStudentActiveDevices(sessionId, studentId);
    const resolvedTargetDeviceId =
      targetDeviceId ||
      raisedHandDeviceId ||
      (activeDevices.length === 1 ? activeDevices[0].deviceId : undefined);

    // Update LiveKit participant permission for base identity and any active device identities
    const identitiesToUpdate = [
      studentId,
      ...activeDevices.map((d) => this.buildParticipantIdentity(studentId, d.deviceId)),
    ];
    for (const identity of identitiesToUpdate) {
      try {
        await livekitRoomService.updateParticipant(sessionId, identity, undefined, {
          canPublish: true,
        });
      } catch (err: any) {
        console.warn(`[AudioStageController] LiveKit SFU update participant note: ${err.message}`);
      }
    }

    // Generate fresh LiveKit token with publish permission (base identity + per-device identities)
    const token = await generateLiveKitToken({
      roomName: sessionId,
      participantIdentity: studentId,
      participantName: `Student-${studentId}`,
      canPublishAudio: true,
      canSubscribe: true,
    });

    const deviceTokens: Record<string, string> = {};
    for (const dev of activeDevices) {
      deviceTokens[dev.deviceId] = await generateLiveKitToken({
        roomName: sessionId,
        participantIdentity: this.buildParticipantIdentity(studentId, dev.deviceId),
        participantName: `Student-${studentId}`,
        canPublishAudio: true,
        canSubscribe: true,
      });
    }
    if (resolvedTargetDeviceId && !deviceTokens[resolvedTargetDeviceId]) {
      deviceTokens[resolvedTargetDeviceId] = await generateLiveKitToken({
        roomName: sessionId,
        participantIdentity: this.buildParticipantIdentity(studentId, resolvedTargetDeviceId),
        participantName: `Student-${studentId}`,
        canPublishAudio: true,
        canSubscribe: true,
      });
    }

    await RoomManager.appendPacket(sessionId, 'AUDIO_MIC_GRANTED', {
      studentId,
      targetDeviceId: resolvedTargetDeviceId,
      evictedStudentId,
      autoActivate: true,
    });

    return {
      success: true,
      studentId,
      token,
      deviceTokens,
      targetDeviceId: resolvedTargetDeviceId,
      evictedStudentId,
      autoActivate: true,
    };
  }

  /**
   * Teacher mutes individual student mic across all devices of that student.
   */
  public static async muteStudent(
    sessionId: string,
    studentId: string
  ): Promise<boolean> {
    const micsKey = this.activeMicsKey(sessionId);
    const norm = this.normalizeStudentId(studentId);
    const rawClean = String(studentId || '').replace(/^student_/, '');
    await redis.srem(micsKey, studentId, norm, rawClean);

    const activeDevices = await this.getStudentActiveDevices(sessionId, studentId);
    for (const dev of activeDevices) {
      await this.setStudentDeviceMicState(sessionId, studentId, dev.deviceId, false);
    }

    const identitiesToMute = [
      studentId,
      ...activeDevices.map((d) => this.buildParticipantIdentity(studentId, d.deviceId)),
    ];
    for (const identity of identitiesToMute) {
      try {
        await livekitRoomService.updateParticipant(sessionId, identity, undefined, {
          canPublish: false,
        });
      } catch (err: any) {
        console.warn(`[AudioStageController] LiveKit mute note: ${err.message}`);
      }
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
