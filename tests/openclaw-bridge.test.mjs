import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeStore } from '../dist/runtime/runtime-store.js';
import { TaskService } from '../dist/runtime/task-service.js';
import { ToolRegistry, bridgeToolsOfInput } from '../dist/tools/registry.js';
import { localDeliveryAuthorization } from '../dist/tools/policy.js';
import { OpenClawBridge } from '../dist/tools/openclaw-bridge.js';
import { FakeScriptedProvider } from '../dist/providers/fake-scripted.js';
import { runAgentLoop } from '../dist/runtime/agent-loop.js';

// M09 验收：OpenClaw 可选桥接。
// 覆盖 B01 不可用负缓存无重连风暴、B02 完全关闭零探测、B03 假桥全链路
// （typed schema/effect policy/输出截断/调用审计）、B04 桥接工具进 AgentLoop
// 成功闭环、B05 桥不可用时显式桥接任务如实失败不假装完成。
// 全部本机临时假 CLI，零网络、零真实 OpenClaw 依赖。

async function cleanupTestRoot(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-m09b-[a-zA-Z0-9]+$/);
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** 临时假 OpenClaw CLI：--version/status/health + 调用审计日志 + 故障/大输出注入。 */
async function makeFakeOpenClaw(root) {
  const log = join(root, 'fake-oc-calls.log');
  const script = join(root, 'fake-openclaw-cli.mjs');
  await writeFile(
    script,
    [
      "import { appendFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      'if (process.env.FAKE_OC_LOG) appendFileSync(process.env.FAKE_OC_LOG, JSON.stringify(args) + \'\\n\');',
      'const cmd = args[0];',
      "if (cmd === '--version') { console.log('openclaw/9.9.9-fake (m09 test)'); process.exit(0); }",
      "if (cmd === 'status') {",
      "  if (process.env.FAKE_OC_BIG === '1') { console.log('x'.repeat(40 * 1024)); process.exit(0); }",
      "  console.log('FAKE-STATUS-MARK: gateway ok (fake)'); process.exit(0);",
      '}',
      "if (cmd === 'health') {",
      "  if (process.env.FAKE_OC_FAIL_HEALTH === '1') { console.error('gateway not running (fake)'); process.exit(3); }",
      "  console.log('FAKE-HEALTH-MARK: healthy'); process.exit(0);",
      '}',
      "console.error('unknown command'); process.exit(2);",
    ].join('\n'),
    'utf8',
  );
  let command;
  if (process.platform === 'win32') {
    command = join(root, 'fake-openclaw.cmd');
    await writeFile(command, `@echo off\r\nnode "%~dp0fake-openclaw-cli.mjs" %*\r\n`, 'utf8');
  } else {
    command = join(root, 'fake-openclaw');
    await writeFile(command, `#!/bin/sh\nexec node "$(dirname "$0")/fake-openclaw-cli.mjs" "$@"\n`, { mode: 0o755 });
  }
  return { command, log };
}

async function readLog(log) {
  try {
    return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// ── B01：unavailable 负缓存 —— 清楚标记 + 无重连风暴 ──────────────

test('B01 桥不可用：清楚标 unavailable；连续查询命中负缓存只探测一次（无重连风暴）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m09b-'));
  try {
    const bridge = new OpenClawBridge({ command: 'definitely-not-exists-openclaw-m09' });
    const s1 = await bridge.status();
    assert.equal(s1.state, 'unavailable');
    assert.match(s1.reason ?? '', /未找到|探测/);
    const s2 = await bridge.status();
    const s3 = await bridge.status();
    assert.equal(s2.state, 'unavailable');
    assert.equal(s3.state, 'unavailable');
    assert.equal(bridge.probeCount, 1, 'negative cache must prevent probe storms');
    // peek 不发起探测
    assert.equal(bridge.peek().state, 'unavailable');
    assert.equal(bridge.probeCount, 1);
    // 已登记工具逐个有名有姓（没有透传）
    assert.deepEqual(bridge.knownTools().sort(), ['openclaw.health', 'openclaw.status']);
  } finally {
    await cleanupTestRoot(root);
  }
});

// ── B02：SKF_OPENCLAW_BRIDGE=0 完全关闭，零探测进程 ────────────────

test('B02 桥完全关闭（enabled=false）：status=disabled，零探测进程', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m09b-'));
  try {
    const bridge = new OpenClawBridge({ enabled: false, command: 'definitely-not-exists-openclaw-m09' });
    const status = await bridge.status();
    assert.equal(status.state, 'disabled');
    assert.equal(bridge.probeCount, 0);
    assert.equal(bridge.peek().state, 'disabled');
  } finally {
    await cleanupTestRoot(root);
  }
});

