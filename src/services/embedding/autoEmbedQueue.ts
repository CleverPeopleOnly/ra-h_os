import { embedNodeContent } from '@/services/embedding/ingestion';
import { nodeService } from '@/services/database';

interface AutoEmbedTask {
  nodeId: number;
  force?: boolean;
  reason?: string;
}

const DEFAULT_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes between automatic runs per node

export class AutoEmbedQueue {
  private readonly queue: number[] = [];
  private readonly pendingTasks = new Map<number, AutoEmbedTask>();
  private readonly running = new Set<number>();
  private readonly lastRunAt = new Map<number, number>();
  private readonly maxConcurrent = 1;
  private readonly cooldownMs = DEFAULT_COOLDOWN_MS;
  private readonly embeddingsDisabled = process.env.DISABLE_EMBEDDINGS === 'true';

  enqueue(nodeId: number, task: Omit<AutoEmbedTask, 'nodeId'> = {}): boolean {
    if (this.embeddingsDisabled && !task.force) {
      return false;
    }
    const existing = this.pendingTasks.get(nodeId);
    if (!existing) {
      this.pendingTasks.set(nodeId, { nodeId, ...task });
      this.queue.push(nodeId);
    } else {
      existing.force = existing.force || task.force;
      existing.reason = existing.reason || task.reason;
    }

    this.processQueue();
    return true;
  }

  private processQueue() {
    if (this.running.size >= this.maxConcurrent) {
      return;
    }

    const nextId = this.queue.shift();
    if (typeof nextId !== 'number') {
      return;
    }

    const task = this.pendingTasks.get(nextId);
    if (!task) {
      // Task was removed; try next
      this.processQueue();
      return;
    }
    this.pendingTasks.delete(nextId);

    const now = Date.now();
    const lastRun = this.lastRunAt.get(task.nodeId);
    if (!task.force && lastRun && now - lastRun < this.cooldownMs) {
      const delay = this.cooldownMs - (now - lastRun);
      setTimeout(() => this.enqueue(task.nodeId, task), delay);
      this.processQueue();
      return;
    }

    this.running.add(task.nodeId);
    this.executeTask(task)
      .catch(error => {
        console.error('[AutoEmbedQueue] Task failed', task.nodeId, error);
      })
      .finally(() => {
        this.running.delete(task.nodeId);
        this.lastRunAt.set(task.nodeId, Date.now());
        if (this.queue.length > 0) {
          setTimeout(() => this.processQueue(), 10);
        }
      });
  }

  private async executeTask(task: AutoEmbedTask) {
    if (this.embeddingsDisabled && !task.force) {
      return;
    }
    const node = await nodeService.getNodeById(task.nodeId);
    if (!node) {
      console.warn('[AutoEmbedQueue] Node missing, skipping', task.nodeId);
      return;
    }

    const chunkText = node.chunk?.trim();
    if (!chunkText) {
      console.warn('[AutoEmbedQueue] Node has no chunk content, skipping', task.nodeId);
      return;
    }

    if (!task.force && node.chunk_status === 'chunked') {
      return;
    }

    if (node.chunk_status === 'chunking' && !task.force) {
      console.log('[AutoEmbedQueue] Node already chunking, skipping duplicate run', task.nodeId);
      return;
    }

    console.log(`🔄 [AutoEmbedQueue] Embedding node ${task.nodeId}${task.reason ? ` (${task.reason})` : ''}`);
    const result = await embedNodeContent(task.nodeId);
    if (!result.success) {
      console.error('[AutoEmbedQueue] Embedding failed', task.nodeId, result.error);
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var autoEmbedQueue: AutoEmbedQueue | undefined;
}

export const autoEmbedQueue = globalThis.autoEmbedQueue ?? new AutoEmbedQueue();
if (!globalThis.autoEmbedQueue) {
  globalThis.autoEmbedQueue = autoEmbedQueue;
}
