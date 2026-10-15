// Reads QIDI Studio presets (system + user) from the local installation,
// resolves the `inherits` chains and writes a flattened bundle for one printer
// into extension/profiles/<printer>.json.
//
// The base the converter applies presets on is a project saved from the QIDI
// Studio GUI for the same printer and version (found via Spotlight); the QIDI
// Studio CLI is used to find out which keys are per-filament arrays.
//
// Usage: node scripts/build-profiles.mjs [--printer "Q1 Pro 0.4 nozzle"] [--template <file.3mf>]
//        [--data-dir <QIDIStudio dir>] [--qidi-bin <path>]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const DATA_DIR = opt('data-dir', path.join(os.homedir(), 'Library/Application Support/QIDIStudio'));
const QIDI_BIN = opt('qidi-bin', '/Applications/QIDIStudio.app/Contents/MacOS/QIDIStudio');
const PRINTER = opt('printer', 'Q1 Pro 0.4 nozzle');
const OUT = opt('out', path.join(import.meta.dirname, '..', 'extension', 'profiles', 'printer.json'));

// Keys describing the preset file itself rather than slicing settings.
const META_KEYS = new Set([
  'type', 'from', 'instantiation', 'inherits', 'version', 'setting_id', 'base_id',
  'is_custom_defined', 'description', 'name', 'renamed_from', 'updated_time', 'user_id',
]);

function walkJson(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJson(p));
    else if (entry.name.endsWith('.json')) out.push(p);
  }
  return out;
}

function load(files, source) {
  const byName = new Map();
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    if (!j || typeof j !== 'object' || !j.name) continue;
    const type = j.type || guessType(f);
    if (!['machine', 'process', 'filament'].includes(type)) continue;
    byName.set(`${type}:${j.name}`, { ...j, type, __source: source });
  }
  return byName;
}

function guessType(file) {
  const parts = file.split(path.sep);
  for (const t of ['machine', 'process', 'filament']) if (parts.includes(t)) return t;
  return undefined;
}

const system = load(walkJson(path.join(DATA_DIR, 'system')), 'system');
const user = load(walkJson(path.join(DATA_DIR, 'user')).filter((f) => !f.includes('physical_printer')), 'user');
const all = new Map([...system, ...user]);

function flatten(type, name, seen = new Set()) {
  const key = `${type}:${name}`;
  const preset = all.get(key);
  if (!preset) throw new Error(`Preset not found: ${key}`);
  if (seen.has(key)) throw new Error(`Inheritance cycle at ${key}`);
  seen.add(key);
  const parent = preset.inherits ? flatten(type, preset.inherits, seen) : {};
  const own = {};
  for (const [k, v] of Object.entries(preset)) {
    if (!META_KEYS.has(k) && !k.startsWith('__')) own[k] = v;
  }
  return { ...parent, ...own };
}

function isInstantiable(p) {
  return p.__source === 'user' || p.instantiation === 'true';
}

function compatible(p, flat) {
  const printers = flat.compatible_printers;
  if (Array.isArray(printers) && printers.length) return printers.includes(PRINTER);
  // User presets inheriting from a compatible system preset.
  return p.__source === 'user' && p.inherits && compatibleByName(p.type, p.inherits);
}

function compatibleByName(type, name) {
  const p = all.get(`${type}:${name}`);
  if (!p) return false;
  return compatible(p, flatten(type, name));
}

const machine = flatten('machine', PRINTER);

