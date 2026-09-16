import type { ThinkResponse } from '../providers/types.js';
import { TaskStore, type ChatTask } from './task-store.js';

interface ChatDependencies {
  store: TaskStore;
  provider: () => string;
  think: (message: string, turn: number) => Promise<ThinkResponse>;
  /** 返回 true 表示本轮记忆降级（如主档不可用），任务结果保留但标记 memoryWarning。 */
  remember: (message: string, response: string, turn: number) => Promise<boolean | void>;
  maxDailyCloudCalls?: number;
  allowMock?: boolean;
}

export class ChatService {
  busy = false;
  constructor(private deps: ChatDependencies) {}

  async chat(id: string, message: string) {
    if (!message.trim() || message.length > 16000) throw new Error('INVALID_MESSAGE');
    const previous = this.deps.store.tasks.get(id);
    if (previous) {
      if (previous.message !== message) throw new Error('REQUEST_ID_CONFLICT');
      if (previous.status === 'completed') return previous;
      throw new Error(previous.error || 'REQUEST_IN_PROGRESS');
    }
    if (this.busy) throw new Error('BUSY');
    const provider = this.deps.provider();
    if (provider === 'mock' && !this.deps.allowMock) throw new Error('PROVIDER_NOT_CONFIGURED');
    const limit = this.deps.maxDailyCloudCalls;
    if (limit !== undefined && !['mock', 'ollama'].includes(provider) && this.deps.store.cloudCallsToday() >= limit) {
      throw new Error('DAILY_CALL_LIMIT');
    }
    this.busy = true;
    let task: ChatTask = { id, message, provider, startedAt: new Date().toISOString(), status: 'running' };
    try {
      // Persist before making a potentially billable request. Never auto-retry interrupted requests.
      await this.deps.store.save(task);
      const turn = Date.now();
      const response = await this.deps.think(message, turn);
      if (!response.text?.trim()) throw new Error('EMPTY_RESPONSE');
      task = { ...task, status: 'completed', response };
      await this.deps.store.save(task);
      try {
        const degraded = await this.deps.remember(message, response.text, turn);
        if (degraded) {
          task.memoryWarning = true;
          await this.deps.store.save(task);
        }
      } catch {
        task.memoryWarning = true;
        await this.deps.store.save(task);
      }
      return task;
    } catch (error) {
      if (task.status !== 'completed') {
        const code =
          (error as { code?: string } | null)?.code ??
          (error instanceof Error && error.message === 'EMPTY_RESPONSE' ? 'EMPTY_RESPONSE' : 'MODEL_REQUEST_FAILED');
        await this.deps.store.save({ ...task, status: 'failed', error: code });
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
