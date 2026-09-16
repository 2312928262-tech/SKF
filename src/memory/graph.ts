/**
 * L4 时序图谱 (Temporal Knowledge Graph)
 * ============================================
 * 实体 + 关系 + 时间窗。BFS 查询任意实体的 N 层关系网。
 *
 * 设计参考: Zep GraphRAG、MemGPT archival graph
 * 文件格式: 04-graph/entities.jsonl + 04-graph/relations.jsonl
 */

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type EntityType = 'person' | 'project' | 'tool' | 'concept' | 'place' | 'event' | 'other';

export interface Entity {
  id: string;                  // ent-<sha1>
  name: string;                // 标准化名称（小写）
  displayName: string;         // 原始显示
  type: EntityType;
  aliases: string[];           // 别名（小写）
  attributes: Record<string, string>;  // 自由属性
  firstSeen: string;           // ISO timestamp
  lastSeen: string;
  accessCount: number;         // 被引用次数（强化用）
}

export type RelationType = 'works_on' | 'knows' | 'uses' | 'prefers' | 'lives_in' | 'part_of' | 'related_to' | 'caused' | 'opposite_of';

export interface Relation {
  id: string;                  // rel-<sha1>
  from: string;                // entity id
  to: string;                  // entity id
  type: RelationType;
  weight: number;              // 0-1，越高越强
  evidence: string[];          // 来源事实 ID 列表
  firstSeen: string;
  lastSeen: string;
  validUntil?: string;         // 关系失效时间（可选）
}

export interface GraphQueryOptions {
  entity: string;              // 实体名或 ID
  depth?: number;              // BFS 深度（默认 2）
  sinceDays?: number;          // 只看最近 N 天
  minWeight?: number;          // 关系最低权重（默认 0.3）
  limit?: number;              // 最大返回实体数（默认 50）
}

export interface GraphNode {
  entity: Entity;
  depth: number;
  viaRelation?: Relation;
}

export interface GraphQueryResult {
  root: Entity;
  nodes: GraphNode[];
  totalEntities: number;
  totalRelations: number;
}

export class TemporalGraph {
  private entitiesPath: string;
  private relationsPath: string;
  private graphDir: string;
  private entityCache: Map<string, Entity> = new Map();
  private relationCache: Map<string, Relation> = new Map();
  private cacheLoaded = false;

  constructor(opts: { root: string }) {
    this.graphDir = join(opts.root, '04-graph');
    this.entitiesPath = join(this.graphDir, 'entities.jsonl');
    this.relationsPath = join(this.graphDir, 'relations.jsonl');
  }

  async init() {
    if (!existsSync(this.graphDir)) {
      await mkdir(this.graphDir, { recursive: true });
    }
    if (!existsSync(this.entitiesPath)) {
      await writeFile(this.entitiesPath, '', 'utf8');
    }
    if (!existsSync(this.relationsPath)) {
      await writeFile(this.relationsPath, '', 'utf8');
    }
  }

  private async ensureLoaded() {
    if (this.cacheLoaded) return;
    await this.loadAll();
    this.cacheLoaded = true;
  }

  private async loadAll() {
    // Entities
    if (existsSync(this.entitiesPath)) {
      const content = await readFile(this.entitiesPath, 'utf8');
      for (const line of content.split('\n').filter((l) => l.trim())) {
        try {
          const e = JSON.parse(line) as Entity;
          this.entityCache.set(e.id, e);
        } catch {
          // skip malformed
        }
      }
    }
    // Relations
    if (existsSync(this.relationsPath)) {
      const content = await readFile(this.relationsPath, 'utf8');
      for (const line of content.split('\n').filter((l) => l.trim())) {
        try {
          const r = JSON.parse(line) as Relation;
          this.relationCache.set(r.id, r);
        } catch {
          // skip malformed
        }
      }
    }
  }

  private async flushEntities() {
    const lines = Array.from(this.entityCache.values()).map((e) => JSON.stringify(e)).join('\n');
    await writeFile(this.entitiesPath, lines ? lines + '\n' : '', 'utf8');
  }

