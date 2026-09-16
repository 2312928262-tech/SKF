/**
 * Pre-prompts 加载器
 * 三个文件：IDENTITY / MEMORY / TOOLS
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, '..', '..', 'templates', 'prompts');
const PROMPTS_DIR = process.env.SKF_MANAGED_INSTANCE === '1' && existsSync(TEMPLATE_DIR)
  ? TEMPLATE_DIR : join(__dirname, '..', '..', 'prompts');

export interface Prompts {
  IDENTITY: string;
  MEMORY: string;
  TOOLS: string;
}

export async function loadPrompts(): Promise<Prompts> {
  return {
    IDENTITY: await readIfExists(join(PROMPTS_DIR, 'IDENTITY.md')),
    MEMORY: await readIfExists(join(PROMPTS_DIR, 'MEMORY.md')),
    TOOLS: await readIfExists(join(PROMPTS_DIR, 'TOOLS.md')),
  };
}

async function readIfExists(path: string): Promise<string> {
  if (!existsSync(path)) return '';
  return readFile(path, 'utf8');
}
