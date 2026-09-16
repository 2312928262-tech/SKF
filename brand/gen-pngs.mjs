// Generate 6 PNG sizes from avatar.svg + brand wordmark
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';

const sizes = [512, 256, 128, 64, 32, 16];
const svg = await readFile('./avatar.svg', 'utf8');

// 1. 大尺寸主 SVG（5 个尺寸）
for (const size of sizes.filter((s) => s > 16)) {
  const out = `xiaoliu-avatar-${size}.png`;
  await sharp(Buffer.from(svg), { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(out);
  console.log(`OK ${out}`);
}

// 2. 16px 用光学校正版
const svg16 = await readFile('./avatar-16.svg', 'utf8');
await sharp(Buffer.from(svg16), { density: 384 })
  .resize(16, 16, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile('xiaoliu-avatar-16.png');
console.log('OK xiaoliu-avatar-16.png');

// 3. SKF wordmark（Inter 600 模拟 - 实际生成 SVG）
const wordmark = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64" viewBox="0 0 240 64">
  <text x="0" y="44" font-family="Inter, system-ui, sans-serif" font-weight="600" font-size="40" fill="#9692C4">SKF</text>
</svg>`;
await writeFile('./skf-wordmark.svg', wordmark, 'utf8');
await sharp(Buffer.from(wordmark), { density: 192 })
  .resize(480, 128)
  .png()
  .toFile('skf-wordmark.png');
console.log('OK skf-wordmark.png');

console.log('\n=== Brand assets ready ===');
