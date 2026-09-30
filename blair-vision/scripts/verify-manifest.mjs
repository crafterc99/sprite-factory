// Sanity-checks dist/manifest.json: MV3 shape, every referenced file exists, no secrets bundled.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
const errors = [];
const m = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (m.manifest_version !== 3) errors.push('manifest_version must be 3');
for (const k of ['name', 'version', 'description']) if (!m[k]) errors.push(`missing ${k}`);
if (/<all_urls>|\*:\/\/\*\/\*/.test(JSON.stringify(m.host_permissions ?? []))) errors.push('host_permissions must not be <all_urls>');

const files = [m.background?.service_worker, m.action?.default_popup, m.options_page, ...Object.values(m.icons ?? {}), ...Object.values(m.action?.default_icon ?? {}), 'content.js', 'popup.js', 'options.js'];
for (const f of files.filter(Boolean)) if (!existsSync(join(dist, f))) errors.push(`missing file: ${f}`);

// Never ship keys.
const secret = /(sk-or-v1-[A-Za-z0-9]{16,}|jbc_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{32,})/;
for (const f of readdirSync(dist)) {
  if (/\.(js|html|json|css)$/.test(f) && secret.test(readFileSync(join(dist, f), 'utf8'))) errors.push(`possible API key in dist/${f}`);
}
if (errors.length) { console.error('Manifest verification FAILED:\n - ' + errors.join('\n - ')); process.exit(1); }
console.log(`Manifest OK: ${m.name} v${m.version} (MV3), permissions: ${(m.permissions ?? []).join(', ')}`);