const collect = (type) => {
  const out = {};
  for (const p of all.values()) {
    if (p.type !== type || !isInstantiable(p)) continue;
    let flat;
    try {
      flat = flatten(type, p.name);
    } catch {
      continue;
    }
    if (!compatible(p, flat)) continue;
    delete flat.compatible_printers;
    delete flat.compatible_printers_condition;
    delete flat.compatible_prints;
    delete flat.compatible_prints_condition;
    out[p.name] = {
      user: p.__source === 'user',
      inherits: p.__source === 'user' ? p.inherits || '' : '',
      settings: flat,
    };
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

const processes = collect('process');
const filaments = collect('filament');

// Ask the QIDI Studio CLI for a project exported with pure defaults (the base
// every preset is applied on top of) and one with three filaments, which tells
// us which project keys are per-filament arrays.
function exportProject(name, extraArgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qidi-3mf-'));
  const stl = path.join(dir, 'cube.stl');
  fs.writeFileSync(stl, cubeStl());
  const files = [];
  const writeJson = (file, obj) => {
    const p = path.join(dir, file);
    fs.writeFileSync(p, JSON.stringify(obj));
    files.push(p);
    return p;
  };
  const resolved = extraArgs((file, obj) => writeJson(file, obj));
  execFileSync(QIDI_BIN, ['--outputdir', dir, '--export-3mf', `${name}.3mf`, ...resolved, stl], {
    stdio: 'pipe',
    timeout: 120_000,
  });
  const zip = unzipSync(fs.readFileSync(path.join(dir, `${name}.3mf`)));
  fs.rmSync(dir, { recursive: true, force: true });
  return JSON.parse(strFromU8(zip['Metadata/project_settings.config']));
}

function cubeStl() {
  const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const facets = f.map((t) => `facet normal 0 0 0\nouter loop\n${t.map((i) => `vertex ${v[i].join(' ')}\n`).join('')}endloop\nendfacet\n`);
  return `solid cube\n${facets.join('')}endsolid cube\n`;
}

const asPreset = (type, name, settings) => ({
  ...settings,
  type,
  name,
  from: 'system',
  instantiation: 'true',
  ...(type === 'machine' ? {} : { compatible_printers: [PRINTER] }),
});

const cliDefaults = exportProject('defaults', () => []);

const defaultFilament = (machine.default_filament_profile || [])[0];
const threeFilaments = exportProject('three', (write) => {
  const m = write('machine.json', asPreset('machine', PRINTER, machine));
  const proc = write('process.json', asPreset('process', machine.default_print_profile, processes[machine.default_print_profile].settings));
  const fil = Array.from({ length: 3 }, (_, i) =>
    write(`filament${i}.json`, asPreset('filament', defaultFilament, filaments[defaultFilament].settings)));
  return ['--load-settings', `${m};${proc}`, '--load-filaments', fil.join(';')];
});
if (threeFilaments.filament_settings_id.length !== 3) throw new Error('Expected 3 filaments in the CLI export');

// The CLI writes some values differently from the GUI (and QIDI Studio crashes
// on a few of them), so the template is a project saved from the GUI for this
// printer and slicer version. Values the template's author changed by hand
// that no preset will override are reset to the CLI defaults.
const { file: templateFile, config: template } = findGuiTemplate();
const presetKeys = new Set([
  ...Object.keys(machine),
  ...Object.values(processes).flatMap((p) => Object.keys(p.settings)),
  ...Object.values(filaments).flatMap((f) => Object.keys(f.settings)),
]);
for (const entry of template.different_settings_to_system || []) {
  for (const k of String(entry).split(';').filter(Boolean)) {
    if (!presetKeys.has(k) && k in cliDefaults) template[k] = cliDefaults[k];
  }
}

const templateFilaments = template.filament_settings_id.length;
const filamentKeys = Object.keys(threeFilaments)
  .filter((k) => Array.isArray(threeFilaments[k]) && Array.isArray(template[k]) && template[k].length > 0)
  .filter((k) => threeFilaments[k].length * templateFilaments === 3 * template[k].length)
  .sort();
// Keys only present in filament presets are per-filament too.
for (const f of Object.values(filaments)) {
  for (const k of Object.keys(f.settings)) {
    if (!filamentKeys.includes(k) && (template[k] === undefined || Array.isArray(template[k]))) filamentKeys.push(k);
  }
}

function findGuiTemplate() {
  const explicit = opt('template');
  const candidates = explicit
    ? [explicit]
    : execFileSync('mdfind', ['-onlyin', os.homedir(), 'kMDItemFSName == "*.3mf"'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
  const matches = [];
  for (const file of candidates) {
    let zip;
    try {
      zip = unzipSync(fs.readFileSync(file), {
        filter: (f) => f.name === 'Metadata/project_settings.config' || f.name === '3D/3dmodel.model',
      });
    } catch {
      continue;
    }
    const model = zip['3D/3dmodel.model'] && strFromU8(zip['3D/3dmodel.model'].subarray(0, 4000));
    const app = model?.match(/name="Application">([^<]*)</)?.[1];
    if (app !== `QIDIStudio-${cliDefaults.version}` || !zip['Metadata/project_settings.config']) continue;
    const config = JSON.parse(strFromU8(zip['Metadata/project_settings.config']));
    if (config.printer_settings_id !== PRINTER) continue;
    matches.push({ file, config, mtime: fs.statSync(file).mtimeMs });
  }
  matches.sort((a, b) => a.config.filament_settings_id.length - b.config.filament_settings_id.length || b.mtime - a.mtime);
  if (!matches.length) {
    throw new Error(
      `No project saved by QIDIStudio-${cliDefaults.version} for "${PRINTER}" found. ` +
        'Save any model as a project from QIDI Studio and run again (or pass --template <file.3mf>).',
    );
  }
  return matches[0];
}

const machineMeta = all.get(`machine:${PRINTER}`);
const bundle = {
  generatedAt: new Date().toISOString(),
  slicer: 'QIDIStudio',
  slicerVersion: template.version,
  templateSource: path.basename(templateFile),
  printer: {
    name: PRINTER,
    inherits: machineMeta.__source === 'user' ? machineMeta.inherits : '',
    settings: machine,
  },
  defaults: {
    process: machine.default_print_profile,
    filament: defaultFilament,
  },
  template,
  projectKeys: Object.keys(threeFilaments).sort(),
  filamentKeys,
  processes,
  filaments,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(bundle));
console.log(
  `Wrote ${OUT}: printer "${PRINTER}", ${Object.keys(processes).length} processes, ` +
    `${Object.keys(filaments).length} filaments, ${filamentKeys.length} per-filament keys, QIDI Studio ${template.version}, template ${path.basename(templateFile)}`,
);
