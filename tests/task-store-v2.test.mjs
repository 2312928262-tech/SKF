import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { RuntimeStore } from '../dist/runtime/runtime-store.js';
import { TaskService } from '../dist/runtime/task-service.js';
import { inputHashOf, stableStringify } from '../dist/runtime/contracts.js';

// M03 验收：幂等创建 / CAS 状态机 / lease+fencing / 崩溃标识 / 事务原子性 / 旧格式隔离导入。
// 全部在本机临时目录 + node:sqlite，无任何网络或付费调用。

async function cleanupTestRoot(root) {
  const absolute = resolve(root);
  const base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + (process.platform === 'win32' ? '\\' : '/')));
  assert.match(absolute.slice(base.length + 1), /^skf-v2-[a-zA-Z0-9]+$/);
  await rm(absolute, { recursive: true, force: true });
}

function openService(root, instanceId) {
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  return { store, service: new TaskService(store, instanceId) };
}

function makeTask(service, id, message = 'hello ' + id) {
  return service.createTask({
    id,
    input: { message },
    sessionId: 'test-session',
    scope: 'skf-test',
    workspaceRoot: 'D:/SKF-Work/temp/ws',
    provider: 'fake',
    model: 'fake-scripted-1',
  });
}

test('db init: WAL/FULL/migration_versions；过新版本拒绝；事务失败不留半个事件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-v2-'));
  const { store, service } = openService(root, 'init-1');
  try {
    const journal = store.db.prepare('PRAGMA journal_mode').get();
    assert.equal(String(journal.journal_mode).toLowerCase(), 'wal');
    const sync = store.db.prepare('PRAGMA synchronous').get();
    assert.equal(Number(sync.synchronous), 2, 'synchronous=FULL(2)');
    const version = store.db.prepare('SELECT MAX(version) AS v FROM migration_versions').get();
    assert.equal(version.v, 7, 'M02-fix migration v7: messages.reasoningContent (current latest)');
    // 重复打开幂等，不重复迁移
    const again = new RuntimeStore(join(root, 'runtime.sqlite'));
    assert.equal(again.db.prepare('SELECT COUNT(*) AS c FROM migration_versions').get().c, 7);
    // v2 列存在
    const cols = again.db.prepare('PRAGMA table_info(model_calls)').all().map((c) => c.name);
    assert.ok(cols.includes('currency') && cols.includes('tariff'), 'model_calls must have currency/tariff columns');
    // v4/v5 表存在
    const tables = again.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    for (const t of ['learning_reviews', 'learning_experiences', 'learning_task_checkpoints', 'learning_applications', 'learning_review_quota', 'learning_failure_signatures', 'execution_plans', 'sessions']) {
      assert.ok(tables.includes(t), `missing ${t}`);
    }
    again.close();

    // 事务中故障：事件不能留下半个
    makeTask(service, 'tx-task');
    const before = service.listEvents(0).length;
    assert.throws(
      () =>
        store.transaction(() => {
          store.db.prepare("INSERT INTO events (taskId, type, safePayload, at) VALUES ('tx-task', 'task.note', '{}', 'now')").run();
          throw new Error('simulated mid-transaction failure');
        }),
      /simulated mid-transaction failure/,
    );
    assert.equal(service.listEvents(0).length, before, 'rolled-back event must not persist');
  } finally {
    store.close();
  }
  // 更高版本 schema：旧二进制拒绝写入
  const { store: store2 } = openService(root, 'init-2');
  store2.db.prepare('INSERT INTO migration_versions (version, appliedAt) VALUES (999, ?)').run(new Date().toISOString());
  store2.close();
  assert.throws(() => new RuntimeStore(join(root, 'runtime.sqlite')), /DB_SCHEMA_TOO_NEW/);
  await cleanupTestRoot(root).catch(() => {});
});

test('createTask 幂等：同 ID 同输入返回原状态；改输入 REQUEST_ID_CONFLICT；provider 快照固定', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-v2-'));
  const { store, service } = openService(root, 'idem-1');
  try {
    const first = makeTask(service, 'task-a', 'write report');
    assert.equal(first.state, 'queued');
    assert.equal(first.revision, 0);
    const replay = makeTask(service, 'task-a', 'write report');
    assert.deepEqual(replay, first, 'same id + same input returns original record untouched');
    assert.equal(service.listTasks().length, 1);
    assert.throws(() => makeTask(service, 'task-a', 'changed input'), /REQUEST_ID_CONFLICT/);
    assert.equal(service.listTasks().length, 1);

    // 任务级 provider 快照：之后的任务换 provider 不影响在途任务
    service.createTask({
      id: 'task-b', input: { message: 'other' }, sessionId: 's', scope: 'skf-test',
      workspaceRoot: 'D:/SKF-Work/temp/ws', provider: 'other-provider', model: 'other-model',
    });
    const snapshot = service.getTask('task-a');
    assert.equal(snapshot.provider, 'fake');
    assert.equal(snapshot.model, 'fake-scripted-1');
    assert.equal(snapshot.inputHash, inputHashOf({ message: 'write report' }));
  } finally {
    store.close();
    await cleanupTestRoot(root);
  }
});

