/**
 * L3 事实层 · 自动抽取器（legacy 模式，默认关闭 SKF_FACT_EXTRACTION=1 才启用）
 *
 * M06：模型调用唯一出口是 ModelGateway（purpose=extraction，走默认低成本 provider）；
 * 不再自持 OpenAI SDK 客户端 —— 那是预算旁的旁路。无 gateway 时 fail-closed。
 */

import { readFile, writeFile, readdir, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelGateway } from '../runtime/model-gateway.js';

export type FactCategory = 'project' | 'preference' | 'person' | 'event' | 'habit' | 'skill' | 'other';

export interface Fact {
  id: string;
  text: string;
  category: FactCategory;
  confidence: number;
  verifyCount: number;
  verified: boolean;
  source: string;
  firstSeen: string;
  lastSeen: string;
}

const EXTRACT_PROMPT = `你是一个**极度严格**的事实抽取器。从下面的对话中，提取出关于"用户"的事实。

# ⚠️ 严格规则（违反一条就算错）
1. **只能提取"用户"说的话里明确包含的信息**。用户没说 = 不抽
2. **绝对不要推测、推理、补充背景知识**。用户没说年均温 15℃，你就不能写
3. **绝对不要把"AI 自己说的话"当作事实**。AI 说"我帮你创建了文件"，这不是事实
4. **绝对不要把"计划做的事"写成"已做的事"**。用户说"我想做 X" → 写"用户计划做 X"
5. **拿不准就放弃**。宁愿漏抽，不要幻觉

# 格式
- 每条事实一行：[category] text
- category：project / preference / person / event / habit / skill / other
- text 必须是**用户口中说出**的明确信息
- 没事实可抽 → 输出 NONE

# 现在抽取
对话：
{conversation}

只输出严格符合规则的事实。输出：`;

const VALID_CATEGORIES: FactCategory[] = ['project', 'preference', 'person', 'event', 'habit', 'skill', 'other'];

export class FactExtractor {
  private gateway?: ModelGateway;
  private factsDir: string;
  private verifyRounds: number;

  constructor(opts: { gateway?: ModelGateway; model?: string; factsDir: string; verifyRounds?: number }) {
    this.gateway = opts.gateway;
    this.factsDir = opts.factsDir;
    this.verifyRounds = opts.verifyRounds || 3;
  }

  /** M06：supervisor 在 gateway 就绪后注入；抽取只能经 ModelGateway。 */
  setGateway(gateway: ModelGateway): void {
    this.gateway = gateway;
  }

  async init() {
    if (!existsSync(this.factsDir)) {
      await mkdir(this.factsDir, { recursive: true });
    }
  }

  async extractFromTurn(userMsg: string, assistantMsg: string, turnId: string): Promise<Fact[]> {
    if (!this.gateway) throw new Error('FACT_EXTRACTION_NOT_CONFIGURED');
    const conversation = `A: ${userMsg}\nB: ${assistantMsg}`;

    const rounds: string[][] = [];
    for (let i = 0; i < this.verifyRounds; i++) {
      const facts = await this.extractOnce(conversation, i);
      rounds.push(facts);
    }

    const factMap = new Map<string, Fact>();
    for (let round = 0; round < rounds.length; round++) {
      for (const factText of rounds[round]) {
        const key = this.normalize(factText);
        if (factMap.has(key)) {
          const existing = factMap.get(key)!;
          existing.verifyCount++;
          existing.confidence = Math.min(0.99, existing.confidence + 0.1);
          existing.lastSeen = new Date().toISOString();
        } else {
          const { category, text } = this.parseFactLine(factText);
          factMap.set(key, {
            id: `fact-${turnId}-${factMap.size}`,
            text,
            category,
            confidence: 0.5,
            verifyCount: 1,
            verified: false,
            source: turnId,
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
          });
        }
      }
    }

    const facts = Array.from(factMap.values());
    for (const f of facts) {
      if (f.verifyCount >= 2) {
        f.verified = true;
        f.confidence = Math.min(0.99, f.confidence + 0.2);
      }
    }

    await this.saveFacts(facts);
    return facts;
  }