  private async flushRelations() {
    const lines = Array.from(this.relationCache.values()).map((r) => JSON.stringify(r)).join('\n');
    await writeFile(this.relationsPath, lines ? lines + '\n' : '', 'utf8');
  }

  private makeId(prefix: string, key: string): string {
    // 简单 hash（生产可用 crypto.createHash）
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash |= 0;
    }
    return `${prefix}-${Math.abs(hash).toString(36)}`;
  }

  private normalize(name: string): string {
    return name.toLowerCase().trim().replace(/\s+/g, '_');
  }

  /** 查找或创建实体（按标准化名匹配） */
  async upsertEntity(input: { name: string; type?: EntityType; alias?: string; attributes?: Record<string, string> }): Promise<Entity> {
    await this.ensureLoaded();
    const normName = this.normalize(input.name);
    const existing = Array.from(this.entityCache.values()).find(
      (e) => e.name === normName || e.aliases.includes(normName),
    );

    if (existing) {
      existing.lastSeen = new Date().toISOString();
      existing.accessCount++;
      if (input.alias && !existing.aliases.includes(this.normalize(input.alias))) {
        existing.aliases.push(this.normalize(input.alias));
      }
      if (input.attributes) {
        Object.assign(existing.attributes, input.attributes);
      }
      await this.flushEntities();
      return existing;
    }

    const now = new Date().toISOString();
    const entity: Entity = {
      id: this.makeId('ent', normName),
      name: normName,
      displayName: input.name,
      type: input.type || 'other',
      aliases: input.alias ? [this.normalize(input.alias)] : [],
      attributes: input.attributes || {},
      firstSeen: now,
      lastSeen: now,
      accessCount: 1,
    };
    this.entityCache.set(entity.id, entity);
    await this.flushEntities();
    return entity;
  }

  /** 创建/强化关系 */
  async upsertRelation(input: { from: string; to: string; type: RelationType; weight?: number; evidence?: string }): Promise<Relation> {
    await this.ensureLoaded();
    const key = `${input.from}|${input.type}|${input.to}`;
    const id = this.makeId('rel', key);
    const existing = this.relationCache.get(id);

    if (existing) {
      existing.lastSeen = new Date().toISOString();
      existing.weight = Math.min(1, existing.weight + 0.05);
      if (input.evidence && !existing.evidence.includes(input.evidence)) {
        existing.evidence.push(input.evidence);
      }
      await this.flushRelations();
      return existing;
    }

    const now = new Date().toISOString();
    const relation: Relation = {
      id,
      from: input.from,
      to: input.to,
      type: input.type,
      weight: input.weight ?? 0.5,
      evidence: input.evidence ? [input.evidence] : [],
      firstSeen: now,
      lastSeen: now,
    };
    this.relationCache.set(relation.id, relation);
    await this.flushRelations();
    return relation;
  }

  /** BFS 查询实体的关系网 */
  async query(opts: GraphQueryOptions): Promise<GraphQueryResult | null> {
    await this.ensureLoaded();
    const depth = opts.depth ?? 2;
    const limit = opts.limit ?? 50;
    const minWeight = opts.minWeight ?? 0.3;
    const sinceTs = opts.sinceDays
      ? Date.now() - opts.sinceDays * 24 * 3600 * 1000
      : 0;

    // 找到根实体
    const normQuery = this.normalize(opts.entity);
    const root = Array.from(this.entityCache.values()).find(
      (e) => e.name === normQuery || e.aliases.includes(normQuery),
    );
    if (!root) return null;

    const visited = new Map<string, GraphNode>();
    visited.set(root.id, { entity: root, depth: 0 });

    // BFS 队列
    const queue: { entityId: string; currentDepth: number }[] = [{ entityId: root.id, currentDepth: 0 }];
    while (queue.length > 0) {
      const { entityId, currentDepth } = queue.shift()!;
      if (currentDepth >= depth) continue;

      const relations = Array.from(this.relationCache.values()).filter(
        (r) => (r.from === entityId || r.to === entityId) &&
               r.weight >= minWeight &&
               new Date(r.lastSeen).getTime() >= sinceTs,
      );

      for (const rel of relations) {
        const neighborId = rel.from === entityId ? rel.to : rel.from;
        if (visited.has(neighborId)) continue;
        const neighbor = this.entityCache.get(neighborId);
        if (!neighbor) continue;
        visited.set(neighborId, { entity: neighbor, depth: currentDepth + 1, viaRelation: rel });
        queue.push({ entityId: neighborId, currentDepth: currentDepth + 1 });
      }
    }

    // 按访问次数 + 深度排序，截断
    const sorted = Array.from(visited.values())
      .sort((a, b) => {
        if (a.depth !== b.depth) return a.depth - b.depth;
        return b.entity.accessCount - a.entity.accessCount;
      })
      .slice(0, limit);

    return {
      root,
      nodes: sorted,
      totalEntities: this.entityCache.size,
      totalRelations: this.relationCache.size,
    };
  }

  /** 从文本提取实体 + 关系（轻量启发式 + LLM 调用可选） */
  async extractFromFact(fact: { id: string; text: string; category: string }): Promise<{ entities: Entity[]; relations: Relation[] }> {
    const entities: Entity[] = [];
    const relations: Relation[] = [];

    // 启发式：找中文/英文专有名词、Project 名（首字母大写短语）、@人
    const patterns: Array<{ regex: RegExp; type: EntityType; transform?: (s: string) => string }> = [
      // 用户提到的项目（首字母大写或中文项目词）
      { regex: /「([^」]+)」|『([^』]+)』/g, type: 'project' },
      { regex: /项目\s*[「『]?([^」』]+)/g, type: 'project' },
      // @人
      { regex: /@([\w\u4e00-\u9fa5]{2,20})/g, type: 'person' },
      // 工具名
      { regex: /\b(SKF|OpenClaw|Tauri|Rust|Node|Python|GitHub|Git)\b/g, type: 'tool' },
      // 地名（中国 + 省/市）
      { regex: /(贵州|贵阳|北京|上海|广州|深圳|杭州|成都|昆明)([市省区]?)/g, type: 'place' },
    ];

    const foundNames = new Set<string>();
    for (const { regex, type } of patterns) {
      const matches = fact.text.matchAll(regex);
      for (const m of matches) {
        const name = (m[1] || m[0]).trim();
        if (name.length >= 2 && !foundNames.has(name)) {
          foundNames.add(name);
          const entity = await this.upsertEntity({ name, type, attributes: { sourceFact: fact.id } });
          entities.push(entity);
        }
      }
    }

    // 关系：基于类别推断
    if (fact.category === 'project') {
      // 项目 → 用户
      const owner = await this.upsertEntity({ name: '用户', type: 'person', attributes: { role: 'user' } });
      for (const ent of entities.filter((e) => e.type === 'project')) {
        const rel = await this.upsertRelation({
          from: owner.id,
          to: ent.id,
          type: 'works_on',
          weight: 0.7,
          evidence: fact.id,
        });
        relations.push(rel);
      }
    }

    return { entities, relations };
  }

  /** 渲染图为可读字符串（用于上下文注入） */
  formatForContext(result: GraphQueryResult, maxNodes = 8): string {
    if (result.nodes.length <= 1) return '';
    const lines: string[] = [`## 时序图谱 (L4) · 以「${result.root.displayName}」为中心`];
    const others = result.nodes.slice(1, maxNodes + 1);
    for (const node of others) {
      const rel = node.viaRelation;
      const relDesc = rel ? `${rel.type}(w=${rel.weight.toFixed(2)})` : 'self';
      lines.push(`- ${node.entity.displayName} [${node.entity.type}] depth=${node.depth} via ${relDesc}`);
    }
    if (result.nodes.length > maxNodes + 1) {
      lines.push(`- ... 还有 ${result.nodes.length - maxNodes - 1} 个相关实体`);
    }
    return lines.join('\n');
  }

  /** 状态：实体/关系总数 */
  async status(): Promise<{ entities: number; relations: number; topEntities: Entity[] }> {
    await this.ensureLoaded();
    const topEntities = Array.from(this.entityCache.values())
      .sort((a, b) => b.accessCount - a.accessCount)
      .slice(0, 10);
    return {
      entities: this.entityCache.size,
      relations: this.relationCache.size,
      topEntities,
    };
  }
}