test('封闭状态机：合法路径通行；非法跳转与终态回退被拒绝；CAS revision 冲突检测', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-v2-'));
  const { store, service } = openService(root, 'sm-1');
  try {
    makeTask(service, 'flow');
    // queued → running → waiting_provider → running → succeeded
    let task = service.transitionTask('flow', 'running');
    assert.equal(task.revision, 1);
    task = service.transitionTask('flow', 'waiting_provider', { expectedRevision: 1 });
    task = service.transitionTask('flow', 'running', { expectedRevision: 2 });
    task = service.transitionTask('flow', 'succeeded', { expectedRevision: 3 });
    assert.equal(task.state, 'succeeded');

    // 终态拒绝迟到回调（包括回到 running / 同态重写）
    assert.throws(() => service.transitionTask('flow', 'running'), /TASK_TERMINAL/);
    assert.throws(() => service.transitionTask('flow', 'succeeded'), /TASK_TERMINAL/);

    // 非法跳转
    makeTask(service, 'bad-jump');
    assert.throws(() => service.transitionTask('bad-jump', 'succeeded'), /INVALID_TRANSITION/);
    assert.throws(() => service.transitionTask('bad-jump', 'waiting_approval'), /INVALID_TRANSITION/);

    // CAS：revision 过期
    const current = service.getTask('bad-jump');
    assert.throws(() => service.transitionTask('bad-jump', 'running', { expectedRevision: current.revision + 5 }), /CONCURRENT_MODIFICATION/);

    // 取消路径：非终态 → cancelling → cancelled
    service.transitionTask('bad-jump', 'cancelling');
    const cancelled = service.transitionTask('bad-jump', 'cancelled');
    assert.equal(cancelled.state, 'cancelled');
    assert.throws(() => service.transitionTask('bad-jump', 'queued'), /TASK_TERMINAL/);

    // interrupted → queued（用户继续）→ running
    makeTask(service, 'resume-me');
    service.transitionTask('resume-me', 'running');
    service.recover();
    assert.equal(service.getTask('resume-me').state, 'interrupted');
    service.transitionTask('resume-me', 'queued');
    assert.equal(service.getTask('resume-me').state, 'queued');

    assert.throws(() => service.transitionTask('missing', 'running'), /TASK_NOT_FOUND/);
  } finally {
    store.close();
    await cleanupTestRoot(root);
  }
});

test('lease 原子竞争 + fencing token：并发 claim 仅一个成功，旧 token 作废，第二实例可读不可执行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-v2-'));
  const a = openService(root, 'instance-A');
  const b = openService(root, 'instance-B');
  try {
    makeTask(a.service, 'contended');
    // B 只读可见
    assert.equal(b.service.getTask('contended').state, 'queued');

    const now = 1_000_000;
    const claimA = a.service.claimTask('contended', 60_000, now);
    assert.equal(claimA.fencingToken, 1);
    // 第二实例 claim 同一任务被拒绝（不是 UI 禁钮，是存储层拒绝）
    assert.throws(() => b.service.claimTask('contended', 60_000, now), /LEASE_HELD/);
    // A 续约 token 不变
    assert.equal(a.service.claimTask('contended', 60_000, now + 1000).fencingToken, 1);
    a.service.checkTaskFence('contended', claimA.fencingToken, now + 2000);

    // A 崩溃（lease 到期未续约）→ B 接管，token 递增，A 的旧 token 作废
    const claimB = b.service.claimTask('contended', 60_000, now + 61_001);
    assert.equal(claimB.fencingToken, 2);
    assert.throws(() => a.service.checkTaskFence('contended', claimA.fencingToken, now + 61_002), /FENCING_TOKEN_STALE/);
    b.service.checkTaskFence('contended', claimB.fencingToken, now + 61_002);

    // 到期后 lease 释放可被他人获取；释放不匹配的 token 不影响持有者
    a.service.releaseLease('task:contended', 1);
    b.service.checkTaskFence('contended', 2, now + 61_003);
  } finally {
    a.store.close();
    b.store.close();
    await cleanupTestRoot(root);
  }
});