  private async extractOnce(conversation: string, round: number): Promise<string[]> {
    if (!this.gateway) throw new Error('FACT_EXTRACTION_NOT_CONFIGURED');
    try {
      const r = await this.gateway.completeText({
        taskId: 'sys:extraction',
        purpose: 'extraction',
        system: '你是严格的事实抽取器。只输出事实，不解释。',
        user: EXTRACT_PROMPT.replace('{conversation}', conversation),
        turn: round,
        nonce: `${Date.now()}:${round}`,
        maxOutputTokens: 500,
      });
      const text = r.text.trim();
      if (text === 'NONE' || !text) return [];

      return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line.includes(']'))
        .map((line) => line.replace(/^[-*•·]\s*/, ''));
    } catch (e) {
      console.error('[L3] 抽取失败:', e);
      return [];
    }
  }

  private parseFactLine(line: string): { category: FactCategory; text: string } {
    const m = line.match(/^\[(\w+)\]\s*(.+)$/);
    if (!m) return { category: 'other', text: line };
    const cat = m[1] as FactCategory;
    return {
      category: VALID_CATEGORIES.includes(cat) ? cat : 'other',
      text: m[2].trim(),
    };
  }

  private normalize(text: string): string {
    return text.toLowerCase().replace(/\s+/g, '').replace(/[，。、！？,.\!?]/g, '');
  }

  private async saveFacts(facts: Fact[]) {
    if (facts.length === 0) return;
    const file = join(this.factsDir, 'facts.jsonl');
    const lines = facts.map((f) => JSON.stringify(f)).join('\n') + '\n';
    await appendFile(file, lines, 'utf8');
  }

  async loadAll(): Promise<Fact[]> {
    const file = join(this.factsDir, 'facts.jsonl');
    if (!existsSync(file)) return [];
    const content = await readFile(file, 'utf8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as Fact;
        } catch {
          return null;
        }
      })
      .filter((f): f is Fact => f !== null);
  }

  async mergeAndDedup(): Promise<number> {
    const all = await this.loadAll();
    const map = new Map<string, Fact>();
    for (const f of all) {
      const key = this.normalize(f.text);
      if (map.has(key)) {
        const existing = map.get(key)!;
        existing.verifyCount = Math.max(existing.verifyCount, f.verifyCount);
        existing.confidence = Math.max(existing.confidence, f.confidence);
        existing.verified = existing.verified || f.verified;
        existing.lastSeen = f.lastSeen > existing.lastSeen ? f.lastSeen : existing.lastSeen;
      } else {
        map.set(key, f);
      }
    }

    const merged = Array.from(map.values());
    const file = join(this.factsDir, 'facts.jsonl');
    await writeFile(file, merged.map((f) => JSON.stringify(f)).join('\n') + '\n', 'utf8');
    return merged.length;
  }

  async query(opts: { category?: FactCategory; keyword?: string; verifiedOnly?: boolean; limit?: number }): Promise<Fact[]> {
    let all = await this.loadAll();
    if (opts.category) all = all.filter((f) => f.category === opts.category);
    if (opts.verifiedOnly) all = all.filter((f) => f.verified);
    if (opts.keyword) {
      const kw = opts.keyword.toLowerCase();
      all = all.filter((f) => f.text.toLowerCase().includes(kw));
    }
    all.sort((a, b) => {
      if (a.verified !== b.verified) return a.verified ? -1 : 1;
      return b.confidence - a.confidence;
    });
    return all.slice(0, opts.limit || 20);
  }

  async deleteById(id: string): Promise<boolean> {
    const all = await this.loadAll();
    const filtered = all.filter((f) => f.id !== id);
    if (filtered.length === all.length) return false;
    const file = join(this.factsDir, 'facts.jsonl');
    await writeFile(file, filtered.map((f) => JSON.stringify(f)).join('\n') + '\n', 'utf8');
    return true;
  }
}
