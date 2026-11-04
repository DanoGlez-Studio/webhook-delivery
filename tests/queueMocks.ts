import { vi } from 'vitest';

export const enqueueWebhookMock = vi.fn(
  async (_eventId: string, _delayMs = 0) => undefined,
);
export const enqueueDlqMock = vi.fn(async (_eventId: string) => undefined);

vi.mock('../src/queue/queues.js', async () => {
  const actual = await vi.importActual<typeof import('../src/queue/queues.js')>(
    '../src/queue/queues.js',
  );
  return {
    ...actual,
    enqueueWebhook: enqueueWebhookMock,
    enqueueDlq: enqueueDlqMock,
  };
});
