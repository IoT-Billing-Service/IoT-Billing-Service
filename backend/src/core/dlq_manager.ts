import type { PrismaClient } from '@prisma/client';

export type DlqStatus = 'pending' | 'resolved' | 'ignored';

export interface DlqMessage {
  id: string;
  queueName: string;
  payload: any;
  errorReason: string;
  status: DlqStatus;
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export type RetryHandler = (payload: any) => Promise<void>;

/**
 * Dead Letter Queue (DLQ) Manager
 *
 * Provides a durable mechanism for capturing, inspecting, and replaying
 * failed messages across the system (e.g. Webhook delivery failures).
 */
export class DlqManager {
  private readonly handlers = new Map<string, RetryHandler>();

  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Register a retry handler for a specific queue.
   */
  registerHandler(queueName: string, handler: RetryHandler): void {
    this.handlers.set(queueName, handler);
  }

  /**
   * Push a failed message to the DLQ.
   */
  async push(queueName: string, payload: unknown, errorReason: string): Promise<string> {
    const msg = await this.prisma.deadLetterMessage.create({
      data: {
        queueName,
        payload: payload as any,
        errorReason,
      },
    });
    return msg.id;
  }

  /**
   * List pending DLQ messages, optionally filtered by queue.
   */
  async listPending(queueName?: string, limit: number = 50): Promise<DlqMessage[]> {
    const whereClause: any = { status: 'pending' };
    if (queueName !== undefined) {
      whereClause.queueName = queueName;
    }

    const msgs = await this.prisma.deadLetterMessage.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return msgs as DlqMessage[];
  }

  /**
   * Attempt to retry a specific DLQ message.
   */
  async retry(dlqId: string): Promise<{ success: boolean; error?: string }> {
    const msg = await this.prisma.deadLetterMessage.findUnique({
      where: { id: dlqId },
    });

    if (!msg) {
      throw new Error(`DLQ message ${dlqId} not found`);
    }

    if (msg.status !== 'pending') {
      throw new Error(`DLQ message ${dlqId} is not in pending state (currently: ${msg.status})`);
    }

    const handler = this.handlers.get(msg.queueName);
    if (!handler) {
      throw new Error(`No retry handler registered for queue: ${msg.queueName}`);
    }

    try {
      await handler(msg.payload);

      // On success, mark as resolved
      await this.prisma.deadLetterMessage.update({
        where: { id: dlqId },
        data: { status: 'resolved' },
      });

      return { success: true };
    } catch (err) {
      const errorStr = err instanceof Error ? err.message : String(err);

      // On failure, increment retry count and update error reason
      await this.prisma.deadLetterMessage.update({
        where: { id: dlqId },
        data: {
          retryCount: { increment: 1 },
          errorReason: `Retry failed: ${errorStr}`,
        },
      });

      return { success: false, error: errorStr };
    }
  }

  /**
   * Discard (ignore) a DLQ message so it won't be retried.
   */
  async discard(dlqId: string): Promise<void> {
    await this.prisma.deadLetterMessage.update({
      where: { id: dlqId },
      data: { status: 'ignored' },
    });
  }
}
