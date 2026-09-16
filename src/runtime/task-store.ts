import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ThinkResponse } from '../providers/types.js';

export interface ChatTask {
  id: string;
  message: string;
  provider: string;
  startedAt: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  response?: ThinkResponse;
  error?: string;
  memoryWarning?: boolean;
}

/** One atomic file per request; request IDs never become filesystem paths. */
export class TaskStore {
  readonly tasks = new Map<string, ChatTask>();
  constructor(readonly root: string) {}

  async init() {
    await mkdir(this.root, { recursive: true });
    for (const file of await readdir(this.root)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const task = JSON.parse(await readFile(join(this.root, file), 'utf8')) as ChatTask;
      if (!task.id || !task.startedAt || !['running', 'completed', 'failed', 'interrupted'].includes(task.status)) {
        throw new Error('TASK_STORE_CORRUPT');
      }
      this.tasks.set(task.id, task);
      if (task.status === 'running') {
        await this.save({ ...task, status: 'interrupted', error: 'TASK_INTERRUPTED' });
      }
    }
  }

  async save(task: ChatTask) {
    const file = join(this.root, createHash('sha256').update(task.id).digest('hex') + '.json');
    const tmp = file + '.' + randomUUID() + '.tmp';
    await writeFile(tmp, JSON.stringify(task), { encoding: 'utf8', mode: 0o600, flush: true });
    await rename(tmp, file);
    this.tasks.set(task.id, task);
  }

  history(limit = 30) {
    const selected = [...this.tasks.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-limit);
    while (selected.length > 1 && Buffer.byteLength(JSON.stringify(selected), 'utf8') > 500_000) selected.shift();
    return selected;
  }

  cloudCallsToday(now = new Date()) {
    const day = now.toDateString();
    return [...this.tasks.values()].filter(t =>
      !['mock', 'ollama'].includes(t.provider) && new Date(t.startedAt).toDateString() === day
    ).length;
  }
}
