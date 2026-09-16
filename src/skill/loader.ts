/**
 * M20 · skill 装载器（扫描 skills 目录 + 解析 SKILL.md + 校验）
 */

import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { RuntimeError } from '../runtime/contracts.js';
import {
  MAX_SKILL_BODY_BYTES,
  MAX_SKILL_FILES,
  parseSkillFrontmatter,
  readSkillFile,
  validateSkillMeta,
  type Skill,
} from './contracts.js';

export interface SkillLoaderResult {
  skills: Skill[];
  /** 被跳过的文件（非 .md / 超限 / 校验失败），附原因。 */
  skipped: Array<{ path: string; reason: string }>;
}

/** 扫描目录（非递归）加载 SKILL.md；超限/校验失败跳过并记录（不中断加载）。 */
export function loadSkillsFromDir(dir: string): SkillLoaderResult {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { skills: [], skipped: [] };
  }
  const skills: Skill[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let count = 0;
  for (const name of entries.sort()) {
    if (extname(name).toLowerCase() !== '.md') continue;
    const fullPath = join(dir, name);
    if (skills.length >= MAX_SKILL_FILES) {
      skipped.push({ path: fullPath, reason: `over max ${MAX_SKILL_FILES} files` });
      continue;
    }
    let st;
    try {
      st = statSync(fullPath);
    } catch {
      skipped.push({ path: fullPath, reason: 'stat failed' });
      continue;
    }
    if (!st.isFile()) continue;
    let raw: string;
    try {
      raw = readSkillFile(fullPath);
    } catch {
      skipped.push({ path: fullPath, reason: 'read failed' });
      continue;
    }
    const { meta, body } = parseSkillFrontmatter(raw);
    let validated;
    try {
      validated = validateSkillMeta(meta);
    } catch (error) {
      skipped.push({ path: fullPath, reason: (error as Error).message });
      continue;
    }
    const bodyBytes = Buffer.byteLength(body, 'utf8');
    if (bodyBytes > MAX_SKILL_BODY_BYTES) {
      skipped.push({ path: fullPath, reason: `body > ${MAX_SKILL_BODY_BYTES} bytes` });
      continue;
    }
    const id = basename(name, '.md');
    const contentHash = createHash('sha256').update(raw, 'utf8').digest('hex');
    skills.push({
      id,
      meta: validated,
      body,
      sourcePath: fullPath,
      contentHash,
      byteLength: Buffer.byteLength(raw, 'utf8'),
    });
    count++;
  }
  return { skills, skipped };
}
