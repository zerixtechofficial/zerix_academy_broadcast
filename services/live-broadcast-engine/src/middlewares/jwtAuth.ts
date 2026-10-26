import { FastifyReply, FastifyRequest } from 'fastify';
import { Socket } from 'socket.io';
import { getDataProvider } from '../adapters';
import { UserAuthPayload } from '../types/broadcast.types';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserAuthPayload;
  }
}

declare module 'socket.io' {
  interface Socket {
    user?: UserAuthPayload;
    sessionId?: string;
  }
}

/**
 * Fastify preHandler hook for REST endpoints requiring authentication.
 */
export async function authenticateFastify(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  const queryToken = (request.query as any)?.token;
  const sessionId =
    (request.params as any)?.sessionId ||
    (request.query as any)?.sessionId ||
    (request.body as any)?.sessionId;

  let token = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (queryToken) {
    token = String(queryToken).trim();
  }

  // Protected REST routes require an explicit Bearer token or ?token parameter.
  // Query-based ?role= fallback is strictly disabled unless ALLOW_QUERY_ROLE_BYPASS=true in non-production.
  if (
    !token &&
    process.env.ALLOW_QUERY_ROLE_BYPASS === 'true' &&
    process.env.NODE_ENV !== 'production' &&
    ((request.query as any)?.role || (request.query as any)?.studentId)
  ) {
    const role = (request.query as any)?.role;
    const studentId = (request.query as any)?.studentId;
    token = role === 'teacher' ? 'DEV_TOKEN_TEACHER_501' : `DEV_TOKEN_STUDENT_${studentId || '101'}`;
  }

  if (!token) {
    reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Authentication token is required via Bearer header or ?token query param.',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const provider = getDataProvider();
  const user = await provider.validateToken(token, sessionId);

  if (!user) {
    reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid or expired authentication token.',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  request.user = user;
}

/**
 * Fastify preHandler hook for session mutation endpoints that require
 * an authenticated Teacher (or Host/Co-Teacher) for the target session.
 */
export async function requireTeacherFastify(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await authenticateFastify(request, reply);
  if (reply.sent || !request.user) {
    return;
  }

  if (request.user.role !== 'teacher') {
    reply.status(403).send({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Only authenticated teachers can mutate live session recordings, curriculum segments, or whiteboard artifacts.',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const sessionId =
    (request.params as any)?.sessionId ||
    (request.query as any)?.sessionId ||
    (request.body as any)?.sessionId;

  if (
    request.user.sessionId &&
    request.user.sessionId !== '*' &&
    sessionId &&
    request.user.sessionId !== sessionId
  ) {
    reply.status(403).send({
      statusCode: 403,
      error: 'Forbidden',
      message: `Teacher token is scoped to session "${request.user.sessionId}" and cannot mutate session "${sessionId}".`,
      timestamp: new Date().toISOString(),
    });
    return;
  }
}

/**
 * Socket.io middleware verifying handshake auth before socket connects.
 */
export async function authenticateSocket(
  socket: Socket,
  next: (err?: Error) => void
): Promise<void> {
  try {
    const auth = socket.handshake.auth || {};
    const query = socket.handshake.query || {};

    const rawToken = (auth.token || query.token || '') as string;
    let token =
      rawToken && rawToken !== 'undefined' && rawToken !== 'null'
        ? String(rawToken).trim()
        : '';
    const sessionId = (auth.sessionId || query.sessionId || 'batch_physics_101') as string;

    // Support 1-click dev testing switcher (?role=teacher or ?role=student&studentId=101..112)
    if (!token) {
      const role = auth.role || query.role;
      const studentId = auth.studentId || query.studentId;
      const teacherId = auth.teacherId || query.teacherId;

      if (role === 'teacher') {
        const cleanTeacherId = teacherId ? String(teacherId).replace(/^teacher_/, '') : '501';
        token = `DEV_TOKEN_TEACHER_${cleanTeacherId}`;
      } else if (role === 'student' || studentId) {
        token = `DEV_TOKEN_STUDENT_${studentId || '101'}`;
      }
    }

    if (!token) {
      return next(new Error('Authentication failed: Missing token or role specification.'));
    }

    const provider = getDataProvider();
    const user = await provider.validateToken(token, sessionId);

    if (!user) {
      return next(new Error('Authentication failed: Invalid token credentials.'));
    }

    socket.user = user;
    socket.sessionId = sessionId;
    next();
  } catch (err: any) {
    next(new Error(`Authentication error: ${err.message}`));
  }
}
