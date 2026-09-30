// Bundles the extension into dist/ (load this folder unpacked in Chrome).
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

const common = { bundle: true, target: 'chrome110', logLevel: 'info', loader: { '.css': 'text' }, legalComments: 'none' };
const jobs = [
  { entryPoints: { 'service-worker': 'src/background/service-worker.js' }, format: 'esm' },
  { entryPoints: { content: 'src/content/index.js' }, format: 'iife' }, // classic script for executeScript
  { entryPoints: { options: 'src/options/options.js', popup: 'src/popup/popup.js' }, format: 'iife' },
].map((j) => ({ ...common, ...j, outdir: 'dist' }));

for (const j of jobs) {
  if (watch) await (await context(j)).watch();
  else await build(j);
}
copyFileSync('manifest.json', 'dist/manifest.json');
for (const f of ['options.html', 'options.css']) copyFileSync(`src/options/${f}`, `dist/${f}`);
for (const f of ['popup.html', 'popup.css']) copyFileSync(`src/popup/${f}`, `dist/${f}`);
cpSync('public/icons', 'dist/icons', { recursive: true });
console.log('Built extension -> dist/');
