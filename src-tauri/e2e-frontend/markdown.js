'use strict';

/**
 * M10 · 极简 Markdown 渲染（防注入）。
 *
 * 安全模型：先对全部输入做 HTML 实体转义，再在转义后的文本上套用
 * 受支持的格式（代码块/行内代码/粗体/链接/列表/标题）。任何原始 HTML、
 * script、事件属性、javascript: 链接都不可能进入输出——它们已被转义成文本。
 * 链接只允许 http:// 与 https://；其余协议一律按纯文本显示。
 *
 * 浏览器与 Node（单元测试）双端可用：window.SKF_MARKDOWN / module.exports。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SKF_MARKDOWN = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null, function () {
  // 行内代码占位哨兵（控制字符不经字面量写入源码；配对出现才还原，普通文本不碰撞）。
  const SENT_OPEN = String.fromCharCode(1);
  const SENT_CLOSE = String.fromCharCode(2);

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 渲染行内元素：行内代码、粗体、安全链接。输入必须已转义。 */
  function renderInline(escaped) {
    const codeSpans = [];
    let text = escaped.replace(/`([^`\n]+)`/g, (_m, code) => {
      codeSpans.push(code);
      return SENT_OPEN + (codeSpans.length - 1) + SENT_CLOSE;
    });
    // 粗体：**text**
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    // 链接：[text](https://...) —— 只允许 http/https；其余协议按文本。
    text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      // url 此时是转义后的形式；&amp; 还原只为协议判断，不回写未转义内容。
      const probe = url.replace(/&amp;/g, '&');
      if (!/^https?:\/\//i.test(probe)) return label;
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    // 还原行内代码（哨兵内只认数字，原文本不会含此配对）
    const restore = new RegExp(SENT_OPEN + '(\\d+)' + SENT_CLOSE, 'g');
    text = text.replace(restore, (_m, i) => '<code>' + codeSpans[Number(i)] + '</code>');
    return text;
  }

  /**
   * Markdown → 安全 HTML。支持：```代码块```、#..### 标题、-/* 与 1. 列表、
   * **粗体**、`行内代码`、http(s) 链接、段落与换行。其余一律原样文本。
   */
  function renderMarkdown(source) {
    const escaped = escapeHtml(String(source ?? ''));
    const lines = escaped.split(/\r?\n/);
    const out = [];
    let paragraph = [];
    let list = null; // 'ul' | 'ol'
    let code = null; // 累积代码块行

    const flushParagraph = () => {
      if (paragraph.length) {
        out.push('<p>' + paragraph.map(renderInline).join('<br>') + '</p>');
        paragraph = [];
      }
    };
    const flushList = () => {
      if (list) {
        out.push('</' + list + '>');
        list = null;
      }
    };

    for (const line of lines) {
      if (code !== null) {
        if (/^```/.test(line)) {
          out.push('<pre><code>' + code.join('\n') + '</code></pre>');
          code = null;
        } else {
          code.push(line);
        }
        continue;
      }
      if (/^```/.test(line)) {
        flushParagraph();
        flushList();
        code = [];
        continue;
      }
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) {
        flushParagraph();
        flushList();
        const level = heading[1].length + 2; // h3..h5，不抢页面主标题
        out.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
        continue;
      }
      const ul = /^[-*]\s+(.+)$/.exec(line);
      const ol = /^\d+[.)]\s+(.+)$/.exec(line);
      if (ul || ol) {
        flushParagraph();
        const want = ul ? 'ul' : 'ol';
        if (list !== want) {
          flushList();
          out.push('<' + want + '>');
          list = want;
        }
        out.push('<li>' + renderInline((ul || ol)[1]) + '</li>');
        continue;
      }
      flushList();
      if (line.trim() === '') {
        flushParagraph();
      } else {
        paragraph.push(line);
      }
    }
    if (code !== null) out.push('<pre><code>' + code.join('\n') + '</code></pre>'); // 未闭合代码块也按代码收尾
    flushParagraph();
    flushList();
    return out.join('\n');
  }

  return { escapeHtml, renderMarkdown };
});
