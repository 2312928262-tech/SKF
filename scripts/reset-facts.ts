/**
 * 清空 L3 事实库
 * 用法：npm run reset-facts
 */

import { writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const FACTS_DIR = './memory/03-facts';

async function main() {
  if (!existsSync(FACTS_DIR)) {
    console.log('❌ L3 目录不存在');
    return;
  }

  const files = await readdir(FACTS_DIR);
  for (const f of files) {
    if (f.endsWith('.jsonl') || f.endsWith('.json')) {
      const path = join(FACTS_DIR, f);
      await writeFile(path, '', 'utf8');
      console.log(`  ✓ 清空: ${f}`);
    }
  }

  console.log();
  console.log('✅ L3 事实库已清空');
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
