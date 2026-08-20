import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DlqManager } from '../../../src/core/dlq_manager.js';

describe('DlqManager', () => {
  let prismaMock: any;
  let dlqManager: DlqManager;

  beforeEach(() => {
    prismaMock = {
      deadLetterMessage: {
        create: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    };
    dlqManager = new DlqManager(prismaMock);
  });

  it('pushes a message to the DLQ', async () => {
    prismaMock.deadLetterMessage.create.mockResolvedValue({ id: 'dlq-123' });

    const id = await dlqManager.push('webhook_delivery', { foo: 'bar' }, 'Timeout');

    expect(id).toBe('dlq-123');
    expect(prismaMock.deadLetterMessage.create).toHaveBeenCalledWith({
      data: {
        queueName: 'webhook_delivery',
        payload: { foo: 'bar' },
        errorReason: 'Timeout',
      },
    });
  });

  it('lists pending messages', async () => {
    const mockMsgs = [{ id: '1' }, { id: '2' }];
    prismaMock.deadLetterMessage.findMany.mockResolvedValue(mockMsgs);

    const msgs = await dlqManager.listPending('webhook_delivery');

    expect(msgs).toEqual(mockMsgs);
    expect(prismaMock.deadLetterMessage.findMany).toHaveBeenCalledWith({
      where: { status: 'pending', queueName: 'webhook_delivery' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  it('retries a message successfully', async () => {
    const mockHandler = vi.fn().mockResolvedValue(undefined);
    dlqManager.registerHandler('webhook_delivery', mockHandler);

    prismaMock.deadLetterMessage.findUnique.mockResolvedValue({
      id: 'dlq-123',
      queueName: 'webhook_delivery',
      status: 'pending',
      payload: { foo: 'bar' },
    });

    const result = await dlqManager.retry('dlq-123');

    expect(result.success).toBe(true);
    expect(mockHandler).toHaveBeenCalledWith({ foo: 'bar' });
    expect(prismaMock.deadLetterMessage.update).toHaveBeenCalledWith({
      where: { id: 'dlq-123' },
      data: { status: 'resolved' },
    });
  });

  it('handles retry failure correctly', async () => {
    const mockHandler = vi.fn().mockRejectedValue(new Error('Retry failed again'));
    dlqManager.registerHandler('webhook_delivery', mockHandler);

    prismaMock.deadLetterMessage.findUnique.mockResolvedValue({
      id: 'dlq-123',
      queueName: 'webhook_delivery',
      status: 'pending',
      payload: { foo: 'bar' },
    });

    const result = await dlqManager.retry('dlq-123');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Retry failed again');
    expect(prismaMock.deadLetterMessage.update).toHaveBeenCalledWith({
      where: { id: 'dlq-123' },
      data: {
        retryCount: { increment: 1 },
        errorReason: 'Retry failed: Retry failed again',
      },
    });
  });

  it('discards a message', async () => {
    await dlqManager.discard('dlq-123');

    expect(prismaMock.deadLetterMessage.update).toHaveBeenCalledWith({
      where: { id: 'dlq-123' },
      data: { status: 'ignored' },
    });
  });
});