// ── B03：假桥全链路 —— schema/policy/截断/审计/故障如实 ─────────────

test('B03 假桥可用：typed schema 拒绝多余字段；effect policy 逐个点名；输出截断；调用可审计；命令失败如实上报', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m09b-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  try {
    const fake = await makeFakeOpenClaw(root);
    process.env.FAKE_OC_LOG = fake.log;
    const bridge = new OpenClawBridge({ command: fake.command });
    const status = await bridge.status();
    assert.equal(status.state, 'available');
    assert.match(status.version ?? '', /9\.9\.9-fake/);
    // 正缓存：再次 status 不重新探测
    await bridge.status();
    assert.equal(bridge.probeCount, 1);

    const registry = new ToolRegistry(bridge.specs());
    const auth = { ...localDeliveryAuthorization(ws), allowedBridgeTools: ['openclaw.status'] };
    const ctx = { taskId: 't-b03', workspaceRoot: ws, authorization: auth };

    // 成功调用：输出含假桥标记；审计日志记到 status 一次
    const ok = await registry.execute('call-1', 'openclaw.status', {}, ctx);
    assert.equal(ok.ok, true);
    const content = JSON.parse(ok.content);
    assert.match(content.output, /FAKE-STATUS-MARK/);
    assert.equal(content.truncated, false);
    assert.deepEqual((await readLog(fake.log)).filter((a) => a[0] === 'status').length, 1);

    // typed schema：多余字段拒绝（不能借 args 注入任意子命令）
    const bad = await registry.execute('call-2', 'openclaw.status', { exec: 'rm -rf' }, ctx);
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'TOOL_ARGS_INVALID');

    // effect policy：未点名授权 → POLICY_DENIED（即使桥可用）
    const denied = await registry.execute('call-3', 'openclaw.health', {}, ctx);
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'POLICY_DENIED');
    // health 从未被执行（审计为零）
    assert.deepEqual((await readLog(fake.log)).filter((a) => a[0] === 'health').length, 0);

    // 授权后 health：命令失败（假 gateway 未运行）→ 如实 BRIDGE_COMMAND_FAILED
    process.env.FAKE_OC_FAIL_HEALTH = '1';
    const authHealth = { ...localDeliveryAuthorization(ws), allowedBridgeTools: ['openclaw.health'] };
    const failed = await registry.execute('call-4', 'openclaw.health', {}, { taskId: 't-b03', workspaceRoot: ws, authorization: authHealth });
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'BRIDGE_COMMAND_FAILED');
    delete process.env.FAKE_OC_FAIL_HEALTH;

    // 输出截断：40KB → 32KB 上限 + truncated 标记
    process.env.FAKE_OC_BIG = '1';
    const big = await registry.execute('call-5', 'openclaw.status', {}, ctx);
    assert.equal(big.ok, true);
    const bigContent = JSON.parse(big.content);
    assert.equal(bigContent.truncated, true);
    assert.ok(Buffer.byteLength(big.content, 'utf8') <= 96_000);
    delete process.env.FAKE_OC_BIG;

    // schema 广播过滤：未授权时桥接工具不出现在 provider 可见清单
    const namesAll = registry.listSchemas(['openclaw.status']).map((s) => s.name);
    assert.ok(namesAll.includes('openclaw.status'));
    assert.ok(!namesAll.includes('openclaw.health'));
    const namesDefault = registry.listSchemas().map((s) => s.name);
    assert.ok(!namesDefault.some((n) => n.startsWith('openclaw.')));
    assert.ok(namesDefault.includes('file.read'));
  } finally {
    delete process.env.FAKE_OC_LOG;
    await cleanupTestRoot(root);
  }
});

// ── B04：桥接工具进 AgentLoop —— 成功闭环 ─────────────────────────

