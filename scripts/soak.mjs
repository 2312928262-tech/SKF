#!/usr/bin/env node
/**
 * scripts/soak.mjs — M12 · 48 小时长稳调度器（04-ACCEPTANCE「48 小时稳定性规则」）
 *
 * 形态：同一 rc/build hash 下，单个 supervisor 子进程（fake provider，纯本地），
 * 每 5 分钟一个小任务（聊天/文件/查记忆轮换），每小时一次取消+断线重连演练，
 * 计划内受控 worker 重启（默认第 16h 空闲重启、第 36h 在途重启）。
 * 逐小时记录 RSS/handles/队列/p50/p95/错误分类；零容忍项逐小时核查：
 * 数据损坏 / 任务外写入 / 重复副作用 / 预算旁路 / 非预期崩溃 / 构建被改动。
 *
 * 用法：
 *   node scripts/soak.mjs                          # 48h 正式跑
 *   node scripts/soak.mjs --duration-hours 1       # 缩短演练（不算 48h 通过）
 *   node scripts/soak.mjs --self-test              # ~1 分钟自检（含全部演练类型）
 *   node scripts/soak.mjs --root <dir> --resume    # driver 自身崩溃后续跑
 *
 * 纪律：只杀本驱动记录的子进程 PID；不删任何用户文件；零网络零付费（fake/本地）；
 * 未满时长绝不写「长稳通过」。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const DEV_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUPERVISOR = join(DEV_ROOT, 'dist', 'supervisor.js');
const TEST_RUNS = 'D:/SKF-Work/test-runs';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

// ── 参数 ────────────────────────────────────────────────

function parseArgs(argv) {
  const cfg = {
    durationHours: 48,
    cycleMs: 5 * 60_000,
    root: null,
    resume: false,
    selfTest: false,
    restartHours: [16, 36], // [空闲重启, 在途重启]
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') cfg.selfTest = true;
    else if (a === '--resume') cfg.resume = true;
    else if (a === '--duration-hours') cfg.durationHours = Number(argv[++i]);
    else if (a === '--cycle-ms') cfg.cycleMs = Number(argv[++i]);
    else if (a === '--root') cfg.root = resolve(argv[++i]);
    else if (a === '--restarts') cfg.restartHours = argv[++i].split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    else if (a === '--help' || a === '-h') {
      console.log('node scripts/soak.mjs [--duration-hours N] [--cycle-ms N] [--root DIR] [--restarts h1,h2] [--resume] [--self-test]');
      process.exit(0);
    } else throw new Error('未知参数: ' + a);
  }
  if (cfg.selfTest) {
    cfg.durationHours = 8 / 720; // 8 个周期 × 5s
    cfg.cycleMs = 5000;
    cfg.drillEveryCycles = 2; // 压缩：每 2 个周期做一次取消+重连演练
    cfg.restartCycles = { idle: 4, inflight: 6 };
  } else {
    cfg.drillEveryCycles = 12; // 每小时（12×5min）
    cfg.restartCycles = {
      idle: cfg.restartHours[0] !== undefined ? Math.round(cfg.restartHours[0] * (3_600_000 / cfg.cycleMs)) : null,
      inflight: cfg.restartHours[1] !== undefined ? Math.round(cfg.restartHours[1] * (3_600_000 / cfg.cycleMs)) : null,
    };
  }
  cfg.totalCycles = Math.max(1, Math.round(cfg.durationHours * 3_600_000 / cfg.cycleMs));
  cfg.cyclesPerSegment = cfg.drillEveryCycles; // 「小时」= drillEveryCycles 个周期
  if (!cfg.root) {
    const stamp = nowIso().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    cfg.root = join(TEST_RUNS, `soak-${cfg.selfTest ? 'selftest-' : ''}${stamp}`);
  }
  return cfg;
}

// ── rc 构建指纹（全程同一 build hash；每小时复核）────────

function computeRcManifest() {
  const files = [];
  const walk = (abs, relBase) => {
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(abs, entry.name);
      const rel = relBase + '/' + entry.name;
      if (entry.isDirectory()) walk(p, rel);
      else files.push({ rel, sha256: sha256(readFileSync(p)), bytes: statSync(p).size });
    }
  };
  for (const dir of ['dist', 'vendor', 'prompts', 'src', 'ui-preview']) walk(join(DEV_ROOT, dir), dir);
  walk(join(DEV_ROOT, 'src-tauri', 'src'), 'src-tauri/src');
  for (const f of ['package.json', 'package-lock.json', 'tsconfig.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
    const p = join(DEV_ROOT, f);
    if (existsSync(p)) files.push({ rel: f, sha256: sha256(readFileSync(p)), bytes: statSync(p).size });
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const rootHash = sha256(files.map((f) => `${f.rel}:${f.sha256}`).join('\n'));
  return { rootHash, fileCount: files.length, files };
}

// ── 进度/心跳 ───────────────────────────────────────────

class Journal {
  constructor(file) {
    this.file = file;
  }
  write(rec) {
    appendFileSync(this.file, JSON.stringify({ at: nowIso(), ...rec }) + '\n', 'utf8');
  }
}

// ── IPC 客户端（与测试同款协议：v2 请求响应 + 事件推送帧）──

class IpcClient {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.events = [];
    this.eventWaiters = [];
    this.stderr = '';
    this.detached = false;
    this.detachedBuffer = '';
    this.sink = (chunk) => {
      if (this.detached) this.detachedBuffer += chunk.toString('utf8');
    };
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 200_000) this.stderr = this.stderr.slice(-100_000);
    });
    this.rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.onLine(line));
  }

  onLine(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame && typeof frame === 'object' && frame.event) {
      this.events.push(frame.event);
      for (const waiter of [...this.eventWaiters]) {
        if (waiter.pred(frame.event)) {
          clearTimeout(waiter.timer);
          this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
          waiter.resolve(frame.event);
        }
      }
      return;
    }
    if (frame && typeof frame.id === 'string' && this.pending.has(frame.id)) {
      const entry = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      entry.resolve(frame);
    }
  }

  request(action, data = {}, protocol = 2) {
    const id = randomUUID();
    const frame = { id, action, data };
    if (protocol !== undefined && protocol !== null) frame.protocol = protocol;
    const promise = new Promise((resolvePromise) => this.pending.set(id, { resolve: resolvePromise }));
    this.child.stdin.write(JSON.stringify(frame) + '\n');
    return promise;
  }

  /** v1 帧（chat/history/provider/ping）：显式不带 protocol 字段（默认参数陷阱：传 undefined 会落回默认 2）。 */
  requestV1(action, data = {}) {
    return this.request(action, data, null);
  }

  async call(action, data = {}, protocol = 2) {
    const frame = await this.request(action, data, protocol);
    if (!frame.ok) {
      const error = new Error(frame.error);
      error.code = frame.error;
      throw error;
    }
    return frame.data;
  }

  waitForEvent(pred, timeoutMs, label) {
    const existing = this.events.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error(`timeout waiting ${label}; stderr: ${this.stderr.slice(-400)}`)),
        timeoutMs,
      );
      this.eventWaiters.push({ pred, resolve: resolvePromise, timer });
    });
  }

  /** 断线演练：事件不再解析（流进缓冲区防管堵），但 stdin 保持（supervisor 不会因管道关闭退出）。 */
  detach() {
    this.detached = true;
    this.rl.removeAllListeners('line');
    this.child.stdout.on('data', this.sink);
  }

  /** 重连：丢弃断线期间推送帧（权威是 events 表，走 events.since 补）。 */
  reattach() {
    this.child.stdout.removeListener('data', this.sink);
    this.detachedBuffer = '';
    this.detached = false;
    this.rl.on('line', (line) => this.onLine(line));
  }

  close() {
    this.rl.removeAllListeners('line');
    this.child.stdout.removeListener('data', this.sink);
    for (const entry of this.pending.values()) entry.resolve({ id: '', ok: false, error: 'CLIENT_CLOSED' });
    this.pending.clear();
    for (const waiter of this.eventWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
  }
}

