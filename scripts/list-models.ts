/**
 * 列出 OpenRouter 上所有模型，重点找最强的
 */
import OpenAI from 'openai';
import { readFileSync } from 'node:fs';

const content = readFileSync('.env', 'utf8');
const match = content.match(/OPENROUTER_API_KEY=(.+)/);
const key = match?.[1].trim() || '';

const client = new OpenAI({
  apiKey: key,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: { 'X-Title': 'SKF' },
});

const models = await client.models.list();
const all: any[] = models.data;

console.log(`总模型数: ${all.length}`);
console.log();

// 1. OpenAI 系列
console.log('══════ OpenAI 系列 ══════');
const openaiModels = all.filter((m: any) => m.id.toLowerCase().startsWith('openai/'));
for (const m of openaiModels.slice(0, 20)) {
  const price = m.pricing ? `$${(parseFloat(m.pricing.prompt || '0') * 1e6).toFixed(3)} in` : '?';
  console.log(`  ${m.id.padEnd(45)} ${price}`);
}

console.log();
console.log('══════ Google 系列 ══════');
const googleModels = all.filter((m: any) => m.id.toLowerCase().startsWith('google/'));
for (const m of googleModels.slice(0, 15)) {
  const price = m.pricing ? `$${(parseFloat(m.pricing.prompt || '0') * 1e6).toFixed(3)} in` : '?';
  console.log(`  ${m.id.padEnd(45)} ${price}`);
}

console.log();
console.log('══════ Mistral 系列 ══════');
const mistralModels = all.filter((m: any) => m.id.toLowerCase().startsWith('mistralai/'));
for (const m of mistralModels.slice(0, 10)) {
  const price = m.pricing ? `$${(parseFloat(m.pricing.prompt || '0') * 1e6).toFixed(3)} in` : '?';
  console.log(`  ${m.id.padEnd(45)} ${price}`);
}

console.log();
console.log('══════ Meta Llama 系列 ══════');
const metaModels = all.filter((m: any) => m.id.toLowerCase().startsWith('meta-llama/'));
for (const m of metaModels.slice(0, 10)) {
  const price = m.pricing ? `$${(parseFloat(m.pricing.prompt || '0') * 1e6).toFixed(3)} in` : '?';
  console.log(`  ${m.id.padEnd(45)} ${price}`);
}

console.log();
console.log('══════ Anthropic 系列（地区限制） ══════');
const anthropicModels = all.filter((m: any) => m.id.toLowerCase().startsWith('anthropic/'));
for (const m of anthropicModels.slice(0, 10)) {
  console.log(`  ${m.id}`);
}
