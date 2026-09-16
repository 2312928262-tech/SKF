// M20 · skill 机制（SKILL.md 装载器）验收测试
//
// 覆盖：frontmatter 解析 / 触发词匹配 / 目录加载 / 校验（超限/非法）/ 检索 /
// 注入文本段 / 与 M13 分层（skill 不改权限、不登记检查点）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseSkillFrontmatter, validateSkillMeta, matchSkills, skillBundleText } from '../dist/skill/contracts.js';
import { loadSkillsFromDir } from '../dist/skill/loader.js';
import { SkillRegistry } from '../dist/skill/registry.js';

async function mkSkillsDir(files) {
  const dir = await mkdtemp(join(tmpdir(), 'skf-m20-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
  return dir;
}

async function cleanup(dir) {
  const absolute = resolve(dir);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  for (let i = 0; i < 5; i++) {
    try { await rm(absolute, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 80 * (i + 1))); }
  }
}

// ── T01: frontmatter 解析 ───────────────────────────────────────────

test('T01 parseSkillFrontmatter 解析 name/description/triggers + body', () => {
  const content = `---\nname: 处理图片\ndescription: 如何裁剪缩放导出\ntriggers: [图片, 裁剪, 缩放]\n---\n正文内容\n第二行`;
  const { meta, body } = parseSkillFrontmatter(content);
  assert.equal(meta.name, '处理图片');
  assert.equal(meta.description, '如何裁剪缩放导出');
  assert.deepEqual(meta.triggers, ['图片', '裁剪', '缩放']);
  assert.equal(body, '正文内容\n第二行');
});

// ── T02: 无 frontmatter 时整文件作正文，空触发词 ────────────────────

test('T02 无 frontmatter 时整文件作正文，空触发词', () => {
  const { meta, body } = parseSkillFrontmatter('纯文本正文');
  assert.equal(meta.name, '');
  assert.deepEqual(meta.triggers, []);
  assert.equal(body, '纯文本正文');
});

// ── T03: 触发词匹配（大小写不敏感，中文词项重叠）──────────────────

test('T03 matchSkills 触发词匹配', () => {
  const skill = {
    id: 'img', meta: { name: '图片', description: '', triggers: ['图片', 'IMAGE'] }, body: 'x', sourcePath: '', contentHash: 'h', byteLength: 1,
  };
  assert.equal(matchSkills('帮我处理一张图片', [skill]).length, 1);
  assert.equal(matchSkills('process an image', [skill]).length, 1);
  assert.equal(matchSkills('写代码', [skill]).length, 0);
});

// ── T04: 目录加载 + 校验（超限/非法文件跳过）─────────────────────

test('T04 loadSkillsFromDir 加载 .md + 跳过非 .md/超限/非法', async () => {
  const dir = await mkSkillsDir({
    'a-skill.md': '---\nname: A\ndescription: d\ntriggers: [x]\n---\nbody',
    'b-skill.md': '---\nname: B\ndescription: d\ntriggers: [y]\n---\n' + 'x'.repeat(40_000), // 超限
    'c-note.txt': 'not markdown',
    'd-skill.md': '---\nname: \ndescription: d\n---\nbody', // 非法 name
  });
  try {
    const result = loadSkillsFromDir(dir);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].id, 'a-skill');
    // 跳过：b 超限 body + d 非法 name；c-note.txt 非 .md 静默跳过（不记录）。
    assert.equal(result.skipped.length, 2);
  } finally { await cleanup(dir); }
});

// ── T05: validateSkillMeta 校验（name/description/trigger 上限）───

test('T05 validateSkillMeta 校验 name/description/trigger 上限', () => {
  assert.throws(() => validateSkillMeta({ name: '', description: '', triggers: [] }), /INVALID_SKILL/);
  assert.throws(() => validateSkillMeta({ name: 'x'.repeat(65), description: '', triggers: [] }), /INVALID_SKILL/);
  assert.throws(() => validateSkillMeta({ name: 'ok', description: '', triggers: ['t'.repeat(65)] }), /INVALID_SKILL/);
  const ok = validateSkillMeta({ name: 'ok', description: 'd', triggers: ['a', 'b'] });
  assert.equal(ok.name, 'ok');
  assert.deepEqual(ok.triggers, ['a', 'b']);
});

// ── T06: SkillRegistry 检索 + 注入文本段 ───────────────────────────

test('T06 SkillRegistry load + list + search + bundleFor', async () => {
  const dir = await mkSkillsDir({
    'img.md': '---\nname: 处理图片\ndescription: 裁剪缩放导出\ntriggers: [图片, 裁剪]\n---\n第一步裁剪\n第二步导出',
    'code.md': '---\nname: 写代码\ndescription: 代码规范\ntriggers: [代码, 编程]\n---\n使用严格类型',
  });
  try {
    const reg = new SkillRegistry({ dir });
    const result = reg.load();
    assert.equal(result.skills.length, 2);
    assert.equal(reg.status().count, 2);
    const list = reg.list();
    assert.equal(list.length, 2);
    const imgEntry = list.find((s) => s.id === 'img');
    assert.ok(imgEntry, 'img skill in list');
    assert.equal(imgEntry.name, '处理图片');
    const search = reg.search('图片');
    assert.equal(search.length, 1);
    assert.equal(search[0].id, 'img');
    const bundle = reg.bundleFor('帮我处理图片');
    assert.ok(bundle.includes('[skill:img]'));
    assert.ok(bundle.includes('第一步裁剪'));
    assert.ok(!bundle.includes('[skill:code]'));
  } finally { await cleanup(dir); }
});

// ── T07: 与 M13 分层（skill 不改权限，无硬检查点）─────────────────

test('T07 skill 是项目声明：正文标"仅参考"，不产生检查点/不改权限', () => {
  const skill = {
    id: 'img', meta: { name: '图片', description: '裁剪', triggers: ['图片'] }, body: '正文', sourcePath: '', contentHash: 'h', byteLength: 1,
  };
  const bundle = skillBundleText([skill]);
  assert.ok(bundle.includes('仅参考'), '正文标仅参考');
  assert.ok(bundle.includes('不改变权限'), '不改变权限');
  // skill 不进入 learning_task_checkpoints（无检查点概念；与 M13 candidate/confirmed 分层）。
});

// ── T08: 空目录/缺失目录 → 空技能（不报错）────────────────────────

test('T08 空目录/缺失目录 → 空技能（不中断）', () => {
  const result = loadSkillsFromDir('D:/nonexistent-dir-xyz');
  assert.deepEqual(result.skills, []);
});

// ── T09: 触发词数量上限截断 ────────────────────────────────────────

test('T09 触发词数量上限截断（≤16）', () => {
  const triggers = Array.from({ length: 30 }, (_, i) => `t${i}`);
  const meta = validateSkillMeta({ name: 'ok', description: 'd', triggers });
  assert.equal(meta.triggers.length, 16);
});

// ── T10: 注入文本段多技能分隔 ──────────────────────────────────────

test('T10 skillBundleText 多技能用分隔符隔开', () => {
  const s1 = { id: 'a', meta: { name: 'A', description: 'da', triggers: ['x'] }, body: 'ba', sourcePath: '', contentHash: 'h', byteLength: 1 };
  const s2 = { id: 'b', meta: { name: 'B', description: 'db', triggers: ['y'] }, body: 'bb', sourcePath: '', contentHash: 'h', byteLength: 1 };
  const bundle = skillBundleText([s1, s2]);
  assert.ok(bundle.includes('[skill:a]'));
  assert.ok(bundle.includes('[skill:b]'));
  assert.ok(bundle.split('---').length >= 3);
});
