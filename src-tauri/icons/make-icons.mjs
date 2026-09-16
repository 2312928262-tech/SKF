// 生成 SKF 图标（鱼 SVG → PNG → ICO）
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const ICONS_DIR = process.argv[2] || './src-tauri/icons';
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7C3AED"/>
      <stop offset="50%" stop-color="#A78BFA"/>
      <stop offset="100%" stop-color="#C4B5FD"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="100" fill="#FAFAFC"/>
  <g transform="translate(60, 130) scale(16)">
    <path d="M3 12 Q10 5, 17 9 L21 6 L19 12 L21 18 L17 15 Q10 19, 3 12 Z" fill="url(#g)"/>
    <circle cx="16" cy="11" r="0.9" fill="#7C3AED"/>
  </g>
</svg>`;

const svgPath = join(ICONS_DIR, 'icon.svg');
writeFileSync(svgPath, ICON_SVG, 'utf8');
console.log('✓ 写入 SVG:', svgPath);

// 用 node-canvas 或 sharp 生成 PNG（这里用 sharp）
let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.log('❌ 缺 sharp 包，尝试用 node 内置方案...');
  // 备选：直接用 node + 简单 SVG 转换（仅供测试）
  process.exit(1);
}

const sizes = [
  { name: '32x32.png', w: 32, h: 32 },
  { name: '128x128.png', w: 128, h: 128 },
  { name: '128x128@2x.png', w: 256, h: 256 },
  { name: 'icon.png', w: 512, h: 512 },
];

for (const { name, w, h } of sizes) {
  const out = join(ICONS_DIR, name);
  await sharp(Buffer.from(ICON_SVG))
    .resize(w, h)
    .png()
    .toFile(out);
  console.log(`✓ 生成 ${name} (${w}x${h})`);
}

// 生成 ICO（Windows 必需）
const icoSizes = [16, 32, 48, 64, 128, 256];
const icoBuffers = await Promise.all(
  icoSizes.map((s) =>
    sharp(Buffer.from(ICON_SVG))
      .resize(s, s)
      .png()
      .toBuffer()
  )
);

// 写 ICO 格式
const ico = await sharp(Buffer.from(ICON_SVG))
  .resize(256, 256)
  .toFormat('ico', { sizes: icoSizes })
  .toBuffer();
writeFileSync(join(ICONS_DIR, 'icon.ico'), ico);
console.log('✓ 生成 icon.ico');

console.log('\n✅ 所有图标就绪');