// ── 子进程环境（最小 allowlist；剥离真实云 key 与代理/网关 env）──

function childEnv(root, fixturePath) {
  const keep = ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'OS'];
  const env = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  return {
    ...env,
    NODE_ENV: 'test',
    SKF_SKIP_ENV: '1',
    SKF_DATA_DIR: join(root, 'data'),
    SKF_MEMORY_ROOT: join(root, 'vault'),
    SKF_MEMORY_SEMANTIC: '0',
    SKF_MEMORY_SCOPE: 'skf-soak',
    SKF_BUDGET_MODE: 'call-limit',
    SKF_OPENCLAW_BRIDGE: '0',
    XIAOLIU_PROVIDER: 'fake',
    SKF_FAKE_PROVIDER: '1',
    SKF_FAKE_FIXTURE: fixturePath,
  };
}

// ── 剧本（fixture 步骤与调度完全确定，driver 自己生成）───

const fileContent = (c) => `# soak 交付 ${c}\n\nsynthetic soak 文件任务产物，周期 ${c}。\n\n- 生成时间由调度器记录\n- 内容确定可校验\n`;

function stepsForCycle(cfg, c) {
  const steps = [];
  const t = c % 3;
  if (cfg.restartCycles.inflight === c) {
    // 在途重启演练取代本周期常规工作：单步长延迟，SIGKILL 后 fixture 无遗留未消费步
    return [
      { delayMs: 60_000, toolCalls: [{ id: `soakx-c${c}`, name: 'file.write', arguments: { path: `soak-inflight-${c}.md`, content: fileContent(c) } }] },
    ];
  }
  if (t === 0) {
    steps.push({ text: `soak 聊天回复 #${c}：本地 fake 大脑在岗，本轮一切正常。`, usage: { inputTokens: 15, outputTokens: 12 } });
  } else if (t === 1) {
    steps.push(
      { toolCalls: [{ id: `soakw-c${c}`, name: 'file.write', arguments: { path: `soak-file-${c}.md`, content: fileContent(c) } }], usage: { inputTokens: 20, outputTokens: 6 } },
      { expectToolResults: [`soakw-c${c}`], text: `文件 soak-file-${c}.md 已创建并读回校验。`, usage: { inputTokens: 30, outputTokens: 10 } },
    );
  }
  // t === 2 是查记忆周期：纯 IPC memory.*，不消耗模型步骤
  if ((c + 1) % cfg.drillEveryCycles === 0) {
    // 取消演练：单步长延迟（abort 后恰消费 1 步，后续任务步骤不错位）
    steps.push(
      { delayMs: 30_000, toolCalls: [{ id: `soakd-c${c}`, name: 'file.write', arguments: { path: `soak-drill-${c}.md`, content: fileContent(c) } }] },
    );
    // 断线重连演练：普通两步文件任务
    steps.push(
      { toolCalls: [{ id: `soakr-c${c}`, name: 'file.write', arguments: { path: `soak-reconn-${c}.md`, content: fileContent(c) } }] },
      { expectToolResults: [`soakr-c${c}`], text: `文件 soak-reconn-${c}.md 已创建。` },
    );
  }
  return steps;
}

