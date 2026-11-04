import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from './AppError.js';

export function errorHandler(
  error: FastifyError | Error,
  _request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof AppError) {
    reply.status(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
    return;
  }

  if (error instanceof ZodError) {
    reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: error.flatten(),
      },
    });
    return;
  }

  const statusCode =
    'statusCode' in error && typeof error.statusCode === 'number'
      ? error.statusCode
      : 500;

  reply.status(statusCode).send({
    error: {
      code: statusCode === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
      message: statusCode === 500 ? 'Internal server error' : error.message,
    },
  });
}
