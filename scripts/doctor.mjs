#!/usr/bin/env node
/**
 * SKF doctor — 只读诊断（M09 重写）。
 * 实现在 dist/runtime/doctor.js（先 npm run build）；支持 --json。
 * 只返回存在/缺失，绝不打印 secret 或环境全文。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'dist', 'runtime', 'doctor.js');

if (!existsSync(target)) {
  console.error('doctor: 未找到 dist/runtime/doctor.js，请先运行 npm run build。');
  process.exit(2);
}

const { main } = await import(pathToFileURL(target).href);
process.exit(await main(process.argv.slice(2)));
