// Converts 3MF files and (optionally) slices the results with the QIDI Studio
// CLI to check that QIDI Studio accepts them.
//
// Usage: node scripts/try-convert.mjs [--slice] [--out <dir>] file.3mf...

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { convert3mf } from '../extension/lib/convert.js';

const args = process.argv.slice(2);
const slice = args.includes('--slice');
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'qidi-out-'));
const inputs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const QIDI_BIN = '/Applications/QIDIStudio.app/Contents/MacOS/QIDIStudio';

const bundle = JSON.parse(fs.readFileSync(new URL('../extension/profiles/printer.json', import.meta.url)));
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
for (const file of inputs) {
  const name = path.basename(file);
  try {
    const { bytes, report } = convert3mf(new Uint8Array(fs.readFileSync(file)), bundle, {});
    const out = path.join(outDir, name);
    fs.writeFileSync(out, bytes);
    console.log(`\n== ${name} [${report.source}] ${report.changed ? 'converted' : 'unchanged'}`);
    for (const n of report.notes) console.log(`   ${n}`);
    for (const w of report.warnings) console.log(`   ! ${w}`);
    if (slice && report.changed) console.log(`   slice: ${sliceCheck(out)}`);
  } catch (e) {
    failures++;
    console.log(`\n== ${name} FAILED: ${e.stack}`);
  }
}
console.log(`\nOutput: ${outDir}`);
process.exit(failures ? 1 : 0);

function sliceCheck(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qidi-slice-'));
  try {
    execFileSync(QIDI_BIN, ['--debug', '1', '--outputdir', dir, '--slice', '0', '--export-3mf', 'sliced.3mf', file], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 300_000,
    });
  } catch (e) {
    const result = fs.existsSync(path.join(dir, 'result.json')) ? fs.readFileSync(path.join(dir, 'result.json'), 'utf8') : '';
    return `FAILED (${e.status ?? e.code}) ${result.replace(/\s+/g, ' ').slice(0, 400)}`;
  }
  const zip = unzipSync(fs.readFileSync(path.join(dir, 'sliced.3mf')));
  const plates = Object.keys(zip).filter((n) => /^Metadata\/plate_\d+\.gcode$/.test(n));
  const g = strFromU8(zip[plates[0]]);
  const printer = g.match(/; printer_settings_id = (.*)/)?.[1];
  const lh = g.match(/; layer_height = (.*)/)?.[1];
  const start = g.includes('PRINT_START') ? 'PRINT_START ok' : 'no PRINT_START!';
  fs.rmSync(dir, { recursive: true, force: true });
  return `OK, ${plates.length} plate(s), printer=${printer}, layer_height=${lh}, ${start}`;
}