test('B04 显式授权桥接工具的任务：fake 模型调用 openclaw.status，结果同 ID 回灌，任务成功', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m09b-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  try {
    const fake = await makeFakeOpenClaw(root);
    process.env.FAKE_OC_LOG = fake.log;
    const bridge = new OpenClawBridge({ command: fake.command });
    assert.equal((await bridge.status()).state, 'available');
    const fixture = join(root, 'fixture.json');
    await writeFile(
      fixture,
      JSON.stringify({
        steps: [
          { toolCalls: [{ id: 'call-1', name: 'openclaw.status', arguments: {} }] },
          { expectToolResults: ['call-1'], text: 'OpenClaw 状态已读（桥接），如实汇报。' },
        ],
      }),
      'utf8',
    );
    const service = new TaskService(store, 'm09b-test');
    service.createTask({
      id: 'task-b04',
      input: { goal: '查看 OpenClaw 状态', bridgeTools: ['openclaw.status'] },
      sessionId: 's-m09b',
      scope: 'skf-test',
      workspaceRoot: ws,
      provider: 'fake',
      model: 'fake-scripted',
    });
    const registry = new ToolRegistry(bridge.specs());
    const result = await runAgentLoop(
      {
        service,
        provider: new FakeScriptedProvider({ fixturePath: fixture, enabled: true }),
        tools: registry,
        authorization: { ...localDeliveryAuthorization(ws), allowedBridgeTools: bridgeToolsOfInput(service.getTask('task-b04').input) },
      },
      'task-b04',
    );
    assert.equal(result.state, 'succeeded');
    // 操作账本：bridge 工具成功，结果含假桥标记
    const op = store.db.prepare("SELECT * FROM operations WHERE taskId = 'task-b04'").get();
    assert.equal(op.toolName, 'openclaw.status');
    assert.equal(op.state, 'succeeded');
    assert.match(op.result, /FAKE-STATUS-MARK/);
    // 事件 + tool message 同 ID 回灌恰一次
    const toolEvents = service.listEvents(0, 100).filter((e) => e.taskId === 'task-b04' && e.type === 'task.tool');
    assert.equal(toolEvents.length, 1);
    assert.equal(toolEvents[0].safePayload.ok, true);
    const toolMsgs = service.listMessages('task-b04').filter((m) => m.role === 'tool' && m.toolCallId === 'call-1');
    assert.equal(toolMsgs.length, 1);
    // 审计：fake CLI 恰好被调一次 status（无重试/无风暴）
    assert.deepEqual((await readLog(fake.log)).filter((a) => a[0] === 'status').length, 1);
  } finally {
    delete process.env.FAKE_OC_LOG;
    store.close();
    await cleanupTestRoot(root);
  }
});

// ── B05：桥不可用 —— 显式桥接任务如实失败，不假装完成 ───────────────

test('B05 桥不可用：显式桥接任务的操作如实记 TOOL_UNAVAILABLE；未点名授权 POLICY_DENIED；绝不模拟成功', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-m09b-'));
  const ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  try {
    const bridge = new OpenClawBridge({ command: 'definitely-not-exists-openclaw-m09' });
    const fixture = join(root, 'fixture.json');
    await writeFile(
      fixture,
      JSON.stringify({
        steps: [
          { toolCalls: [{ id: 'call-1', name: 'openclaw.status', arguments: {} }] },
          { expectToolResults: ['call-1'], text: '桥接不可用，无法查看 OpenClaw 状态，如实汇报。' },
        ],
      }),
      'utf8',
    );
    const service = new TaskService(store, 'm09b-test');
    service.createTask({
      id: 'task-b05',
      input: { goal: '查看 OpenClaw 状态', bridgeTools: ['openclaw.status'] },
      sessionId: 's-m09b',
      scope: 'skf-test',
      workspaceRoot: ws,
      provider: 'fake',
      model: 'fake-scripted',
    });
    const registry = new ToolRegistry(bridge.specs());
    const result = await runAgentLoop(
      {
        service,
        provider: new FakeScriptedProvider({ fixturePath: fixture, enabled: true }),
        tools: registry,
        authorization: { ...localDeliveryAuthorization(ws), allowedBridgeTools: ['openclaw.status'] },
      },
      'task-b05',
    );
    // 任务级：模型如实汇报后收尾；系统级：工具操作必须如实失败（不是假成功）
    assert.equal(result.state, 'succeeded');
    const op = store.db.prepare("SELECT * FROM operations WHERE taskId = 'task-b05'").get();
    assert.equal(op.state, 'failed');
    assert.match(op.result, /TOOL_UNAVAILABLE/);
    const toolEvent = service.listEvents(0, 100).find((e) => e.taskId === 'task-b05' && e.type === 'task.tool');
    assert.equal(toolEvent.safePayload.ok, false);
    assert.equal(toolEvent.safePayload.code, 'TOOL_UNAVAILABLE');
    // 未授权变体：授权表不含桥接工具 → POLICY_DENIED，bridge 零调用
    const registry2 = new ToolRegistry(bridge.specs());
    const denied = await registry2.execute('call-9', 'openclaw.status', {}, {
      taskId: 'task-b05',
      workspaceRoot: ws,
      authorization: localDeliveryAuthorization(ws),
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'POLICY_DENIED');
    assert.equal(bridge.probeCount <= 2, true); // 负缓存内至多一次真实探测
  } finally {
    store.close();
    await cleanupTestRoot(root);
  }
});
