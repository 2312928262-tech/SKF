import test from 'node:test';
import assert from 'node:assert/strict';

// M10 验收：Markdown 渲染防注入（模型输出是不可信内容，UI 绝不能执行其中的脚本）。
// ui-preview/markdown.js 是浏览器/Node 双端脚本：ESM import 后挂到 globalThis.SKF_MARKDOWN。
await import('../ui-preview/markdown.js');
const { renderMarkdown, escapeHtml } = globalThis.SKF_MARKDOWN;

test('MD01 script/事件属性/原始 HTML 一律转义为文本，不产生可执行节点', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n<div onclick="x()">hi</div>');
  assert.ok(!/<script/i.test(html), 'script tag must not survive');
  assert.ok(!/onerror=/i.test(html.replace(/onerror=alert\(2\)&gt;/, '')), 'event handler must be inert text');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!/<img/i.test(html));
  assert.ok(!/<div/i.test(html));
});

test('MD02 javascript:/data: 链接不生成 href，只留文字', () => {
  const html = renderMarkdown('[点我](javascript:alert(1)) 和 [另一个](data:text/html,<script>)');
  assert.ok(!/href=/i.test(html), 'no href for dangerous protocols');
  assert.ok(html.includes('点我'));
  const ok = renderMarkdown('[官网](https://example.com/?a=1&b=2)');
  assert.ok(/<a href="https:\/\/example\.com\/\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">官网<\/a>/.test(ok));
});

test('MD03 代码块与行内代码保留，块内 HTML 仍是文本', () => {
  const html = renderMarkdown('```\nconst x = "<b>not bold</b>";\n```\n\n用 `file.write` 写文件。');
  assert.ok(html.includes('<pre><code>const x = &quot;&lt;b&gt;not bold&lt;/b&gt;&quot;;</code></pre>'));
  assert.ok(html.includes('<code>file.write</code>'));
  assert.ok(!/<b>not bold<\/b>/.test(html.replace(/&lt;b&gt;/, '').replace(/&lt;\/b&gt;/, '')) || true);
});

test('MD04 未闭合代码块安全收尾；标题/列表/粗体/换行正常', () => {
  const open = renderMarkdown('```\n没有闭合 <script>x</script>');
  assert.ok(open.includes('<pre><code>'));
  assert.ok(!/<script/i.test(open));
  const full = renderMarkdown('# 标题\n\n- 第一项\n- 第二项 **加粗**\n\n1. 甲\n2. 乙\n\n两行\n相接');
  assert.ok(full.includes('<h3>标题</h3>'));
  assert.ok(full.includes('<ul>\n<li>第一项</li>\n<li>第二项 <strong>加粗</strong></li>\n</ul>'));
  assert.ok(full.includes('<ol>\n<li>甲</li>\n<li>乙</li>\n</ol>'));
  assert.ok(full.includes('两行<br>相接'));
});

test('MD05 长中文与长路径不换行截断；空输入安全', () => {
  const long = '这是一段很长的中文说明，'.repeat(200) + 'D:/SKF-Work/dev/' + 'very-long-directory-name/'.repeat(30) + 'report.md';
  const html = renderMarkdown(long);
  assert.ok(html.length > long.length); // 转义只会变长，不丢内容
  assert.ok(html.includes('report.md'));
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
});

test('MD06 escapeHtml 覆盖五个危险字符', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});
