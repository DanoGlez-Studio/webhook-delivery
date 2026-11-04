import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../errors/AppError.js';
import {
  createEvent,
  getEventById,
  listEvents,
  retryEvent,
} from '../services/events.js';

const createEventBodySchema = z.object({
  targetUrl: z.string().url(),
  payload: z.any(),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/events', {
    schema: {
      tags: ['Events'],
      summary: 'Enqueue a webhook delivery event',
      body: {
        type: 'object',
        required: ['targetUrl', 'payload'],
        properties: {
          targetUrl: { type: 'string', format: 'uri' },
          payload: {},
          idempotencyKey: { type: 'string' },
        },
      },
      response: {
        202: {
          type: 'object',
          properties: {
            eventId: { type: 'string', format: 'uuid' },
            status: { type: 'string' },
            created: { type: 'boolean' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const parsed = createEventBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid event body', parsed.error.flatten());
    }

    const { event, created } = await createEvent({
      targetUrl: parsed.data.targetUrl,
      payload: parsed.data.payload as unknown,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    return reply.status(202).send({
      eventId: event.id,
      status: event.status,
      created,
    });
  });

  app.get('/api/v1/events', {
    schema: {
      tags: ['Events'],
      summary: 'List webhook events',
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 50 },
          offset: { type: 'integer', default: 0 },
        },
      },
    },
  }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    const { events, total } = await listEvents(query.limit, query.offset);
    return {
      total,
      limit: query.limit,
      offset: query.offset,
      events: events.map((event) => ({
        id: event.id,
        targetUrl: event.target_url,
        status: event.status,
        attemptCount: event.attempt_count,
        nextAttemptAt: event.next_attempt_at,
        createdAt: event.created_at,
        updatedAt: event.updated_at,
        idempotencyKey: event.idempotency_key,
        lastAttempt: event.last_attempt
          ? {
              attemptNumber: event.last_attempt.attempt_number,
              httpStatus: event.last_attempt.http_status,
              latencyMs: event.last_attempt.latency_ms,
              errorMessage: event.last_attempt.error_message,
              createdAt: event.last_attempt.created_at,
            }
          : null,
      })),
    };
  });

  app.get('/api/v1/events/:id', {
    schema: {
      tags: ['Events'],
      summary: 'Get event detail and attempt history',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const result = await getEventById(id);
    if (!result) {
      throw new NotFoundError(`Event ${id} not found`);
    }

    const { event, attempts } = result;
    return {
      id: event.id,
      targetUrl: event.target_url,
      payload: event.payload,
      status: event.status,
      attemptCount: event.attempt_count,
      nextAttemptAt: event.next_attempt_at,
      createdAt: event.created_at,
      updatedAt: event.updated_at,
      idempotencyKey: event.idempotency_key,
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        attemptNumber: attempt.attempt_number,
        httpStatus: attempt.http_status,
        responseHeaders: attempt.response_headers,
        latencyMs: attempt.latency_ms,
        errorMessage: attempt.error_message,
        createdAt: attempt.created_at,
      })),
    };
  });

  app.post('/api/v1/events/:id/retry', {
    schema: {
      tags: ['Events'],
      summary: 'Manually re-enqueue a webhook event',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const event = await retryEvent(id);
    if (!event) {
      throw new NotFoundError(`Event ${id} not found`);
    }

    return reply.status(202).send({
      eventId: event.id,
      status: event.status,
      retried: true,
    });
  });
}