test('崩溃重启：running/waiting_provider/cancelling → interrupted 不自动重试；waiting_approval 未过期保留、过期审批标 expired', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-v2-'));
  const { store, service } = openService(root, 'crash-1');
  try {
    makeTask(service, 'was-running');
    service.transitionTask('was-running', 'running');
    makeTask(service, 'was-waiting-provider');
    service.transitionTask('was-waiting-provider', 'running');
    service.transitionTask('was-waiting-provider', 'waiting_provider');
    makeTask(service, 'was-cancelling');
    service.transitionTask('was-cancelling', 'cancelling');
    makeTask(service, 'was-waiting-approval');
    service.transitionTask('was-waiting-approval', 'running');
    service.transitionTask('was-waiting-approval', 'waiting_approval');
    makeTask(service, 'was-done');
    service.transitionTask('was-done', 'running');
    service.transitionTask('was-done', 'succeeded');

    const futureTtl = 60_000;
    service.requestApproval({ id: 'ap-keep', taskId: 'was-waiting-approval', inputHash: 'h1', effect: 'workspace_write', ttlMs: futureTtl });
    makeTask(service, 'expired-approval-task');
    service.transitionTask('expired-approval-task', 'running');
    service.transitionTask('expired-approval-task', 'waiting_approval');
    service.requestApproval({ id: 'ap-expired', taskId: 'expired-approval-task', inputHash: 'h2', effect: 'external_write', ttlMs: 1, now: new Date(Date.now() - 10_000) });

    // 模拟重启：新实例（新 instanceId）打开同一库做恢复
    store.close();
    const restarted = openService(root, 'crash-2');
    try {
      const result = restarted.service.recover();
      assert.deepEqual(result.interrupted.sort(), ['was-cancelling', 'was-running', 'was-waiting-provider']);
      assert.deepEqual(result.expiredApprovals, ['ap-expired']);
      for (const id of result.interrupted) {
        const task = restarted.service.getTask(id);
        assert.equal(task.state, 'interrupted');
        assert.equal(task.errorCode, 'TASK_INTERRUPTED');
      }
      // waiting_approval 保留，未过期审批仍 pending
      assert.equal(restarted.service.getTask('was-waiting-approval').state, 'waiting_approval');
      assert.equal(restarted.service.getApproval('ap-keep').decision, 'pending');
      assert.equal(restarted.service.getApproval('ap-expired').decision, 'expired');
      // 终态不动；interrupted 不自动回到 queued（不自动付费重试）
      assert.equal(restarted.service.getTask('was-done').state, 'succeeded');
      assert.equal(restarted.service.listTasks().filter((t) => t.state === 'queued').length, 0);
      // 重启后任务可读（事件可断线补发）
      const events = restarted.service.listEvents(0);
      assert.ok(events.some((e) => e.type === 'task.state' && e.safePayload.to === 'interrupted'));
      assert.ok(events.every((e, i, arr) => i === 0 || arr[i - 1].eventSeq < e.eventSeq), 'events ordered by eventSeq');
    } finally {
      restarted.store.close();
    }
  } finally {
    await cleanupTestRoot(root);
  }
});

