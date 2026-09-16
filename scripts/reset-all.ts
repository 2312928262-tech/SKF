/**
 * 清空所有用户数据（L2 工作记忆 + L3 事实）
 * 保留 L1 核心锚点
 *
 * 用法：npm run reset-all
 */

import { writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

async function clearDir(dir: string, label: string): Promise<number> {
  if (!existsSync(dir)) {
    console.log(`  ⊘ ${label} · 目录不存在，跳过`);
    return 0;
  }

  const files = await readdir(dir);
  let count = 0;
  for (const f of files) {
    const path = join(dir, f);
    await writeFile(path, '', 'utf8');
    count++;
  }
  console.log(`  ✓ ${label} · 清空 ${count} 个文件`);
  return count;
}

async function main() {
  console.log('🧹 清空所有用户数据（保留 L1 核心锚点）');
  console.log();

  await clearDir('./memory/02-work', 'L2 工作记忆');
  await clearDir('./memory/03-facts', 'L3 事实层');
  await clearDir('./memory/04-graph', 'L4 时序图谱');
  await clearDir('./memory/05-archive', 'L5 衰减归档');

  console.log();
  console.log('✅ 已清空。L1 核心锚点保留。');
  console.log();
  console.log('⚠️  下次 supervisor 启动时，所有记忆都从空开始。');
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