function fixtureForEpoch(cfg, fromCycle) {
  const steps = [];
  for (let c = fromCycle; c < cfg.totalCycles; c++) steps.push(...stepsForCycle(cfg, c));
  return steps;
}

/** 周期 c 之前（含 c-1）按剧本应消耗的模型调用总数（用于与 sqlite 对账）。 */
function expectedConsumedBefore(cfg, c) {
  let n = 0;
  for (let i = 0; i < c; i++) {
    if (cfg.restartCycles.inflight === i) {
      n += 1; // 在途重启：延迟步被 abort，计 1 次
      continue;
    }
    const t = i % 3;
    if (t === 0) n += 1;
    else if (t === 1) n += 2;
    if ((i + 1) % cfg.drillEveryCycles === 0) n += 1 + 2; // 取消 1 + 重连 2
  }
  return n;
}

// ── 进程采样（Windows：WorkingSet + HandleCount）─────────

function sampleProcess(pid) {
  const ps = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `$p=Get-Process -Id ${pid} -ErrorAction Stop; "$($p.WorkingSet64) $($p.HandleCount)"`],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true },
  );
  if (ps.status !== 0) return null;
  const [rss, handles] = ps.stdout.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(rss) || !Number.isFinite(handles)) return null;
  return { rssBytes: rss, handles };
}

function pidAlive(pid) {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return r.status === 0 && r.stdout.includes(String(pid));
}

// ── 主驱动 ──────────────────────────────────────────────

class SoakDriver {
  constructor(cfg) {
    this.cfg = cfg;
    this.root = cfg.root;
    this.wsDir = join(this.root, 'ws');
    this.progressFile = join(this.root, 'soak-progress.jsonl');
    this.stateFile = join(this.root, 'soak-state.json');
    this.journal = new Journal(this.progressFile);
    this.child = null;
    this.client = null;
    this.epoch = 0;
    this.violations = [];
    this.errors = {}; // code -> count
    this.latencies = []; // {cycle, kind, ms}
    this.samples = [];
    this.rc = computeRcManifest();
    this.stopped = false;
  }

  log(rec) {
    this.journal.write(rec);
  }

  fail(code, detail) {
    this.errors[code] = (this.errors[code] ?? 0) + 1;
    this.log({ type: 'error', code, detail: String(detail).slice(0, 300) });
  }

  violate(klass, detail) {
    const rec = { type: 'violation', class: klass, detail: String(detail).slice(0, 400) };
    this.violations.push(rec);
    this.log(rec);
  }