test('审批：参数 hash 绑定不得转移；过期不得通过；拒绝同事务使任务 failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-v2-'));
  const { store, service } = openService(root, 'ap-1');
  try {
    makeTask(service, 'approve-me');
    service.transitionTask('approve-me', 'running');
    service.transitionTask('approve-me', 'waiting_approval');
    service.requestApproval({ id: 'ap-1', taskId: 'approve-me', inputHash: 'hash-original', effect: 'external_write', ttlMs: 60_000 });

    // 改过的 args：hash 不匹配，批准不得转移
    assert.throws(() => service.decideApproval('ap-1', 'approved', { inputHash: 'hash-tampered' }), /APPROVAL_INPUT_CONFLICT/);
    assert.equal(service.getApproval('ap-1').decision, 'pending');

    // 正确 hash 批准 → 任务同事务回 running
    const decided = service.decideApproval('ap-1', 'approved', { inputHash: 'hash-original' });
    assert.equal(decided.taskState, 'running');
    assert.equal(service.getTask('approve-me').state, 'running');
    // 重复决定拒绝
    assert.throws(() => service.decideApproval('ap-1', 'approved', { inputHash: 'hash-original' }), /INVALID_TRANSITION/);

    // 拒绝路径 → failed(APPROVAL_REJECTED)
    makeTask(service, 'reject-me');
    service.transitionTask('reject-me', 'running');
    service.transitionTask('reject-me', 'waiting_approval');
    service.requestApproval({ id: 'ap-2', taskId: 'reject-me', inputHash: 'h', effect: 'process', ttlMs: 60_000 });
    const rejected = service.decideApproval('ap-2', 'rejected', { inputHash: 'h', reason: 'not authorized' });
    assert.equal(rejected.taskState, 'failed');
    assert.equal(service.getTask('reject-me').errorCode, 'APPROVAL_REJECTED');

    // 过期审批不得通过
    makeTask(service, 'expire-me');
    service.requestApproval({ id: 'ap-3', taskId: 'expire-me', inputHash: 'h', effect: 'read', ttlMs: 1000, now: new Date(Date.now() - 5000) });
    assert.throws(() => service.decideApproval('ap-3', 'approved', { inputHash: 'h' }), /APPROVAL_EXPIRED/);
    assert.equal(service.getApproval('ap-3').decision, 'expired');
  } finally {
    store.close();
    await cleanupTestRoot(root);
  }
});

test('消息/操作/产物/outbox/模型调用：持久 seq、callId 幂等、purpose 白名单、outbox 幂等键', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-v2-'));
  const { store, service } = openService(root, 'rec-1');
  try {
    makeTask(service, 'ledger');
    service.transitionTask('ledger', 'running');

    // messages：seq 递增，toolCalls 成组保留
    assert.equal(service.appendMessage('ledger', { role: 'user', content: 'hi' }).seq, 1);
    assert.equal(service.appendMessage('ledger', { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'file.write', arguments: { path: 'a.txt' } }] }).seq, 2);
    assert.equal(service.appendMessage('ledger', { role: 'tool', content: 'ok', toolCallId: 'c1', name: 'file.write' }).seq, 3);
    const messages = service.listMessages('ledger');
    assert.deepEqual(messages.map((m) => m.seq), [1, 2, 3]);
    assert.equal(messages[1].toolCalls[0].id, 'c1');
    assert.equal(messages[2].toolCallId, 'c1');

    // operations：同 callId 同输入幂等，改输入冲突；状态机封闭
    service.startStep({ id: 'step-1', taskId: 'ledger', stepIndex: 0, phase: 'tool', requestHash: 'rh' });
    service.createOperation({ id: 'op-1', taskId: 'ledger', stepId: 'step-1', callId: 'c1', toolName: 'file.write', input: { path: 'a.txt', content: 'x' } });
    service.createOperation({ id: 'op-1-replay', taskId: 'ledger', stepId: 'step-1', callId: 'c1', toolName: 'file.write', input: { path: 'a.txt', content: 'x' } });
    assert.throws(
      () => service.createOperation({ id: 'op-1-evil', taskId: 'ledger', callId: 'c1', toolName: 'file.write', input: { path: 'b.txt' } }),
      /REQUEST_ID_CONFLICT/,
    );
    service.transitionOperation('op-1', 'running');
    assert.throws(() => service.registerArtifact({ id: 'art-early', taskId: 'ledger', operationId: 'op-1', relativePath: 'a.txt', byteLength: 1, sha256: createHash('sha256').update('x').digest('hex') }), /OPERATION_NOT_SUCCEEDED/);
    service.transitionOperation('op-1', 'succeeded', { result: { ok: true } });
    assert.throws(() => service.transitionOperation('op-1', 'running'), /INVALID_TRANSITION/);
    const sha = createHash('sha256').update('x').digest('hex');
    service.registerArtifact({ id: 'art-1', taskId: 'ledger', operationId: 'op-1', relativePath: 'a.txt', byteLength: 1, sha256: sha });
    service.markArtifactVerified('art-1');
    assert.throws(() => service.registerArtifact({ id: 'art-abs', taskId: 'ledger', relativePath: 'D:/evil.txt', byteLength: 1, sha256: sha }), /INVALID_INPUT/);
    service.completeStep('step-1', 'succeeded', 'provider-call-9');

    // model_calls：purpose 白名单；usage 缺失保持 null；uncertain 不退款成 0
    service.recordModelCall({ id: 'mc-1', taskId: 'ledger', purpose: 'chat', provider: 'fake', model: 'fake-scripted-1', reservedCostMicros: 100, tariffVersion: 'v1' });
    assert.throws(() => service.recordModelCall({ id: 'mc-bad', taskId: 'ledger', purpose: 'evil', provider: 'fake', model: 'm' }), /INVALID_PURPOSE/);
    service.settleModelCall('mc-1', { state: 'uncertain' });
    const mc = store.db.prepare('SELECT * FROM model_calls WHERE id = ?').get('mc-1');
    assert.equal(mc.state, 'uncertain');
    assert.equal(mc.usage, null, 'usage missing stays null, not 0');
    assert.equal(mc.settledCostMicros, null, 'uncertain call must not be refunded to 0 without evidence');

    // outbox：幂等键；失败计数；完成
    service.enqueueOutbox({ id: 'ob-1', taskId: 'ledger', kind: 'memory.close', payload: { summary: 'done' } });
    service.enqueueOutbox({ id: 'ob-1', taskId: 'ledger', kind: 'memory.close', payload: { summary: 'done' } });
    assert.equal(service.pendingOutbox().length, 1);
    assert.throws(() => service.enqueueOutbox({ id: 'ob-1', taskId: 'ledger', kind: 'memory.close', payload: { summary: 'different' } }), /REQUEST_ID_CONFLICT/);
    service.markOutbox('ob-1', { state: 'failed', lastError: 'VAULT_UNAVAILABLE' });
    assert.equal(service.pendingOutbox()[0].attempts, 1);
    service.markOutbox('ob-1', { state: 'done' });
    assert.equal(service.pendingOutbox().length, 0);
  } finally {
    store.close();
    await cleanupTestRoot(root);
  }
});

