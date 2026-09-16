/**
 * Context Manager · Token 预算感知上下文组装
 * =============================================
 * 按 provider max_tokens 分配预算：
 *   - L1 核心 (永远加载, ~5%)
 *   - L4 实体切片 (query 相关, ~10%)
 *   - L3 事实 (top-K by score, ~20%)
 *   - L2 工作记忆 (最近 N 轮原文 + 早期摘要, ~55%)
 *   - 系统/工具预留 (~10%)
 *
 * 三级摘要：
 *   - micro: 每 10 轮
 *   - macro: 每 50 轮
 *   - mega:  每 200 轮
 *
 * 设计参考: Anthropic prompt caching (静态前缀缓存) + NoteMR (分层摘要) + MemGPT paging
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import type { MemoryStore } from './store.js';
import type { TemporalGraph } from './graph.js';
import type { Fact } from './extractor.js';
import type { DecayEngine, DecayScore } from './decay.js';

export interface ContextBudget {
  total: number;                // 总 token 预算
  reserved: number;             // 输出预留
  l1Core: number;               // 核心锚点
  l4Graph: number;              // 图谱切片
  l3Facts: number;              // 事实
  l2Work: number;               // 工作记忆
  system: number;               // 系统提示
}

export interface ContextPiece {
  layer: 'L1' | 'L2' | 'L3' | 'L4';
  content: string;
  tokens: number;
  relevance: number;            // 0-1
  source?: string;              // 文件路径或 ID
}

export interface ContextBuildResult {
  pieces: ContextPiece[];
  budget: ContextBudget;
  totalTokens: number;
  usage: Record<string, number>;     // 实际使用 vs 预算
  query: string;
  truncated: boolean;
  warnings: string[];
}

export interface ContextManagerOptions {
  tokenBudget: number;          // 默认 8000
  outputReserve: number;        // 默认 2000
  maxRecentTurns: number;       // L2 原文最多保留多少轮（默认 5）
  topFacts: number;             // L3 召回 top-K（默认 15）
  graphDepth: number;           // L4 BFS 深度（默认 2）
  enableSummary: boolean;       // 是否启用分层摘要
  debug?: boolean;
}

const DEFAULT_OPTS: Required<ContextManagerOptions> = {
  tokenBudget: 8000,
  outputReserve: 2000,
  maxRecentTurns: 5,
  topFacts: 15,
  graphDepth: 2,
  enableSummary: true,
  debug: false,
};

/**
 * Token 估算：英文 ~4 字符/token，中文 ~1.5 字符/token，混合按加权平均
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const other = text.length - chinese;
  // 中文 1.5 字符/token, 英文 4 字符/token
  return Math.ceil(chinese / 1.5 + other / 4);
}

export class ContextManager {
  private opts: Required<ContextManagerOptions>;
  private store: MemoryStore;
  private graph: TemporalGraph;
  private decay: DecayEngine;
  private summariesDir: string;

  constructor(store: MemoryStore, graph: TemporalGraph, decay: DecayEngine, opts?: Partial<ContextManagerOptions>) {
    this.store = store;
    this.graph = graph;
    this.decay = decay;
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.summariesDir = join((store as any).root, '02-work', 'summaries');
  }

  async init() {
    if (!existsSync(this.summariesDir)) {
      await mkdir(this.summariesDir, { recursive: true });
    }
  }

  /** 分配 token 预算 */
  allocateBudget(): ContextBudget {
    const total = this.opts.tokenBudget;
    const reserved = this.opts.outputReserve;
    const usable = total - reserved;
    return {
      total,
      reserved,
      system: Math.floor(usable * 0.10),
      l1Core: Math.floor(usable * 0.08),
      l4Graph: Math.floor(usable * 0.12),
      l3Facts: Math.floor(usable * 0.20),
      l2Work: Math.floor(usable * 0.50),
    };
  }

  /**
   * 智能组装上下文（核心入口）
   */
  async buildContext(query: string): Promise<ContextBuildResult> {
    const budget = this.allocateBudget();
    const pieces: ContextPiece[] = [];
    const warnings: string[] = [];
    let totalTokens = 0;
    let truncated = false;

    // ── L1 核心 ──
    const coreContent = await this.store.readCore();
    const coreTokens = estimateTokens(coreContent);
    const corePiece: ContextPiece = {
      layer: 'L1',
      content: coreContent,
      tokens: Math.min(coreTokens, budget.l1Core),
      relevance: 1.0,
      source: '01-core.md',
    };
    if (corePiece.tokens > budget.l1Core) {
      corePiece.content = this.truncate(coreContent, budget.l1Core);
      corePiece.tokens = budget.l1Core;
      warnings.push('L1 核心被截断（异常大）');
    }
    pieces.push(corePiece);
    totalTokens += corePiece.tokens;

    // ── L4 图谱（按 query 相关性）──
    try {
      // 抽取 query 里的关键词作图查询起点
      const keyword = this.extractKeyword(query);
      const graphResult = keyword ? await this.graph.query({
        entity: keyword,
        depth: this.opts.graphDepth,
        limit: 12,
      }) : null;
      if (graphResult) {
        const graphText = this.graph.formatForContext(graphResult, 8);
        const graphTokens = estimateTokens(graphText);
        const graphPiece: ContextPiece = {
          layer: 'L4',
          content: graphText,
          tokens: Math.min(graphTokens, budget.l4Graph),
          relevance: 0.7,
          source: '04-graph',
        };
        if (graphPiece.tokens > budget.l4Graph) {
          graphPiece.content = this.truncate(graphText, budget.l4Graph);
          graphPiece.tokens = budget.l4Graph;
        }
        pieces.push(graphPiece);
        totalTokens += graphPiece.tokens;
      }
    } catch (e) {
      warnings.push('L4 图谱查询失败：' + (e as Error).message);
    }

    // ── L3 事实（按衰减分数排序）──
    try {
      const allFacts = await this.store.queryFacts({ verifiedOnly: false, limit: 200 });
      const scored = this.scoreAndRankFacts(allFacts, query);
      const topFacts = scored.slice(0, this.opts.topFacts);

      const lines = ['## 已知事实（L3 · 已记住的，按记忆强度排序）'];
      let usedTokens = 0;
      const factBudget = budget.l3Facts;
      for (const { fact, score } of topFacts) {
        const line = `- [${fact.category}] ${fact.verified ? '✓' : '?'}${(fact.confidence * 100).toFixed(0)}% ${fact.text} ${chalk.gray(`(score=${score.toFixed(2)})`)}`;
        const lineTokens = estimateTokens(line);
        if (usedTokens + lineTokens > factBudget) {
          truncated = true;
          break;
        }
        lines.push(line);
        usedTokens += lineTokens;
      }
      if (lines.length > 1) {
        const l3Piece: ContextPiece = {
          layer: 'L3',
          content: lines.join('\n'),
          tokens: usedTokens,
          relevance: 0.8,
          source: '03-facts',
        };
        pieces.push(l3Piece);
        totalTokens += usedTokens;
      }
    } catch (e) {
      warnings.push('L3 事实召回失败：' + (e as Error).message);
    }

    // ── L2 工作记忆（最近原文 + 早期摘要）──
    try {
      const workContent = await this.buildWorkMemory(query, budget.l2Work);
      const l2Piece: ContextPiece = {
        layer: 'L2',
        content: workContent.content,
        tokens: workContent.tokens,
        relevance: 0.9,
        source: '02-work',
      };
      pieces.push(l2Piece);
      totalTokens += workContent.tokens;
      if (workContent.truncated) truncated = true;
    } catch (e) {
      warnings.push('L2 工作记忆加载失败：' + (e as Error).message);
    }

    const usage: Record<string, number> = {
      L1: pieces.find((p) => p.layer === 'L1')?.tokens || 0,
      L2: pieces.find((p) => p.layer === 'L2')?.tokens || 0,
      L3: pieces.find((p) => p.layer === 'L3')?.tokens || 0,
      L4: pieces.find((p) => p.layer === 'L4')?.tokens || 0,
      budget: budget.l1Core + budget.l2Work + budget.l3Facts + budget.l4Graph,
    };

    if (this.opts.debug) {
      console.log(chalk.gray(`[context-manager] query="${query.slice(0, 30)}..." total=${totalTokens}/${budget.total} pieces=${pieces.length}`));
    }

    return {
      pieces,
      budget,
      totalTokens,
      usage,
      query,
      truncated,
      warnings,
    };
  }

  /**
   * L2 工作记忆组装：最近 N 轮原文 + 早期轮的分层摘要
   */
  private async buildWorkMemory(query: string, tokenBudget: number): Promise<{ content: string; tokens: number; truncated: boolean }> {
    const workDir = join((this.store as any).root, '02-work');
    if (!existsSync(workDir)) return { content: '', tokens: 0, truncated: false };

    const allFiles = (await readdir(workDir))
      .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
      .sort();
    if (allFiles.length === 0) return { content: '', tokens: 0, truncated: false };

    // 1. 取最近 N 轮原文
    const recentFiles = allFiles.slice(-this.opts.maxRecentTurns);
    const recentContent: string[] = [];
    let usedTokens = 0;
    let truncated = false;

    for (const f of recentFiles.reverse()) {
      const content = await readFile(join(workDir, f), 'utf8');
      const tokens = estimateTokens(content);
      if (usedTokens + tokens > tokenBudget * 0.6) {  // 原文占 60%
        truncated = true;
        break;
      }
      recentContent.push(content);
      usedTokens += tokens;
    }

    // 2. 早期轮：加载摘要（如果有）
    let summaryContent = '';
    if (this.opts.enableSummary && allFiles.length > this.opts.maxRecentTurns) {
      const summaries = await this.loadSummaries(allFiles.length - this.opts.maxRecentTurns);
      const summaryText = this.formatSummaries(summaries);
      const summaryTokens = estimateTokens(summaryText);
      if (usedTokens + summaryTokens <= tokenBudget) {
        summaryContent = summaryText;
        usedTokens += summaryTokens;
      } else {
        // 摘要也超预算，只保留最高层（mega > macro > micro）
        const budgetLeft = tokenBudget - usedTokens;
        if (budgetLeft > 0) {
          summaryContent = this.truncate(summaryText, budgetLeft);
          usedTokens += estimateTokens(summaryContent);
          truncated = true;
        }
      }
    }

    const content = [summaryContent, ...recentContent].filter(Boolean).join('\n\n');
    return { content, tokens: usedTokens, truncated };
  }

  /** 加载分层摘要（按 turn 范围） */
  private async loadSummaries(turnsBefore: number): Promise<{ level: string; range: string; content: string }[]> {
    const out: { level: string; range: string; content: string }[] = [];
    const summaryFiles = (await readdir(this.summariesDir).catch(() => []))
      .filter((f) => f.endsWith('.md'))
      .sort();

    for (const f of summaryFiles) {
      const m = f.match(/^(micro|macro|mega)-turn-(\d+)-(\d+)\.md$/);
      if (!m) continue;
      const [, level, start, end] = m;
      const startNum = parseInt(start, 10);
      // 只保留 turn < startNum 的摘要（即更早的）
      if (startNum < turnsBefore) {
        const content = await readFile(join(this.summariesDir, f), 'utf8');
        out.push({ level, range: `${start}-${end}`, content });
      }
    }
    return out;
  }

  private formatSummaries(summaries: { level: string; range: string; content: string }[]): string {
    if (summaries.length === 0) return '';
    return ['## 早期对话摘要', ...summaries.map((s) => `### ${s.level} (turn ${s.range})\n${s.content}`)].join('\n\n');
  }

  /**
   * L3 事实评分：衰减分 × query 相关性 × 时间新鲜度
   */
  private scoreAndRankFacts(facts: Fact[], query: string): Array<{ fact: Fact; score: number }> {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length >= 2);
    const decayScores = new Map(this.decay.scoreBatch(facts).map((s: DecayScore) => [s.factId, s.score]));

    return facts
      .map((fact) => {
        const decayScore = decayScores.get(fact.id) || 0.3;
        // 相关性：关键词命中数
        const textLower = fact.text.toLowerCase();
        const matches = queryWords.filter((w) => textLower.includes(w)).length;
        const relevance = Math.min(1, matches / Math.max(1, queryWords.length) + 0.3);
        // 验证加成
        const verifiedBoost = fact.verified ? 1.2 : 1.0;
        return { fact, score: decayScore * relevance * verifiedBoost };
      })
      .sort((a, b) => b.score - a.score);
  }

  /** 从 query 提取关键词（用于图查询） */
  private extractKeyword(query: string): string | null {
    // 启发式：取最长的中文词组或英文名词
    const cleaned = query
      .replace(/[，。、！？,.\!?]/g, ' ')
      .replace(/^(帮我|请|我想|我要|能不能|可以)/g, '')
      .trim();
    if (!cleaned) return null;
    // 取第一个 2+ 字的中文词
    const cnMatch = cleaned.match(/[\u4e00-\u9fa5]{2,}/);
    if (cnMatch) return cnMatch[0];
    // 英文第一个名词
    const enMatch = cleaned.match(/\b[A-Z][a-z]+\b|\b[a-z]{4,}\b/);
    return enMatch ? enMatch[0] : null;
  }

  /** 按 token 预算截断文本（保留头尾） */
  private truncate(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 3;  // 保守估算
    if (text.length <= maxChars) return text;
    const head = text.slice(0, Math.floor(maxChars * 0.7));
    const tail = text.slice(-Math.floor(maxChars * 0.2));
    return head + '\n\n[... 截断 ...]\n\n' + tail;
  }

  /** 把 pieces 组装成最终字符串（注入 prompt） */
  assemble(pieces: ContextPiece[]): string {
    const sections: string[] = [];
    for (const piece of pieces) {
      if (piece.content) {
        sections.push(piece.content);
      }
    }
    return sections.join('\n\n---\n\n');
  }

  /** 触发分层摘要生成（在 turn 完成后调用） */
  async maybeSummarize(currentTurn: number): Promise<{ level: string; range: string } | null> {
    if (!this.opts.enableSummary) return null;

    // mega: 每 200 轮
    if (currentTurn > 0 && currentTurn % 200 === 0) {
      const range = { start: Math.max(1, currentTurn - 200), end: currentTurn - 1 };
      await this.generateSummary('mega', range.start, range.end);
      return { level: 'mega', range: `${range.start}-${range.end}` };
    }
    // macro: 每 50 轮
    if (currentTurn > 0 && currentTurn % 50 === 0) {
      const range = { start: Math.max(1, currentTurn - 50), end: currentTurn - 1 };
      await this.generateSummary('macro', range.start, range.end);
      return { level: 'macro', range: `${range.start}-${range.end}` };
    }
    // micro: 每 10 轮
    if (currentTurn > 0 && currentTurn % 10 === 0) {
      const range = { start: Math.max(1, currentTurn - 10), end: currentTurn - 1 };
      await this.generateSummary('micro', range.start, range.end);
      return { level: 'micro', range: `${range.start}-${range.end}` };
    }
    return null;
  }

  /** 生成摘要（用主脑一次性总结一段对话） */
  private async generateSummary(level: 'micro' | 'macro' | 'mega', startTurn: number, endTurn: number): Promise<void> {
    // 这里用 mock provider 做示例；生产可换成主脑
    const file = join(this.summariesDir, `${level}-turn-${String(startTurn).padStart(6, '0')}-${String(endTurn).padStart(6, '0')}.md`);
    const stub = `# ${level.toUpperCase()} 摘要 · turn ${startTurn}-${endTurn}\n\n> 自动生成的占位摘要（实现需要 LLM 调用）\n\n此段对话包含 ${endTurn - startTurn + 1} 轮。\n`;
    await writeFile(file, stub, 'utf8');
  }

  /** 上下文使用报告（供 /context 命令） */
  formatReport(result: ContextBuildResult): string {
    const lines: string[] = [];
    lines.push(chalk.bold(`📐 上下文组装报告 · query="${result.query.slice(0, 30)}..."`));
    lines.push(`总 token: ${chalk.cyan(result.totalTokens)} / 预算 ${result.budget.total}`);
    lines.push(`  ├─ L1 核心: ${result.usage.L1} / ${result.budget.l1Core}`);
    lines.push(`  ├─ L2 工作: ${result.usage.L2} / ${result.budget.l2Work}`);
    lines.push(`  ├─ L3 事实: ${result.usage.L3} / ${result.budget.l3Facts}`);
    lines.push(`  ├─ L4 图谱: ${result.usage.L4} / ${result.budget.l4Graph}`);
    lines.push(`  └─ 预留:    ${result.budget.reserved} (输出)`);
    if (result.truncated) lines.push(chalk.yellow('⚠️  有截断'));
    if (result.warnings.length > 0) {
      lines.push(chalk.yellow('⚠️  警告：'));
      for (const w of result.warnings) lines.push(`  - ${w}`);
    }
    return lines.join('\n');
  }
}