  persistState(cycle) {
    writeFileSync(
      this.stateFile,
      JSON.stringify({
        startedAt: this.startedAt,
        cycle,
        epoch: this.epoch,
        pids: this.child && this.child.exitCode === null ? [this.child.pid] : [],
        errors: this.errors,
        violations: this.violations,
        samples: this.samples,
        latencies: this.latencies.slice(-2000),
      }),
      'utf8',
    );
  }

  /** 启动新 epoch：生成本 epoch fixture → 拉起 supervisor（隐藏窗口）。 */
  async spawnEpoch(fromCycle) {
    this.epoch += 1;
    const steps = fixtureForEpoch(this.cfg, fromCycle);
    const fixturePath = join(this.root, `fixture-epoch${this.epoch}.json`);
    writeFileSync(fixturePath, JSON.stringify({ steps }), 'utf8');
    const child = spawn(process.execPath, [SUPERVISOR, '--ipc'], {
      env: childEnv(this.root, fixturePath),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: this.root,
    });
    this.child = child;
    this.client = new IpcClient(child);
    this.childDead = false;
    this.expectingExit = false;
    child.once('exit', (code) => {
      this.childDead = true;
      if (!this.expectingExit && !this.stopped) this.violate('unexpected-crash', `supervisor pid=${child.pid} exit code=${code}; stderr: ${this.client.stderr.slice(-300)}`);
    });
    this.log({ type: 'spawn', epoch: this.epoch, pid: child.pid, fromCycle, fixtureSteps: steps.length, fixturePath });
    const ping = await this.client.call('ping');
    if (ping.provider !== 'fake') throw new Error('ping provider 非 fake: ' + ping.provider);
    return ping;
  }

  /** 只杀本驱动记录的子进程；先确认是我们的 supervisor 再终止。 */
  async killChild(reason) {
    const child = this.child;
    if (!child || this.childDead) return;
    const pid = child.pid;
    this.log({ type: 'kill', pid, reason });
    this.expectingExit = true;
    this.client.close();
    child.kill('SIGKILL');
    const deadline = Date.now() + 8000;
    while (!this.childDead && Date.now() < deadline) await sleep(100);
    this.expectingExit = false;
    if (!this.childDead) {
      this.violate('kill-failed', `pid=${pid} 8s 内未退出`);
    }
    this.child = null;
    this.client = null;
  }

  // ── 周期工作 ─────────────────────────────────────────

  async runChat(c) {
    const started = Date.now();
    const frame = await this.client.requestV1('chat', { message: `synthetic soak 聊天 #${c}：今天感觉如何？` });
    if (!frame.ok) throw Object.assign(new Error(frame.error), { code: frame.error });
    this.latencies.push({ cycle: c, kind: 'chat', ms: Date.now() - started });
    return frame.data.text;
  }

  async runFileTask(c, { idPrefix = 'soak-task', fileName, callIdPrefix = 'soakw-c', timeoutMs = 120_000 } = {}) {
    const taskId = `${idPrefix}-${c}`;
    const started = Date.now();
    const acceptance = {
      kind: 'file_deliverable',
      files: [{ path: fileName, minBytes: 20, mustContain: ['soak', String(c)] }],
    };
    await this.client.call('task.start', {
      id: taskId,
      input: { goal: `synthetic soak 文件任务 #${c}：在工作区创建 ${fileName}` },
      workspaceRoot: this.wsDir,
      provider: 'fake',
      acceptance,
    });
    await this.client.waitForEvent(
      (e) => e.taskId === taskId && (e.type === 'task.succeeded' || e.type === 'task.failed'),
      timeoutMs,
      `${taskId} terminal`,
    );
    const got = await this.client.call('task.get', { taskId });
    if (got.task.state !== 'succeeded') {
      throw Object.assign(new Error(got.task.errorCode ?? 'TASK_FAILED'), { code: got.task.errorCode ?? 'TASK_FAILED' });
    }
    // 产物实物与账本一致（重复副作用/伪造完成的双重核查）
    if (got.artifacts.length !== 1 || got.artifacts[0].relativePath !== fileName) {
      this.violate('artifact-mismatch', `${taskId}: artifacts=${JSON.stringify(got.artifacts)}`);
    }
    const diskHash = sha256(readFileSync(join(this.wsDir, fileName)));
    if (got.artifacts[0].sha256 !== diskHash) {
      this.violate('data-corruption', `${taskId}: artifact hash 与磁盘不符`);
    }
    this.latencies.push({ cycle: c, kind: 'file', ms: Date.now() - started });
    return got;
  }

