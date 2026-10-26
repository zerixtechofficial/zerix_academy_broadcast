import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { notifyTelegramErrorAsync } from '../modules/monitoring/telegram.service';

export interface ValidationErrorResponse {
  statusCode: number;
  error: string;
  message: string;
  details?: Record<string, string>;
  timestamp: string;
}

export function validationErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  if (error.validation) {
    const details: Record<string, string> = {};
    let friendlyMessage = 'Request validation failed.';

    for (const v of error.validation) {
      const fieldPath = v.instancePath
        ? v.instancePath.replace(/^\//, '')
        : (v.params as any)?.missingProperty || 'field';
      let message = v.message || 'is invalid';

      if (v.keyword === 'required') {
        const missing = (v.params as any)?.missingProperty;
        message = `The field '${missing}' is required and cannot be omitted.`;
        details[missing] = message;
      } else if (v.keyword === 'type') {
        const expectedType = (v.params as any)?.type;
        message = `Expected type '${expectedType}' for field '${fieldPath}'.`;
        details[fieldPath] = message;
      } else if (v.keyword === 'minimum' || v.keyword === 'maximum') {
        message = `Value for '${fieldPath}' is out of allowed range: ${v.message}.`;
        details[fieldPath] = message;
      } else {
        details[fieldPath] = `Field '${fieldPath}': ${message}`;
      }
    }

    const detailKeys = Object.keys(details);
    if (detailKeys.length > 0) {
      friendlyMessage = details[detailKeys[0]];
    }

    const response: ValidationErrorResponse = {
      statusCode: 400,
      error: 'Bad Request: Validation Error',
      message: friendlyMessage,
      details,
      timestamp: new Date().toISOString(),
    };

    reply.status(400).send(response);
    return;
  }

  // Handle custom application errors with human-readable message
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    // Non-blocking background alert to Telegram group for unhandled 5xx HTTP errors
    notifyTelegramErrorAsync({
      source: 'Fastify HTTP Server',
      error,
      context: {
        method: request.method,
        url: request.url,
        statusCode,
        ip: request.ip,
      },
    });
  }

  reply.status(statusCode).send({
    statusCode,
    error: error.name || 'InternalServerError',
    message: error.message || 'An unexpected internal server error occurred.',
    timestamp: new Date().toISOString(),
  });
}
