/**
 * M20 · SkillRegistry（管理已加载技能 + 触发词检索 + IPC 查询）
 *
 * 只读机制：加载 SKILL.md → 按触发词/关键词检索 → 注入 system 文本。
 * 不改变 PolicyGate/审批门/预算；技能正文是"项目声明"，标不可信数据，不执行。
 */

import { join } from 'node:path';
import { RuntimeError } from '../runtime/contracts.js';
import { matchSkills, skillBundleText, type Skill } from './contracts.js';
import { loadSkillsFromDir, type SkillLoaderResult } from './loader.js';

export interface SkillRegistryDeps {
  /** skills 目录（默认 <dataRoot>/skills）。 */
  dir?: string;
  logger?: (line: string) => void;
}

export class SkillRegistry {
  private skills: Skill[] = [];
  private skipped: Array<{ path: string; reason: string }> = [];
  private readonly dir: string | undefined;

  constructor(deps: SkillRegistryDeps = {}) {
    this.dir = deps.dir;
    if (deps.logger) this.logger = deps.logger;
  }

  private logger: (line: string) => void = () => {};

  /** 加载技能（幂等：重复加载替换旧集合）。 */
  load(): SkillLoaderResult {
    if (!this.dir) {
      this.skills = [];
      this.skipped = [];
      return { skills: [], skipped: [] };
    }
    const result = loadSkillsFromDir(this.dir);
    this.skills = result.skills;
    this.skipped = result.skipped;
    this.logger(`[skill] loaded ${this.skills.length} skills, skipped ${this.skipped.length}`);
    return result;
  }

  /** 触发词匹配 + 注入文本段。 */
  bundleFor(goal: string, limit = 5): string {
    if (this.skills.length === 0) return '';
    const matched = matchSkills(goal, this.skills, limit);
    return skillBundleText(matched);
  }

  /** IPC skill.list：返回技能元数据（不含正文，避免超限）。 */
  list(): Array<{ id: string; name: string; description: string; triggers: string[]; byteLength: number }> {
    return this.skills.map((s) => ({
      id: s.id,
      name: s.meta.name,
      description: s.meta.description,
      triggers: [...s.meta.triggers],
      byteLength: s.byteLength,
    }));
  }

  /** IPC skill.search：按关键词检索（name/description/triggers 词项重叠；不含正文）。 */
  search(query: string, limit = 20): Array<{ id: string; name: string; description: string }> {
    const q = query.toLowerCase();
    return this.skills
      .filter((s) => {
        if (s.id.toLowerCase().includes(q)) return true;
        if (s.meta.name.toLowerCase().includes(q)) return true;
        if (s.meta.description.toLowerCase().includes(q)) return true;
        return s.meta.triggers.some((t) => t.toLowerCase().includes(q));
      })
      .slice(0, limit)
      .map((s) => ({ id: s.id, name: s.meta.name, description: s.meta.description }));
  }

  /** 技能总数 + 跳过数（诊断）。 */
  status(): { count: number; skipped: number } {
    return { count: this.skills.length, skipped: this.skipped.length };
  }

  /** 测试用：直接注入技能（绕过文件加载）。 */
  _setSkills(skills: Skill[]): void {
    this.skills = skills;
  }
}

/** 配置：skills 目录（默认 <dataRoot>/skills）。 */
export function skillDirOf(dataRoot: string): string {
  return join(dataRoot, 'skills');
}