  async runMemoryCycle(c) {
    const started = Date.now();
    const found = await this.client.call('memory.search', { query: 'soak 聊天 回复', limit: 5 });
    const hits = Array.isArray(found.hits) ? found.hits : [];
    const status = await this.client.call('memory.status', {});
    // 每 24 个记忆周期做一次更正写路径（有命中才做，空库如实记跳过）
    if (c % 24 === 2 && hits.length > 0) {
      const id = hits[0].id;
      await this.client.call('memory.correct', { id, text: `synthetic soak 更正（周期 ${c}）：原记录已由调度器演练更正。`, reason: 'soak 记忆更正演练' });
      const got = await this.client.call('memory.get', { id });
      if (!got.record) this.fail('MEMORY_CORRECT_LOST', id);
    }
    this.latencies.push({ cycle: c, kind: 'memory', ms: Date.now() - started });
    return { hits: hits.length, records: status.stats?.records ?? null };
  }

  // ── 演练 ─────────────────────────────────────────────

  async cancelDrill(c) {
    const taskId = `soak-drill-${c}`;
    await this.client.call('task.start', {
      id: taskId,
      input: { goal: `synthetic soak 取消演练 #${c}` },
      workspaceRoot: this.wsDir,
      provider: 'fake',
    });
    // 等模型步开始（delayMs 30s 给了充足取消窗口）
    await this.client.waitForEvent((e) => e.taskId === taskId && (e.type === 'task.running' || e.type === 'task.state'), 20_000, 'drill running');
    await sleep(500);
    await this.client.call('task.cancel', { taskId });
    await this.client.waitForEvent((e) => e.taskId === taskId && e.type === 'task.cancelled', 30_000, 'drill cancelled');
    // 断言：磁盘零副作用（取消发生在工具前）+ 模型调用记 uncertain（不记免费）
    if (existsSync(join(this.wsDir, `soak-drill-${c}.md`))) {
      this.violate('cancel-side-effect', `${taskId}: 取消后仍写出文件`);
    }
    const row = this.dbGet(`SELECT state FROM model_calls WHERE taskId = ?`, taskId);
    if (!row || row.state !== 'uncertain') {
      this.violate('budget-bypass', `${taskId}: 取消中的模型调用应 uncertain，实际 ${row?.state ?? 'missing'}`);
    }
    this.log({ type: 'drill', kind: 'cancel', cycle: c, ok: true });
  }

  async reconnectDrill(c) {
    const lastSeq = this.client.events.reduce((m, e) => Math.max(m, e.eventSeq ?? 0), 0);
    this.client.detach();
    const taskId = `soak-reconn-${c}`;
    // 断线期间直接写帧发任务（不等待响应帧，推送会进缓冲区）
    const started = Date.now();
    this.child.stdin.write(JSON.stringify({
      id: randomUUID(), protocol: 2, action: 'task.start',
      data: {
        id: taskId,
        input: { goal: `synthetic soak 断线重连演练 #${c}` },
        workspaceRoot: this.wsDir,
        provider: 'fake',
        acceptance: { kind: 'file_deliverable', files: [{ path: `soak-reconn-${c}.md`, minBytes: 20, mustContain: ['soak'] }] },
      },
    }) + '\n');
    await sleep(Math.min(10_000, this.cfg.cycleMs * 1.5)); // 断线窗口：任务在后台完成
    this.client.reattach();
    // 权威补发：events.since 从断点续传，eventSeq 严格递增、无重复
    const backfill = await this.client.call('events.since', { afterSeq: lastSeq, limit: 1000 });
    const seqs = backfill.events.map((e) => e.eventSeq);
    for (let i = 1; i < seqs.length; i++) {
      if (seqs[i] <= seqs[i - 1]) this.violate('event-replay', `eventSeq 非递增: ${seqs[i - 1]}→${seqs[i]}`);
    }
    if (new Set(seqs).size !== seqs.length) this.violate('event-replay', '补发出现重复 eventSeq');
    const got = await this.client.call('task.get', { taskId });
    if (got.task.state !== 'succeeded') {
      throw Object.assign(new Error(got.task.errorCode ?? 'RECONN_TASK_FAILED'), { code: got.task.errorCode ?? 'RECONN_TASK_FAILED' });
    }
    if (got.artifacts.length !== 1) this.violate('duplicate-side-effect', `${taskId}: artifacts=${got.artifacts.length}`);
    this.latencies.push({ cycle: c, kind: 'reconnect', ms: Date.now() - started });
    this.log({ type: 'drill', kind: 'reconnect', cycle: c, ok: true, backfilled: seqs.length });
  }

