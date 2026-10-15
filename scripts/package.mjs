// Packs the extension folder into dist/qidi-3mf-extension-<version>.zip for
// upload to the Chrome Web Store, after a few sanity checks.
// Usage: node scripts/package.mjs

import fs from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';

const ROOT = path.join(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`manifest ${manifest.version} ≠ package.json ${pkg.version}`);

const index = JSON.parse(fs.readFileSync(path.join(SRC, 'profiles', 'index.json'), 'utf8'));
for (const p of index.printers) {
  const bundle = fs.readFileSync(path.join(SRC, 'profiles', p.file), 'utf8');
  // A publishable build has only QIDI's own presets (see build-profiles --include-user).
  if (bundle.includes('"user":true')) throw new Error(`${p.file} contains user presets; rebuild without --include-user`);
  if (/"print_host":"[^"]+"|"printhost_apikey":"[^"]+"/.test(bundle)) throw new Error(`${p.file} contains printer connection data`);
}

const files = {};
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files[path.relative(SRC, full).split(path.sep).join('/')] = new Uint8Array(fs.readFileSync(full));
  }
})(SRC);

const out = path.join(ROOT, 'dist', `qidi-3mf-extension-${manifest.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, zipSync(files, { level: 9 }));
const size = fs.statSync(out).size;
console.log(`${out}: ${Object.keys(files).length} files, ${(size / 1e6).toFixed(2)} MB`);
