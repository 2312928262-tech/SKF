/**
 * 验证 OpenRouter key 是否能联通
 * 跑：npm run verify
 */

import OpenAI from 'openai';
import { readFileSync, existsSync } from 'node:fs';

function mask(s: string, n = 6) {
  if (s.length <= n * 2) return s[0] + '***' + s.slice(-2);
  return s.slice(0, n) + '***' + s.slice(-4);
}

const envPath = '.env';
if (!existsSync(envPath)) {
  console.log('❌ .env 文件不存在');
  process.exit(1);
}

const content = readFileSync(envPath, 'utf8');
const match = content.match(/OPENROUTER_API_KEY=(.+)/);
if (!match) {
  console.log('❌ .env 里没找到 OPENROUTER_API_KEY');
  process.exit(1);
}

const key = match[1].trim();
if (key === 'your-key-here' || !key.startsWith('sk-or-')) {
  console.log('❌ key 还是占位符或格式不对（应该以 sk-or- 开头）');
  process.exit(1);
}

console.log('✅ key 已填：', mask(key));
console.log('   长度：', key.length);

const client = new OpenAI({
  apiKey: key,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': 'https://SKF.local',
    'X-Title': 'SKF',
  },
});

try {
  console.log('🔌 测试 OpenRouter 连接...');
  const models = await client.models.list();
  console.log('✅ 连接成功！可用模型总数：', models.data.length);
  console.log('   前 8 个：');
  for (const m of models.data.slice(0, 8)) {
    console.log('   -', m.id);
  }
  console.log();
  console.log('🎉 一切就绪，可以跑：npm start');
} catch (e: any) {
  console.log('❌ 连接失败：', e?.message || String(e));
  if (e?.status) console.log('   HTTP status:', e.status);
  if (e?.cause) console.log('   cause:', JSON.stringify(e.cause, null, 2));
  if (e?.error) console.log('   error:', JSON.stringify(e.error, null, 2));
  console.log('   full:', JSON.stringify(e, Object.getOwnPropertyNames(e), 2));
  process.exit(1);
}
