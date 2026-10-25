export interface AttendanceSegment {
  joinedAt: number;
  leftAt: number;
  durationSeconds: number;
}

export interface StudentAttendanceRecord {
  userId: string;
  name: string;
  role: 'student';
  rollNumber?: string;
  email?: string;
  avatar?: string;
  firstJoinedAt: number;
  lastSeenAt: number;
  rejoinCount: number;
  segments: AttendanceSegment[];
  totalJoinedSeconds: number;
  isOnline: boolean;
  currentSocketId?: string;
  tempDisconnectAt?: number | null;
}

export type AttendanceStatus = 'present' | 'partial' | 'late' | 'absent';

export interface StudentAttendanceCalculation {
  userId: string;
  name: string;
  rollNumber?: string;
  email?: string;
  avatar?: string;
  firstJoinedAt: number;
  lastSeenAt: number;
  leftAt?: number | null;
  rejoinCount: number;
  isOnline: boolean;
  totalJoinedSeconds: number;
  totalJoinedMinutes: number;
  totalJoinedHours: number;
  attendancePercentage: number;
  status: AttendanceStatus;
}

export interface SessionAttendanceSummary {
  sessionId: string;
  teacherId: string;
  teacherName: string;
  sessionTitle: string;
  startTime: string;
  endTime: string;
  totalClassDurationSeconds: number;
  totalStudentsCount: number;
  presentCount: number;
  partialCount: number;
  lateOrAbsentCount: number;
  students: StudentAttendanceCalculation[];
  metadata: Record<string, any>;
}
