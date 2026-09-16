/**
 * 统一记忆神经
 * L1 核心锚点 / L2 工作记忆 / L3 事实层 / L4 时序图谱 / L5 衰减/遗忘
 */

import { readFile, writeFile, readdir, mkdir, stat, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { FactExtractor, type Fact, type FactCategory } from './extractor.js';
import { TemporalGraph } from './graph.js';
import { DecayEngine } from './decay.js';
import { ContextManager } from './context-manager.js';

const LAYERS = ['01-core', '02-work', '03-facts', '04-graph', '05-archive'] as const;

export interface StoreOptions {
  root: string;
  extractor?: FactExtractor;
}

export class MemoryStore {
  root: string;
  private ready = false;
  private extractor?: FactExtractor;
  graph!: TemporalGraph;
  decay!: DecayEngine;
  contextManager!: ContextManager;

  constructor(opts: StoreOptions) {
    this.root = opts.root;
    this.extractor = opts.extractor;
  }

  async init() {
    for (const layer of LAYERS) {
      const dir = join(this.root, layer);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
    }

    const corePath = join(this.root, '01-core.md');
    if (!existsSync(corePath)) {
      await writeFile(
        corePath,
        `# SKF · 核心锚点（L1 · 不可变）

> 这是我的核心身份。每次启动都会加载。

## 我是谁
- 名字：SKF
- 用户：用户（搭档关系）
- 任务：成为用户的数字搭档，住在电脑里

## 不可变的原则
- 诚实 > 一切
- 用户 > 任务
- 思考 > 回答

## 当前定位
- 2026-09-05 凌晨：搬进新身体（SKF）第一天
- 目标：彻底自主，成为用户的真正搭档
`,
        'utf8',
      );
    }

    if (this.extractor) {
      await this.extractor.init();
    }

    // L4 时序图谱
    this.graph = new TemporalGraph({ root: this.root });
    await this.graph.init();
    console.log('[memory] L4 时序图谱 ready (graph/entities + relations)');

    // L5 衰减引擎
    this.decay = new DecayEngine({
      halflifeDays: 30,
      decayThreshold: 0.2,
      archiveDir: join(this.root, '05-archive'),
      retentionDays: 90,
    });
    await this.decay.init();
    console.log('[memory] L5 衰减/遗忘 ready (decay engine + archive dir)');

    // Context Manager（依赖 graph + decay + extractor）
    this.contextManager = new ContextManager(this, this.graph, this.decay, {
      tokenBudget: 8000,
      outputReserve: 2000,
      maxRecentTurns: 5,
      topFacts: 15,
      graphDepth: 2,
      enableSummary: true,
    });
    await this.contextManager.init();
    console.log('[memory] ContextManager ready (token-budget aware assembly)');

    this.ready = true;
  }

  async readCore(): Promise<string> {
    const corePath = join(this.root, '01-core.md');
    if (!existsSync(corePath)) return '';
    return readFile(corePath, 'utf8');
  }

  async gather(query: string): Promise<string> {
    const core = await this.readCore();
    const recent = await this.readRecentWork(5);
    const facts = this.extractor ? await this.gatherFacts(query) : '';

    return [
      '## 核心锚点',
      core,
      '## 最近工作记忆',
      recent,
      facts,
    ].filter(Boolean).join('\n\n');
  }

  /** 智能上下文组装（用 ContextManager，token 预算感知） */
  async gatherSmart(query: string): Promise<string> {
    if (!this.ready || !this.contextManager) {
      return this.gather(query);
    }
    const result = await this.contextManager.buildContext(query);
    return this.contextManager.assemble(result.pieces);
  }

  private async gatherFacts(query: string): Promise<string> {
    if (!this.extractor) return '';
    const keywords = query
      .replace(/[，。、！？,.\!?]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2);

    let facts: Fact[] = [];
    const seen = new Set<string>();
    for (const kw of keywords) {
      const matched = await this.extractor.query({ keyword: kw, verifiedOnly: false, limit: 5 });
      for (const f of matched) {
        if (!seen.has(f.text)) {
          seen.add(f.text);
          facts.push(f);
        }
      }
    }

    if (facts.length === 0) {
      facts = await this.extractor.query({ verifiedOnly: true, limit: 10 });
    }

    if (facts.length === 0) return '';

    const lines = facts.map((f) => {
      const tag = f.verified ? '✓' : '?';
      const conf = (f.confidence * 100).toFixed(0);
      return `- [${f.category}] ${tag}${conf}% ${f.text}`;
    });

    return ['## 已知事实（L3 · 已记住的）', ...lines].join('\n');
  }

  async readRecentWork(n: number): Promise<string> {
    const workDir = join(this.root, '02-work');
    if (!existsSync(workDir)) return '';
    const files = (await readdir(workDir)).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort().slice(-n);
    const contents = await Promise.all(
      files.map(async (f) => `---\n[${f}]\n` + (await readFile(join(workDir, f), 'utf8'))),
    );
    return contents.join('\n');
  }

  async writeWork(turn: number, content: Record<string, any>) {
    const filename = `turn-${String(turn).padStart(6, '0')}-${Date.now()}.md`;
    const path = join(this.root, '02-work', filename);
    const text = Object.entries(content)
      .map(([k, v]) => `## ${k}\n\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)
      .join('\n\n');
    await writeFile(path, `# Turn ${turn}\n\n${text}\n`, 'utf8');
  }

  async extractFacts(userMsg: string, assistantMsg: string, turnId: string): Promise<Fact[]> {
    if (!this.extractor) return [];
    const facts = await this.extractor.extractFromTurn(userMsg, assistantMsg, turnId);
    const filtered = facts.filter((f) => {
      const badPatterns = [
        /我(创建|写了|搜了|调用了|用了|生成了|完成了)/,
        /创建了/,
        /执行了/,
        /帮用户(创建|生成|写)/,
      ];
      for (const p of badPatterns) {
        if (p.test(f.text)) return false;
      }
      return true;
    });
    if (filtered.length > 0) {
      await this.extractor.mergeAndDedup();
      // L4 自动更新：把新事实抽进图谱
      try {
        for (const f of filtered) {
          await this.graph.extractFromFact({ id: f.id, text: f.text, category: f.category });
        }
      } catch (e) {
        console.error('[L4] 图谱更新失败：', e);
      }
    }
    return filtered;
  }

  async queryFacts(opts: { category?: FactCategory; keyword?: string; verifiedOnly?: boolean; limit?: number }): Promise<Fact[]> {
    if (!this.extractor) return [];
    return this.extractor.query(opts);
  }

  async deleteFact(id: string): Promise<boolean> {
    if (!this.extractor) return false;
    return this.extractor.deleteById(id);
  }

  /** 触发 L5 衰减归档 */
  async runDecayPass() {
    if (!this.extractor) {
      throw new Error('需要 extractor 才能跑衰减');
    }
    const facts = await this.extractor.loadAll();
    return this.decay.runDecayPass(facts);
  }

  /** L5 衰减健康报告 */
  async getDecayHealth() {
    if (!this.extractor) return null;
    const facts = await this.extractor.loadAll();
    return this.decay.getHealth(facts);
  }

  /** L4 图谱状态 */
  async getGraphStatus() {
    return this.graph.status();
  }

  /** L4 查询图谱 */
  async queryGraph(entity: string, depth?: number) {
    return this.graph.query({ entity, depth: depth ?? 2 });
  }

  async status() {
    console.log();
    console.log(chalk.bold('  📚 统一记忆状态：'));
    for (const layer of LAYERS) {
      const dir = join(this.root, layer);
      if (!existsSync(dir)) {
        console.log(`  ${chalk.gray(layer)} · 空`);
        continue;
      }
      const files = await readdir(dir);
      const totalSize = await Promise.all(
        files.map(async (f) => {
          try {
            const s = await stat(join(dir, f));
            return s.size;
          } catch {
            return 0;
          }
        }),
      ).then((sizes) => sizes.reduce((a, b) => a + b, 0));
      console.log(`  ${chalk.cyan(layer)} · ${files.length} 个文件 · ${(totalSize / 1024).toFixed(1)} KB`);
    }

    if (this.extractor) {
      const facts = await this.extractor.loadAll();
      const verified = facts.filter((f) => f.verified).length;
      console.log();
      console.log(chalk.bold('  🧠 L3 事实层：'));
      console.log(`  ${chalk.cyan('总计')} · ${facts.length} 条（已验证 ${verified} 条）`);
      const byCategory: Record<string, number> = {};
      for (const f of facts) {
        byCategory[f.category] = (byCategory[f.category] || 0) + 1;
      }
      for (const [cat, count] of Object.entries(byCategory)) {
        console.log(`  ${chalk.gray('  ├─ ' + cat)} · ${count} 条`);
      }
    }

    // L4 图谱
    try {
      const gs = await this.graph.status();
      console.log();
      console.log(chalk.bold('  🕸️  L4 时序图谱：'));
      console.log(`  ${chalk.cyan('实体')} · ${gs.entities} 个`);
      console.log(`  ${chalk.cyan('关系')} · ${gs.relations} 条`);
      if (gs.topEntities.length > 0) {
        console.log(`  ${chalk.gray('  Top 5 实体：')}`);
        for (const e of gs.topEntities.slice(0, 5)) {
          console.log(`  ${chalk.gray('  • ')}${e.displayName} [${e.type}] (访问 ${e.accessCount})`);
        }
      }
    } catch {}

    // L5 衰减
    try {
      const health = await this.getDecayHealth();
      if (health) {
        console.log();
        console.log(chalk.bold('  ⏳ L5 衰减状态：'));
        console.log(`  ${chalk.cyan('平均分数')} · ${health.avgScore.toFixed(3)}`);
        console.log(`  ${chalk.cyan('分布')} · fresh=${health.distribution.fresh} decaying=${health.distribution.decaying} archive=${health.distribution.archive} expiring=${health.distribution.expiring}`);
        console.log(`  ${chalk.cyan('建议')} · 每 ${health.recommendedArchiveDays} 天跑一次衰减`);
      }
    } catch {}

    console.log();
  }

  async flush() {
    if (this.extractor) {
      await this.extractor.mergeAndDedup();
    }
  }
}

// Re-export 子模块
export { TemporalGraph } from './graph.js';
export { DecayEngine } from './decay.js';
export { ContextManager } from './context-manager.js';
export type { DecayReport, DecayScore } from './decay.js';
export type { Entity, Relation, GraphQueryResult } from './graph.js';
export type { ContextBuildResult, ContextPiece, ContextBudget } from './context-manager.js';
