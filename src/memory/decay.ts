/**
 * L5 衰减 / 遗忘 (Decay & Forgetting)
 * =====================================
 * Ebbinghaus 遗忘曲线 + 使用强化（access 越多越不忘）+ 自动归档 + 可恢复
 *
 * 设计参考: Mem0 时间衰减、MemGPT archival eviction
 * 文件: 05-archive/archived-facts.jsonl (移动而非删除)
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Fact } from './extractor.js';

export interface DecayOptions {
  halflifeDays?: number;       // 半衰期（默认 30 天）
  decayThreshold?: number;     // 归档阈值（默认 0.2）
  archiveDir: string;          // 05-archive 路径
  retentionDays?: number;      // 归档后保留多久再彻底删除（默认 90 天，0=永久）
}

export interface DecayScore {
  factId: string;
  score: number;
  reason: 'fresh' | 'decaying' | 'archive' | 'expiring';
  daysSinceLastSeen: number;
  accessBoost: number;
}

export interface DecayReport {
  scanned: number;
  archived: number;
  expired: number;
  fresh: number;
  topArchived: { id: string; text: string; score: number }[];
  durationMs: number;
}

export class DecayEngine {
  private opts: Required<DecayOptions>;

  constructor(opts: DecayOptions) {
    this.opts = {
      halflifeDays: opts.halflifeDays ?? 30,
      decayThreshold: opts.decayThreshold ?? 0.2,
      archiveDir: opts.archiveDir,
      retentionDays: opts.retentionDays ?? 90,
    };
  }

  async init() {
    if (!existsSync(this.opts.archiveDir)) {
      await mkdir(this.opts.archiveDir, { recursive: true });
    }
  }

  /**
   * Ebbinghaus 衰减评分
   * score = confidence × 2^(-daysSinceLastSeen / halflife) × log2(accessCount + 2)
   */
  score(fact: Fact, now: Date = new Date()): DecayScore {
    const lastSeen = new Date(fact.lastSeen);
    const daysSince = (now.getTime() - lastSeen.getTime()) / (24 * 3600 * 1000);

    // Ebbinghaus 衰减
    const decayFactor = Math.pow(2, -daysSince / this.opts.halflifeDays);

    // 使用强化（accessCount 越高越不忘）
    const accessBoost = Math.log2((fact.verifyCount || 1) + 2);

    // 基础分 = 置信度 × 衰减 × 使用强化
    const baseScore = fact.confidence * decayFactor;
    const score = baseScore * accessBoost;

    let reason: DecayScore['reason'];
    if (daysSince < 1) {
      reason = 'fresh';
    } else if (score >= this.opts.decayThreshold * 2) {
      reason = 'fresh';
    } else if (score >= this.opts.decayThreshold) {
      reason = 'decaying';
    } else if (this.opts.retentionDays > 0 && daysSince > this.opts.retentionDays) {
      reason = 'expiring';
    } else {
      reason = 'archive';
    }

    return {
      factId: fact.id,
      score,
      reason,
      daysSinceLastSeen: daysSince,
      accessBoost,
    };
  }

  /** 评分并排序一批事实 */
  scoreBatch(facts: Fact[], now?: Date): DecayScore[] {
    return facts
      .map((f) => this.score(f, now))
      .sort((a, b) => b.score - a.score);
  }

  /** 扫描并归档：把低于阈值的事实移到 05-archive */
  async runDecayPass(facts: Fact[], now: Date = new Date()): Promise<DecayReport> {
    const start = Date.now();
    const scores = this.scoreBatch(facts, now);

    const toArchive: Fact[] = [];
    const toExpire: Fact[] = [];
    const keep: Fact[] = [];

    for (let i = 0; i < facts.length; i++) {
      const s = scores[i];
      const f = facts[i];
      if (s.reason === 'archive') {
        toArchive.push(f);
      } else if (s.reason === 'expiring') {
        toExpire.push(f);
      } else {
        keep.push(f);
      }
    }

    // 写入归档文件
    const archiveFile = join(this.opts.archiveDir, 'archived-facts.jsonl');
    if (toArchive.length > 0) {
      const lines = toArchive
        .map((f) => JSON.stringify({ ...f, _archivedAt: now.toISOString(), _reason: 'decay' }))
        .join('\n') + '\n';
      await this.appendIfMissing(archiveFile, lines);
    }

    // 永久过期：直接删除（已超 retentionDays）
    // 注：toExpire 的事实已经从 facts 中移除（不进 keep）

    return {
      scanned: facts.length,
      archived: toArchive.length,
      expired: toExpire.length,
      fresh: keep.length,
      topArchived: toArchive.slice(0, 5).map((f) => {
        const s = scores.find((x) => x.factId === f.id)!;
        return { id: f.id, text: f.text, score: s.score };
      }),
      durationMs: Date.now() - start,
    };
  }

  private async appendIfMissing(file: string, content: string) {
    if (!existsSync(file)) {
      await writeFile(file, '', 'utf8');
    }
    const { appendFile } = await import('node:fs/promises');
    await appendFile(file, content, 'utf8');
  }

  /** 强化：被 recall/cite 时调用，提升事实分数 */
  boost(fact: Fact, amount = 0.05): Fact {
    return {
      ...fact,
      confidence: Math.min(0.99, fact.confidence + amount),
      verifyCount: fact.verifyCount + 1,
      lastSeen: new Date().toISOString(),
    };
  }

  /** 恢复归档：把存档事实重新激活 */
  async restoreFromArchive(factId: string): Promise<Fact | null> {
    const archiveFile = join(this.opts.archiveDir, 'archived-facts.jsonl');
    if (!existsSync(archiveFile)) return null;
    const content = await readFile(archiveFile, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());

    let restored: Fact | null = null;
    const remaining: string[] = [];
    for (const line of lines) {
      try {
        const f = JSON.parse(line) as Fact & { _archivedAt?: string };
        if (f.id === factId) {
          restored = {
            id: f.id,
            text: f.text,
            category: f.category,
            confidence: Math.max(0.5, f.confidence - 0.1),  // 恢复时稍微降权
            verifyCount: f.verifyCount,
            verified: f.verified,
            source: f.source,
            firstSeen: f.firstSeen,
            lastSeen: new Date().toISOString(),
          };
        } else {
          remaining.push(line);
        }
      } catch {
        remaining.push(line);
      }
    }

    if (restored) {
      await writeFile(archiveFile, remaining.join('\n') + (remaining.length ? '\n' : ''), 'utf8');
    }
    return restored;
  }

  /** 列出归档 */
  async listArchive(limit = 50): Promise<Array<Fact & { _archivedAt: string }>> {
    const archiveFile = join(this.opts.archiveDir, 'archived-facts.jsonl');
    if (!existsSync(archiveFile)) return [];
    const content = await readFile(archiveFile, 'utf8');
    return content
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((f): f is Fact & { _archivedAt: string } => f !== null)
      .slice(-limit)
      .reverse();
  }

  /** 健康统计 */
  async getHealth(facts: Fact[]): Promise<{
    total: number;
    avgScore: number;
    distribution: Record<DecayScore['reason'], number>;
    recommendedArchiveDays: number;
  }> {
    const scores = this.scoreBatch(facts);
    const distribution: Record<DecayScore['reason'], number> = {
      fresh: 0,
      decaying: 0,
      archive: 0,
      expiring: 0,
    };
    let total = 0;
    for (const s of scores) {
      distribution[s.reason]++;
      total += s.score;
    }
    const avgScore = scores.length > 0 ? total / scores.length : 0;

    // 推荐归档间隔：基于平均分数自适应
    const recommendedArchiveDays = avgScore < 0.3 ? 7 : avgScore < 0.6 ? 30 : 90;

    return {
      total: facts.length,
      avgScore,
      distribution,
      recommendedArchiveDays,
    };
  }
}
