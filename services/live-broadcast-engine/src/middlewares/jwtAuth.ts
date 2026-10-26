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

  if (!token || token === 'undefined' || token === 'null' || token.startsWith('DEV_TOKEN_')) {
    reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Valid classroom authentication token is required.',
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
      message: 'Invalid or expired classroom authentication token.',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (
    user.sessionId &&
    user.sessionId !== '*' &&
    sessionId &&
    String(user.sessionId) !== String(sessionId)
  ) {
    reply.status(403).send({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Token does not match the requested live classroom session.',
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
    const token =
      rawToken && rawToken !== 'undefined' && rawToken !== 'null'
        ? String(rawToken).trim()
        : '';
    const rawSessionId = (auth.sessionId || query.sessionId || '') as string;
    const sessionId =
      rawSessionId && rawSessionId !== 'undefined' && rawSessionId !== 'null'
        ? String(rawSessionId).trim()
        : '';

    if (!token || token.startsWith('DEV_TOKEN_') || !sessionId) {
      return next(new Error('Authentication failed: Valid classroom token and sessionId are required.'));
    }

    const provider = getDataProvider();
    const user = await provider.validateToken(token, sessionId);

    if (!user) {
      return next(new Error('Authentication failed: Invalid token credentials.'));
    }

    if (user.userId === 'cohost_invite' || user.userId === 'teacher_cohost_invite') {
      const rawDevId = String(auth.deviceId || query.deviceId || socket.id || 'default').trim();
      const cleanSuffix = rawDevId
        .replace(/^dev_/, '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(-8)
        .toLowerCase();
      user.userId = `teacher_cohost_${cleanSuffix || '1'}`;
      if (!user.name || user.name === 'Co-Host Invite') {
        user.name = `Co-Host (${cleanSuffix.slice(0, 4).toUpperCase() || '1'})`;
      }
      user.isCoTeacher = true;
    }

    socket.user = user;
    socket.sessionId = user.sessionId || sessionId;
    next();
  } catch (err: any) {
    next(new Error(`Authentication error: ${err.message}`));
  }
}
