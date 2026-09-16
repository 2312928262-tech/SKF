// M11 共享：打包目录 manifest + 禁打包扫描。
// 扫描结果只输出文件位置与规则编号，绝不输出匹配到的值。
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export async function walk(dir) {
  const out = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) out.push(...await walk(full));
    else if (item.isFile()) out.push(full);
  }
  return out;
}

export async function buildManifest(root, extra = {}) {
  const files = (await walk(root)).sort();
  const entries = [];
  for (const full of files) {
    const buf = await readFile(full);
    entries.push({ path: relative(root, full).split(sep).join('/'), bytes: buf.length, sha256: sha256(buf) });
  }
  return {
    generatedAt: new Date().toISOString(),
    root,
    fileCount: entries.length,
    totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
    rootHash: sha256(Buffer.from(entries.map((e) => e.path + '\0' + e.sha256).join('\n'), 'utf8')),
    files: entries,
    ...extra,
  };
}

// 路径规则：私人主档 / requests / .env / 备份 / 旧代理会话 / 密钥文件 / 日志 / e2e 探针。
export const PATH_RULES = [
  ['R-PATH-ENV', /(?:^|\/)\.env(?:\.|$)|(?:^|\/)config\.env$/i],
  ['R-PATH-VAULT', /(?:^|\/)vault(?:\/|$)/i],
  ['R-PATH-REQUESTS', /(?:^|\/)requests(?:\/|$)/i],
  ['R-PATH-DATA-DIR', /(?:^|\/)(memory-outbox|backups|skf-data|xiaoliu-memory)(?:\/|$)/i],
  ['R-PATH-SQLITE', /\.sqlite(-shm|-wal)?$/i],
  ['R-PATH-E2E-PROBE', /e2e-frontend|e2e-probe/i],
  ['R-PATH-KEYFILE', /\.(pem|key|p12|pfx|kdbx)$|id_rsa/i],
  ['R-PATH-LOG', /\.log$/i],
  ['R-PATH-GIT', /(?:^|\/)\.git(?:\/|$)/i],
  ['R-PATH-LEGACY-SESSION', /(?:^|\/)tasks\/[a-f0-9]{64}\.json$/i],
];

// 内容规则：只匹配「字面量赋值/密钥形状」，不匹配 env 变量名引用（值字符类不含 . 和空格）。
// SECRET-ASSIGN 要求值内至少一个数字：排除 `secret: SomeTypeName` / `apiKey = API_KEY_SENTINEL`
// 这类代码标识符误报（真实密钥形状由 R-CONTENT-KEY-SHAPE 兜底，不受数字要求影响）。
export const CONTENT_RULES = [
  ['R-CONTENT-SECRET-ASSIGN', /(?:api[_-]?key|secret|token|password)["'_\-\s]*[:=]["'\s]*(?=[A-Za-z0-9_\-\/+]*\d)[A-Za-z0-9_\-\/+]{16,}/i],
  ['R-CONTENT-KEY-SHAPE', /\b(?:sk|pk|xox[baprs]|ghp|gho|glpat|hf|AIza)[-_][A-Za-z0-9_\-]{16,}\b/],
];

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.map', '.ts', '.txt', '.yml', '.yaml', '.xml', '.svg', '.d.ts']);
const CONTENT_SCAN_MAX_BYTES = 8 * 1024 * 1024;

/** 扫描一组 manifest 条目（root 为实物目录）。返回 { findings }，只含 path+rule。 */
export async function scanManifest(root, entries, allowlist = []) {
  const findings = [];
  for (const e of entries) {
    for (const [rule, re] of PATH_RULES) {
      if (re.test(e.path)) findings.push({ path: e.path, rule });
    }
    const ext = e.path.slice(e.path.lastIndexOf('.')).toLowerCase();
    if (!TEXT_EXT.has(ext) || e.bytes > CONTENT_SCAN_MAX_BYTES) continue;
    const text = await readFile(join(root, e.path), 'utf8');
    for (const [rule, re] of CONTENT_RULES) {
      if (re.test(text)) findings.push({ path: e.path, rule });
    }
  }
  const allowed = findings.filter((f) => allowlist.some((a) => a.path === f.path && a.rule === f.rule));
  const blocked = findings.filter((f) => !allowed.includes(f));
  return { findings, allowed, blocked, verdict: blocked.length === 0 ? 'CLEAN' : 'BLOCKED' };
}
