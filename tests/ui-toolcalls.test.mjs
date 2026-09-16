import test from 'node:test';
import assert from 'node:assert/strict';

// M25-ui 前端组件单元测试：chat-toolcalls.js 纯渲染（工具调用行 + 审批卡）。
// 零网络零付费零后端；只断言 HTML 字符串结构、effect/status 映射与防注入转义。
// chat-toolcalls.js 是浏览器/Node 双端脚本：ESM import 后挂到 globalThis.SKF_TOOLCALLS。
await import('../ui-preview/chat-toolcalls.js');
const TC = globalThis.SKF_TOOLCALLS;

test('T01 effect 徽章映射：read/workspace_write/external_write/process 四色 class', () => {
  assert.equal(TC.effectOf('read').cls, 'fx-read');
  assert.equal(TC.effectOf('workspace_write').cls, 'fx-workspace');
  assert.equal(TC.effectOf('external_write').cls, 'fx-external');
  assert.equal(TC.effectOf('process').cls, 'fx-process');
  // 未知 effect 回退 read（只读最保守），不崩
  assert.equal(TC.effectOf('unknown').cls, 'fx-read');
});

test('T02 状态映射：ok/failed/approval_pending/running 文案', () => {
  assert.equal(TC.statusOf('ok').label, '成功');
  assert.equal(TC.statusOf('failed').label, '失败');
  assert.equal(TC.statusOf('approval_pending').label, '待审批');
  assert.equal(TC.statusOf('running').label, '执行中');
});

test('T03 工具调用行：工具名 + effect 徽章 + 成功状态 + 摘要', () => {
  const html = TC.toolCallRowHtml({ tool: 'file.read', effect: 'read', status: 'ok', summary: 'D:\\a\\note.md' });
  assert.ok(html.includes('file.read'), '包含工具名');
  assert.ok(html.includes('fx-read'), '包含 effect class');
  assert.ok(html.includes('成功'), '包含成功状态');
  assert.ok(html.includes('D:\\a\\note.md'), '包含摘要');
  assert.ok(!html.includes('tc-toggle'), '短摘要不折叠');
});

test('T04 失败工具：失败状态 + 可展开错误码', () => {
  const html = TC.toolCallRowHtml({ tool: 'clipboard.write', effect: 'external_write', status: 'failed', summary: 'clipboard.write', code: 'APPROVAL_EXPIRED' });
  assert.ok(html.includes('fx-external'), 'effect class');
  assert.ok(html.includes('失败'), '失败状态');
  assert.ok(html.includes('APPROVAL_EXPIRED'), '错误码');
  assert.ok(html.includes('tc-toggle'), '失败附错误码时提供展开');
  assert.ok(html.includes('tc-code'), '错误码 code 容器');
});

test('T05 长摘要折叠展开（>100 字符折叠，详情含全文）', () => {
  const long = 'D:\\' + 'x'.repeat(140) + '\\file.md';
  const html = TC.toolCallRowHtml({ tool: 'file.write', effect: 'workspace_write', status: 'ok', summary: long });
  assert.ok(html.includes('fx-workspace'), 'effect class');
  assert.ok(html.includes('tc-toggle'), '长摘要折叠');
  assert.ok(html.includes('tc-summary-full'), '详情含全文');
  assert.ok(html.includes('…'), '短视图截断');
  assert.ok(html.includes(long), '全文进入详情');
});

test('T06 审批卡：hash 全值 + 复制按钮 + 批准/暂不批准', () => {
  const pa = { approvalId: 'appr:x:1', inputHash: 'abc123def456', tool: 'desktop.launch', effect: 'process', summary: 'desktop.launch' };
  const html = TC.approvalCardHtml(pa, { sessionName: 'A', taskId: 'task-1' });
  assert.ok(html.includes('abc123def456'), 'hash 全值');
  assert.ok(html.includes('aci-copy'), '复制按钮');
  assert.ok(html.includes('批准本次操作'), '批准按钮');
  assert.ok(html.includes('暂不批准'), '暂不批准按钮');
  assert.ok(html.includes('fx-process'), 'effect class');
  assert.ok(html.includes('desktop.launch'), '工具名');
  assert.ok(html.includes('task-1'), '任务 ID');
});

test('T07 防注入：工具名/摘要/hash 均被 HTML 实体转义', () => {
  const evil = '<script>alert(1)</script>';
  const html = TC.toolCallRowHtml({ tool: evil, effect: 'read', status: 'ok', summary: evil });
  assert.ok(!html.includes('<script>'), 'script 标签不进入输出');
  assert.ok(html.includes('&lt;script&gt;'), '转义为实体');
  const card = TC.approvalCardHtml({ approvalId: 'x', inputHash: evil, tool: evil, effect: 'read', summary: evil });
  assert.ok(!card.includes('<script>'), '审批卡 script 不进入输出');
});

test('T08 工具调用块：空数组返回空串，多条按序拼接', () => {
  assert.equal(TC.toolCallsBlockHtml([]), '');
  assert.equal(TC.toolCallsBlockHtml(null), '');
  const html = TC.toolCallsBlockHtml([
    { tool: 'file.read', effect: 'read', status: 'ok', summary: 'a' },
    { tool: 'web.search', effect: 'read', status: 'failed', summary: 'b', code: 'TIMEOUT' },
  ]);
  assert.ok(html.includes('toolblock'), '块容器');
  assert.ok(html.indexOf('file.read') < html.indexOf('web.search'), '顺序保持');
  assert.ok(html.includes('TIMEOUT'), '失败码进入块');
});