test('旧 tasks/*.json 隔离导入演练：保留原 ID 与输入 hash，历史不当待执行任务，重复导入幂等', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skf-v2-'));
  const legacyDir = join(root, 'legacy-tasks');
  await mkdir(legacyDir, { recursive: true });
  const legacy = [
    { id: 'legacy-done', message: 'old question', provider: 'astra', startedAt: '2026-09-01T10:00:00.000Z', status: 'completed', response: { text: 'old answer' } },
    { id: 'legacy-failed', message: 'old failed', provider: 'astra', startedAt: '2026-09-01T11:00:00.000Z', status: 'failed', error: 'MODEL_REQUEST_FAILED' },
    { id: 'legacy-running', message: 'crash leftover', provider: 'kimi', startedAt: '2026-09-01T12:00:00.000Z', status: 'running' },
  ];
  for (const task of legacy) {
    const file = createHash('sha256').update(task.id).digest('hex') + '.json';
    await writeFile(join(legacyDir, file), JSON.stringify(task), 'utf8');
  }
  const { store, service } = openService(root, 'mig-1');
  try {
    const first = service.importLegacyChatTasks(legacyDir);
    assert.deepEqual(first.imported.sort(), ['legacy-done', 'legacy-failed', 'legacy-running']);
    assert.equal(first.skipped.length, 0);

    const done = service.getTask('legacy-done');
    assert.equal(done.state, 'succeeded', '历史完成 → succeeded，不是 queued');
    assert.equal(done.provider, 'astra');
    assert.equal(done.createdAt, '2026-09-01T10:00:00.000Z');
    assert.equal(done.inputHash, inputHashOf({ kind: 'legacy_chat_import', message: 'old question', provider: 'astra', startedAt: '2026-09-01T10:00:00.000Z' }));
    assert.equal(service.getTask('legacy-failed').state, 'failed');
    assert.equal(service.getTask('legacy-failed').errorCode, 'MODEL_REQUEST_FAILED');
    assert.equal(service.getTask('legacy-running').state, 'interrupted', '旧崩溃残留 → interrupted');
    // 导入的历史任务绝不进入可执行队列
    assert.equal(service.listTasks().filter((t) => t.state === 'queued' || t.state === 'running').length, 0);
    // 终态导入记录拒绝迟到更新
    assert.throws(() => service.transitionTask('legacy-done', 'running'), /TASK_TERMINAL/);

    // 重复导入幂等：同 ID 同输入全部跳过
    const second = service.importLegacyChatTasks(legacyDir);
    assert.equal(second.imported.length, 0);
    assert.deepEqual(second.skipped.sort(), ['legacy-done', 'legacy-failed', 'legacy-running']);
    assert.equal(service.listTasks().length, 3);

    // 事件留痕
    assert.ok(service.listEvents(0).some((e) => e.type === 'task.legacy_imported'));
  } finally {
    store.close();
    await cleanupTestRoot(root);
  }
});
