/**
 * SKF 实时日志 tail
 * 跑：npm run log
 */
import { createReadStream, watch, existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const LOG_DIRS = [
  './src-tauri/target/release/logs',
  './logs',
  './.skf/logs',
];

function findLatestLog() {
  for (const dir of LOG_DIRS) {
    if (!existsSync(dir)) continue;
    const logs = readdirSync(dir)
      .filter(f => f.endsWith('.log'))
      .map(f => ({ f, path: join(dir, f), mtime: 0 }));
    if (logs.length === 0) continue;
    logs.sort((a, b) => b.f.localeCompare(a.f));
    return logs[0].path;
  }
  return null;
}

const logPath = findLatestLog();
if (!logPath) {
  console.log('❌ 没找到日志目录（先启动 SKF 一次）');
  process.exit(1);
}

console.log(`📋 tail -f ${logPath}`);
console.log('─'.repeat(60));

// 读整个文件
let pos = 0;
function tail() {
  const stream = createReadStream(logPath, { start: pos, encoding: 'utf8' });
  stream.on('data', (chunk) => {
    process.stdout.write(chunk);
    pos += Buffer.byteLength(chunk, 'utf8');
  });
  stream.on('end', () => {});
  stream.on('error', () => {});
}

tail();

// watch 文件变化
let timer;
watch(logPath, () => {
  clearTimeout(timer);
  timer = setTimeout(tail, 100);
});

process.on('SIGINT', () => process.exit(0));