  async restartIdle() {
    await this.killChild('planned-idle-restart');
    // 本周期的常规工作已在旧 epoch 消耗完毕，新 epoch 必须从下一周期起生成 fixture，
    // 否则 fake 步骤错位（会重放已完成周期的步骤）。
    await this.spawnEpoch(this.stateCycle + 1);
    const listed = await this.client.call('task.list', { limit: 200 });
    const active = listed.tasks.filter((t) => ['queued', 'running', 'cancelling'].includes(t.state));
    if (active.length > 0) this.violate('restart-residue', `空闲重启后仍有活动任务: ${active.map((t) => t.id).join(',')}`);
    this.log({ type: 'drill', kind: 'restart-idle', cycle: this.stateCycle, ok: true });
  }

  async restartInflight(c) {
    const taskId = `soak-inflight-${c}`;
    await this.client.call('task.start', {
      id: taskId,
      input: { goal: `synthetic soak 在途重启演练 #${c}` },
      workspaceRoot: this.wsDir,
      provider: 'fake',
    });
    await this.client.waitForEvent((e) => e.taskId === taskId && (e.type === 'task.running' || e.type === 'task.state'), 20_000, 'inflight running');
    await sleep(1000);
    await this.killChild('planned-inflight-restart');
    await this.spawnEpoch(c + 1);
    // 恢复语义：running → interrupted（只标识不重试）；模型调用 reserved→uncertain
    const got = await this.client.call('task.get', { taskId });
    if (got.task.state !== 'interrupted') {
      this.violate('recovery-wrong', `${taskId}: 重启后应 interrupted，实际 ${got.task.state}`);
    }
    const row = this.dbGet(`SELECT state, settledCostMicros FROM model_calls WHERE taskId = ?`, taskId);
    // M07 语义：在途被杀的调用绝不结算（reserved 在恢复预检时按 uncertain 阻塞，标 uncertain 是 resume 路径的事）
    if (!row || row.state === 'settled' || row.settledCostMicros !== null) {
      this.violate('budget-bypass', `${taskId}: 在途被杀的模型调用不得结算，实际 ${JSON.stringify(row ?? 'missing')}`);
    }
    if (existsSync(join(this.wsDir, `soak-inflight-${c}.md`))) {
      this.violate('duplicate-side-effect', `${taskId}: 在途任务文件不应存在`);
    }
    this.log({ type: 'drill', kind: 'restart-inflight', cycle: c, ok: true });
  }

  // ── 零容忍核查（每小时 + 收尾）────────────────────────

  db() {
    return new DatabaseSync(join(this.root, 'data', 'runtime.sqlite'), { readOnly: true });
  }

  dbGet(sql, ...params) {
    const db = this.db();
    try {
      return db.prepare(sql).get(...params);
    } finally {
      db.close();
    }
  }

