import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import apiReference from '@scalar/fastify-api-reference';
import { errorHandler } from './errors/errorHandler.js';
import { eventsRoutes } from './routes/events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  app.setErrorHandler(errorHandler);

  app.get('/health', {
    schema: {
      tags: ['Health'],
      summary: 'Liveness probe',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
          },
        },
      },
    },
  }, async () => ({ status: 'ok' }));

  await app.register(eventsRoutes);

  app.get('/', async (_request, reply) => {
    const htmlPath = path.join(__dirname, 'ui', 'dashboard.html');
    const html = await readFile(htmlPath, 'utf8');
    return reply.type('text/html').send(html);
  });

  await app.register(apiReference, {
    routePrefix: '/docs',
    configuration: {
      theme: 'default',
      spec: {
        content: {
          openapi: '3.1.0',
          info: {
            title: 'Webhook Delivery Engine',
            version: '1.0.0',
            description:
              'Reliable webhook delivery with HMAC signing, exponential backoff, and DLQ.',
          },
          paths: {
            '/health': {
              get: {
                tags: ['Health'],
                summary: 'Liveness probe',
                responses: {
                  200: {
                    description: 'Service is alive',
                  },
                },
              },
            },
            '/api/v1/events': {
              post: {
                tags: ['Events'],
                summary: 'Enqueue a webhook delivery event',
                requestBody: {
                  required: true,
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['targetUrl', 'payload'],
                        properties: {
                          targetUrl: { type: 'string', format: 'uri' },
                          payload: {},
                          idempotencyKey: { type: 'string' },
                        },
                      },
                    },
                  },
                },
                responses: {
                  202: { description: 'Event accepted' },
                },
              },
              get: {
                tags: ['Events'],
                summary: 'List webhook events',
                responses: {
                  200: { description: 'Paged event list' },
                },
              },
            },
            '/api/v1/events/{id}': {
              get: {
                tags: ['Events'],
                summary: 'Get event detail and attempt history',
                parameters: [
                  {
                    name: 'id',
                    in: 'path',
                    required: true,
                    schema: { type: 'string', format: 'uuid' },
                  },
                ],
                responses: {
                  200: { description: 'Event detail' },
                  404: { description: 'Not found' },
                },
              },
            },
            '/api/v1/events/{id}/retry': {
              post: {
                tags: ['Events'],
                summary: 'Manually re-enqueue a webhook event',
                parameters: [
                  {
                    name: 'id',
                    in: 'path',
                    required: true,
                    schema: { type: 'string', format: 'uuid' },
                  },
                ],
                responses: {
                  202: { description: 'Retry accepted' },
                  404: { description: 'Not found' },
                },
              },
            },
          },
        },
      },
    },
  });

  return app;
}
