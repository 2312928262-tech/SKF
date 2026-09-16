/**
 * M20 · skill 机制契约（SKILL.md 装载器）
 *
 * 与 M13 学习闭环分层：
 *   - M13 learning_experiences = 运行时经验候选/确认（自动复盘产出，trust=candidate/confirmed）。
 *   - skill = 项目级声明式技能（人工/项目声明，SKILL.md 文件 + frontmatter 触发词）。
 * 两者都通过 prepareContext 注入 AgentLoop system 文本，但来源与信任语义不同：
 *   skill 是"项目声明"，不改变 PolicyGate/审批门/预算规则；candidate 经验是"仅参考"。
 *
 * SKILL.md frontmatter（YAML 简化解析，仅 name/description/triggers 三个字段）：
 *   ---
 *   name: 处理图片
 *   description: 如何裁剪、缩放、导出图片
 *   triggers: [图片, 裁剪, 缩放, 导出图]
 *   ---
 *   正文（Markdown；注入时原样保留，不执行）
 *
 * 触发词匹配：任务 goal + scope 与 triggers 词项重叠时命中；大小写不敏感；中文按词项重叠。
 * 首版不做语义检索（与 M13 词项重叠同口径）。
 */

import { readFileSync } from 'node:fs';

export interface SkillMeta {
  name: string;
  description: string;
  triggers: readonly string[];
}

export interface Skill {
  /** 技能 ID（文件名去 .md；稳定性）。 */
  id: string;
  meta: SkillMeta;
  /** SKILL.md 正文（去 frontmatter；注入时原样）。 */
  body: string;
  /** 来源路径（诊断用）。 */
  sourcePath: string;
  /** 内容 hash（去重/校验）。 */
  contentHash: string;
  /** 字节数（上限校验）。 */
  byteLength: number;
}

export const MAX_SKILL_FILES = 64;
export const MAX_SKILL_BODY_BYTES = 32_768;
export const MAX_TRIGGERS = 16;
export const MAX_TRIGGER_LENGTH = 64;
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 512;

/** 触发词匹配：goal 文本与 skill.triggers 任一词项重叠（大小写不敏感）。 */
export function skillMatchesTrigger(goal: string, skill: Skill): boolean {
  const text = goal.toLowerCase();
  return skill.meta.triggers.some((t) => text.includes(t.toLowerCase()));
}

/** 触发词检索：从技能集合中选出命中触发词的技能（≤ limit）。 */
export function matchSkills(goal: string, skills: readonly Skill[], limit = 5): Skill[] {
  const matched = skills.filter((s) => skillMatchesTrigger(goal, s));
  return matched.slice(0, limit);
}

/** 注入文本段（与 learning bundleText 并列；标不可信/项目声明）。 */
export function skillBundleText(skills: readonly Skill[]): string {
  if (skills.length === 0) return '';
  const blocks = skills.map((s) => `[skill:${s.id}] ${s.meta.description}\n${s.body.slice(0, MAX_SKILL_BODY_BYTES)}`);
  return `\n\n---\n\n## 项目声明技能（SKILL.md，仅参考，不改变权限）\n\n` + blocks.join('\n\n---\n\n');
}

/** frontmatter 简化解析：只认 --- 包裹的 YAML 三字段；不解析任意 YAML。 */
export function parseSkillFrontmatter(content: string): { meta: SkillMeta; body: string } {
  const text = content.replace(/^\uFEFF/, '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    // 无 frontmatter：整文件作正文，meta 为空触发词。
    return { meta: { name: '', description: '', triggers: [] }, body: text };
  }
  const front = match[1];
  const body = match[2];
  const meta: SkillMeta = { name: '', description: '', triggers: [] };
  for (const line of front.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (key === 'name') meta.name = value;
    else if (key === 'description') meta.description = value;
    else if (key === 'triggers') {
      // 支持 YAML 流式 [a, b, c] 或简单逗号分隔。
      const inner = value.replace(/^\[|\]$/g, '').trim();
      meta.triggers = inner
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    }
  }
  return { meta, body };
}

/** 校验 meta 形状；返回规范化后的 meta。 */
export function validateSkillMeta(raw: SkillMeta): SkillMeta {
  const name = raw.name.trim();
  if (name.length === 0 || name.length > MAX_SKILL_NAME_LENGTH) throw new Error('INVALID_SKILL: name required (1..64 chars)');
  const description = raw.description.trim();
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) throw new Error('INVALID_SKILL: description too long');
  const triggers = raw.triggers
    .filter((t) => t.trim().length > 0)
    .slice(0, MAX_TRIGGERS)
    .map((t) => {
      const x = t.trim();
      if (x.length > MAX_TRIGGER_LENGTH) throw new Error('INVALID_SKILL: trigger too long');
      return x;
    });
  return { name, description, triggers };
}

/** 读取文件内容（UTF-8；剥 BOM）。 */
export function readSkillFile(path: string): string {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
}