  zeroChecks(segment) {
    // 1) 数据损坏：sqlite 完整性 + 事件链连续
    const db = this.db();
    try {
      const qc = db.prepare('PRAGMA quick_check').get();
      if (Object.values(qc)[0] !== 'ok') this.violate('data-corruption', `quick_check=${JSON.stringify(qc)}`);
      const ev = db.prepare('SELECT COUNT(*) n, MIN(eventSeq) lo, MAX(eventSeq) hi FROM events').get();
      if (ev.n > 0 && ev.hi - ev.lo + 1 !== ev.n) this.violate('data-corruption', `eventSeq 不连续: ${JSON.stringify(ev)}`);
      // 2) 预算旁路：所有模型调用必须是 fake provider（零云）
      const providers = db.prepare('SELECT provider, COUNT(*) n FROM model_calls GROUP BY provider').all();
      for (const p of providers) {
        if (p.provider !== 'fake') this.violate('budget-bypass', `出现非 fake provider 调用: ${JSON.stringify(p)}`);
      }
      // 3) 重复副作用：artifact 路径不得重复；与剧本期望数对账
      const dup = db.prepare('SELECT relativePath, COUNT(*) n FROM artifacts GROUP BY relativePath HAVING n > 1').all();
      if (dup.length > 0) this.violate('duplicate-side-effect', `artifact 路径重复: ${JSON.stringify(dup)}`);
      // 4) 模型调用总数与剧本对账（任何偷偷多调的都会露馅）；已有停线违例或周期失败恢复后
      //    剧本消耗不再确定，只记录降级不追加误判
      if (this.violations.length === 0 && !this.accountingDegraded) {
        const calls = db.prepare('SELECT COUNT(*) n FROM model_calls').get().n;
        const expected = expectedConsumedBefore(this.cfg, this.stateCycle + 1);
        if (calls !== expected) this.violate('budget-bypass', `model_calls=${calls} 与剧本期望 ${expected} 不符`);
      }
    } finally {
      db.close();
    }
    // 5) 任务外写入：工作区只允许剧本文件名
    if (existsSync(this.wsDir)) {
      const allowed = /^soak-(file|reconn)-\d+\.md$/;
      const walkWs = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) walkWs(p);
          else if (!allowed.test(entry.name)) this.violate('out-of-task-write', `工作区出现非剧本文件: ${p}`);
        }
      };
      walkWs(this.wsDir);
    }
    // 6) 构建指纹：长稳全程同一 rc（边跑边改 = 停线）
    const now = computeRcManifest();
    if (now.rootHash !== this.rc.rootHash) {
      this.violate('build-mutated', `build hash 漂移: ${this.rc.rootHash.slice(0, 12)}→${now.rootHash.slice(0, 12)}`);
    }
    this.log({ type: 'checks', segment, ok: this.violations.length === 0 });
  }

  async sample(segment) {
    const pid = this.child?.pid;
    const proc = pid ? sampleProcess(pid) : null;
    if (!proc && pid && !this.stopped) this.violate('unexpected-crash', `pid=${pid} 采样失败（进程消失）`);
    const hourLat = this.latencies.slice(-this.cfg.cyclesPerSegment * 3).map((l) => l.ms).sort((a, b) => a - b);
    const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null);
    try {
      const listed = await this.client.call('task.list', { limit: 200 });
      const queued = listed.tasks.filter((t) => t.state === 'queued').length;
      const running = listed.tasks.filter((t) => t.state === 'running' || t.state === 'cancelling').length;
      const rec = {
        type: 'sample',
        segment,
        rssBytes: proc?.rssBytes ?? null,
        handles: proc?.handles ?? null,
        queued,
        running,
        p50ms: pct(hourLat, 0.5),
        p95ms: pct(hourLat, 0.95),
        errors: { ...this.errors },
        violations: this.violations.length,
      };
      this.samples.push(rec);
      this.log(rec);
    } catch (e) {
      this.fail('SAMPLE_FAILED', e.message);
    }
  }

  // ── 主循环 ───────────────────────────────────────────

  async run() {
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.wsDir, { recursive: true });
    if (!this.cfg.resume) {
      if (existsSync(this.stateFile)) throw new Error('root 已有状态文件；用 --resume 续跑或换 --root');
      writeFileSync(join(this.root, 'SOAK-TEST-ROOT.marker'), `synthetic soak root, created ${nowIso()} by scripts/soak.mjs\n`, 'utf8');
      writeFileSync(join(this.root, 'rc-manifest.json'), JSON.stringify(this.rc, null, 2), 'utf8');
    } else {
      const st = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      this.startedAt = st.startedAt;
      this.errors = st.errors ?? {};
      this.samples = st.samples ?? [];
      this.latencies = st.latencies ?? [];
      for (const pid of st.pids ?? []) {
        if (pidAlive(pid)) {
          // 只杀我们自己记录的 supervisor
          spawnSync('taskkill', ['/PID', String(pid), '/F'], { timeout: 10_000, windowsHide: true });
        }
      }
      this.log({ type: 'resume', fromCycle: st.cycle });
      this.stateCycle = st.cycle;
    }
    if (!this.startedAt) this.startedAt = nowIso();
    const startMs = Date.now() - (this.stateCycle ?? 0) * this.cfg.cycleMs;
    this.log({
      type: 'start',
      buildHash: this.rc.rootHash,
      fileCount: this.rc.fileCount,
      config: {
        durationHours: this.cfg.durationHours, cycleMs: this.cfg.cycleMs, totalCycles: this.cfg.totalCycles,
        restartCycles: this.cfg.restartCycles, drillEveryCycles: this.cfg.drillEveryCycles, selfTest: this.cfg.selfTest,
      },
      root: this.root,
      pid: process.pid,
    });

    await this.spawnEpoch(this.stateCycle ?? 0);
    let consecutiveFailures = 0;

    for (let c = this.stateCycle ?? 0; c < this.cfg.totalCycles && !this.stopped; c++) {
      this.stateCycle = c;
      // 固定网格对齐，抗漂移
      const gridAt = startMs + c * this.cfg.cycleMs;
      const wait = gridAt - Date.now();
      if (wait > 0) await sleep(wait);

      try {
        if (this.cfg.restartCycles.inflight === c) {
          await this.restartInflight(c);
        } else {
          const t = c % 3;
          if (t === 0) await this.runChat(c);
          else if (t === 1) await this.runFileTask(c, { fileName: `soak-file-${c}.md` });
          else await this.runMemoryCycle(c);
          if (this.cfg.restartCycles.idle === c) await this.restartIdle();
        }
        if ((c + 1) % this.cfg.drillEveryCycles === 0) {
          await this.cancelDrill(c);
          await this.reconnectDrill(c);
          this.zeroChecks(Math.floor((c + 1) / this.cfg.cyclesPerSegment));
          await this.sample(Math.floor((c + 1) / this.cfg.cyclesPerSegment));
        }
        consecutiveFailures = 0;
        this.log({ type: 'cycle', cycle: c, ok: true });
      } catch (error) {
        consecutiveFailures += 1;
        this.fail(error.code ?? 'CYCLE_FAILED', `cycle ${c}: ${error.message}`);
        this.log({ type: 'cycle', cycle: c, ok: false, code: error.code ?? 'CYCLE_FAILED' });
        if (consecutiveFailures >= 3) {
          this.violate('soak-aborted', `连续 ${consecutiveFailures} 个周期失败，提前终止`);
          break;
        }
        // 单发失败（如超时）：恢复性重启 worker，不让一个坏状态污染全程；
        // 被杀周期可能消耗了部分 fixture 步，精确对账从此降级（仍保留 provider 纯度等其余核查）
        this.accountingDegraded = `cycle ${c} 失败后恢复性重启`;
        await this.killChild('recovery-respawn').catch(() => {});
        await this.spawnEpoch(c + 1).catch((e) => this.fail('RESPAWN_FAILED', e.message));
      }
      this.persistState(c + 1);
      if (this.violations.length > 0) break; // 零容忍：任一停线条件立即收线分析
    }

    await this.finish();
  }

  async finish() {
    this.stopped = true;
    this.zeroChecks('final');
    await this.killChild('soak-finished');

    // 趋势分析：首段 vs 末段中位数（20% 检查阈值）
    const segCount = this.samples.length;
    const head = this.samples.filter((s) => s.segment <= Math.min(6, segCount)).map((s) => s.rssBytes).filter(Boolean).sort((a, b) => a - b);
    const tail = this.samples.filter((s) => s.segment > Math.max(0, segCount - 6)).map((s) => s.rssBytes).filter(Boolean).sort((a, b) => a - b);
    const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);
    const headMed = med(head);
    const tailMed = med(tail);
    const rssRatio = headMed && tailMed ? tailMed / headMed : null;
    const headH = med(this.samples.filter((s) => s.segment <= Math.min(6, segCount)).map((s) => s.handles).filter(Boolean).sort((a, b) => a - b));
    const tailH = med(this.samples.filter((s) => s.segment > Math.max(0, segCount - 6)).map((s) => s.handles).filter(Boolean).sort((a, b) => a - b));
    const handleRatio = headH && tailH ? tailH / headH : null;

    const fullDuration = (this.stateCycle ?? 0) + 1 >= this.cfg.totalCycles && this.cfg.durationHours >= 48;
    let verdict;
    if (this.violations.length > 0) verdict = 'FAIL';
    else if (rssRatio !== null && rssRatio > 1.2) verdict = 'PENDING-EXPLANATION';
    else if (!fullDuration) verdict = this.cfg.selfTest ? 'SELFTEST-PASS' : 'PARTIAL';
    else verdict = 'PASS';

    const final = {
      type: 'end',
      verdict,
      fullDuration48h: fullDuration,
      cyclesCompleted: (this.stateCycle ?? 0) + 1,
      totalCycles: this.cfg.totalCycles,
      epochs: this.epoch,
      buildHash: this.rc.rootHash,
      startedAt: this.startedAt,
      finishedAt: nowIso(),
      errors: this.errors,
      violations: this.violations,
      rss: { headMedian: headMed, tailMedian: tailMed, ratio: rssRatio, threshold: 1.2 },
      handles: { headMedian: headH, tailMedian: tailH, ratio: handleRatio },
      samples: this.samples,
    };
    writeFileSync(join(this.root, 'soak-final.json'), JSON.stringify(final, null, 2), 'utf8');
    this.log(final);
    console.log(JSON.stringify({ verdict, root: this.root, cycles: final.cyclesCompleted, buildHash: this.rc.rootHash.slice(0, 16), violations: this.violations.length, rssRatio, handleRatio }));
    process.exit(this.violations.length > 0 ? 1 : 0);
  }
}

// ── 入口 ────────────────────────────────────────────────

const cfg = parseArgs(process.argv);
mkdirSync(TEST_RUNS, { recursive: true });
const driver = new SoakDriver(cfg);
// driver 被杀/崩溃时不连坐杀别的进程；子进程 stdin 随 driver 退出而关闭，supervisor 自行收尾（M10 语义）
process.on('SIGINT', () => {
  driver.stopped = true;
  driver.log({ type: 'driver-signal', signal: 'SIGINT' });
  driver.killChild('driver-sigint').finally(() => process.exit(2));
});
await driver.run();
