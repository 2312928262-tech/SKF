import fs from 'node:fs';
import path from 'node:path';

// A successful incremental tsc run does not remove JS for deleted TypeScript sources.
// Read-only packaging gate: never ship abandoned implementations from an older build.
export function orphanCompiledOutputs(root, outputDir = path.join(root, 'dist')) {
  const stale = [];
  const walk = dir => {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('COMPILED_OUTPUT_LINK_FORBIDDEN');
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error('COMPILED_OUTPUT_LINK_FORBIDDEN');
      if (item.isDirectory()) walk(full);
      else if (item.name.endsWith('.js')) {
        const relative = path.relative(outputDir, full);
        const source = path.join(root, 'src', relative.replace(/\.js$/, '.ts'));
        if (!fs.existsSync(source)) stale.push(relative.replace(/\\/g, '/'));
      }
    }
  };
  if (fs.existsSync(outputDir)) walk(outputDir);
  return stale.sort();
}
export function assertCurrentCompiledOutput(root, outputDir) {
  if (orphanCompiledOutputs(root, outputDir).length) throw new Error('STALE_COMPILED_OUTPUT');
}
