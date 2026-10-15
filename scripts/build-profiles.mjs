// Builds the printer profile bundles shipped with the extension from a local
// QIDI Studio installation (macOS):
//
//   extension/profiles/index.json        list of printers
//   extension/profiles/<printer>.json    flattened machine, process and filament
//                                        presets plus the project template
//
// Presets are resolved through their `inherits` chains within their vendor
// folder (two QIDI series both ship a different "fdm_machine_x_common").
// The project template is a project saved from the QIDI Studio GUI of the same
// version (scripts/templates, or --template); the QIDI Studio CLI provides
// default values and tells which keys are per-filament arrays.
//
// Usage: node scripts/build-profiles.mjs [--printer "Q1 Pro 0.4 nozzle"]... [--include-user]
//        [--template <file.3mf>] [--data-dir <QIDIStudio dir>] [--qidi-bin <path>]
//
// --include-user adds your own presets from QIDI Studio; do not publish such a build.

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
const opts = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));

const DATA_DIR = opt('data-dir', path.join(os.homedir(), 'Library/Application Support/QIDIStudio'));
const QIDI_BIN = opt('qidi-bin', '/Applications/QIDIStudio.app/Contents/MacOS/QIDIStudio');
const OUT_DIR = opt('out', path.join(import.meta.dirname, '..', 'extension', 'profiles'));
const INCLUDE_USER = args.includes('--include-user');
const ONLY = opts('printer');
const DEFAULT_PRINTER = 'Q1 Pro 0.4 nozzle';

// Keys describing the preset file itself rather than slicing settings.
const META_KEYS = new Set([
  'type', 'from', 'instantiation', 'inherits', 'version', 'setting_id', 'base_id',
  'is_custom_defined', 'description', 'name', 'renamed_from', 'updated_time', 'user_id',
]);
// Project keys tied to the template author's printer connection.
const PRIVATE_KEYS = ['print_host', 'print_host_webui', 'printhost_apikey', 'printhost_cafile', 'printhost_password',
  'printhost_port', 'printhost_user'];

// ---------------------------------------------------------------------------
// Presets

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

const TYPES = ['machine', 'process', 'filament'];
const guessType = (file) => TYPES.find((t) => file.split(path.sep).includes(t));

// Presets by "<vendor>|<type>:<name>"; vendor is the series folder.
const presets = new Map();
function load(root, source, vendorOf) {
  for (const file of walkJson(root)) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!j || typeof j !== 'object' || !j.name) continue;
    const type = j.type || guessType(file);
    if (!TYPES.includes(type)) continue;
    const vendor = vendorOf(file);
    presets.set(`${vendor}|${type}:${j.name}`, { ...j, type, vendor, __source: source });
  }
}

const systemDir = path.join(DATA_DIR, 'system');
load(systemDir, 'system', (f) => path.relative(systemDir, f).split(path.sep)[0]);
if (INCLUDE_USER) {
  load(path.join(DATA_DIR, 'user'), 'user', () => 'user');
}

function find(type, name, vendor) {
  return presets.get(`${vendor}|${type}:${name}`) ??
    [...presets.values()].find((p) => p.type === type && p.name === name && p.__source === 'system');
}

function flatten(type, name, vendor, seen = new Set()) {
  const preset = find(type, name, vendor);
  if (!preset) throw new Error(`Preset not found: ${type} "${name}" (${vendor})`);
  const key = `${preset.vendor}|${type}:${name}`;
  if (seen.has(key)) throw new Error(`Inheritance cycle at ${key}`);
  seen.add(key);
  const parent = preset.inherits ? flatten(type, preset.inherits, preset.vendor, seen) : {};
  const own = {};
  for (const [k, v] of Object.entries(preset)) if (!META_KEYS.has(k) && !k.startsWith('__')) own[k] = v;
  return { ...parent, ...own };
}

const machines = [...presets.values()]
  .filter((p) => p.type === 'machine' && p.__source === 'system' && p.instantiation === 'true')
  .filter((p) => !ONLY.length || ONLY.includes(p.name))
  .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
if (!machines.length) throw new Error('No QIDI printer presets found');

function presetsFor(type, printer) {
  const out = {};
  for (const p of presets.values()) {
    if (p.type !== type) continue;
    const user = p.__source === 'user';
    if (!user && p.instantiation !== 'true') continue;
    let flat;
    try {
      flat = flatten(type, p.name, p.vendor);
    } catch {
      continue;
    }
    const compatibleList = flat.compatible_printers;
    const ok = Array.isArray(compatibleList) && compatibleList.length
      ? compatibleList.includes(printer)
      : user && p.inherits && out[p.inherits];
    if (!ok) continue;
    for (const k of ['compatible_printers', 'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition']) delete flat[k];
    out[p.name] = { user, inherits: user ? p.inherits || '' : '', settings: flat };
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// QIDI Studio CLI: defaults and per-filament keys

function exportProject(name, extraArgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qidi-3mf-'));
  try {
    const stl = path.join(dir, 'cube.stl');
    fs.writeFileSync(stl, cubeStl());
    const write = (file, obj) => {
      const p = path.join(dir, file);
      fs.writeFileSync(p, JSON.stringify(obj));
      return p;
    };
    execFileSync(QIDI_BIN, ['--outputdir', dir, '--export-3mf', `${name}.3mf`, ...extraArgs(write), stl], {
      stdio: 'pipe',
      timeout: 120_000,
    });
    const zip = unzipSync(fs.readFileSync(path.join(dir, `${name}.3mf`)));
    return JSON.parse(strFromU8(zip['Metadata/project_settings.config']));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cubeStl() {
  const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const facets = f.map((t) => `facet normal 0 0 0\nouter loop\n${t.map((i) => `vertex ${v[i].join(' ')}\n`).join('')}endloop\nendfacet\n`);
  return `solid cube\n${facets.join('')}endsolid cube\n`;
}

const asPreset = (type, name, settings, printer) => ({
  ...settings,
  type,
  name,
  from: 'system',
  instantiation: 'true',
  ...(type === 'machine' ? {} : { compatible_printers: [printer] }),
});

const cliDefaults = exportProject('defaults', () => []);

const refMachine = machines.find((m) => m.name === DEFAULT_PRINTER) || machines[0];
const refSettings = flatten('machine', refMachine.name, refMachine.vendor);
const refProcesses = presetsFor('process', refMachine.name);
const refFilaments = presetsFor('filament', refMachine.name);
const refFilament = (refSettings.default_filament_profile || [])[0];
const threeFilaments = exportProject('three', (write) => {
  const m = write('machine.json', asPreset('machine', refMachine.name, refSettings));
  const proc = write('process.json', asPreset('process', refSettings.default_print_profile, refProcesses[refSettings.default_print_profile].settings, refMachine.name));
  const fil = [0, 1, 2].map((i) => write(`filament${i}.json`, asPreset('filament', refFilament, refFilaments[refFilament].settings, refMachine.name)));
  return ['--load-settings', `${m};${proc}`, '--load-filaments', fil.join(';')];
});
if (threeFilaments.filament_settings_id.length !== 3) throw new Error('Expected 3 filaments in the CLI export');

// ---------------------------------------------------------------------------
// GUI template

// The CLI writes some values differently from the GUI (and QIDI Studio crashes
// on a few of them), so the base is a project saved from the GUI of the same
// version: scripts/templates/QIDIStudio-<version>.json, or --template <file.3mf>
// (a project saved from QIDI Studio, not one produced by this extension).
function findGuiTemplate() {
  const explicit = opt('template');
  if (explicit) {
    const zip = unzipSync(fs.readFileSync(explicit));
    const app = strFromU8(zip['3D/3dmodel.model'].subarray(0, 4000)).match(/name="Application">([^<]*)</)?.[1];
    if (app !== `QIDIStudio-${cliDefaults.version}`) throw new Error(`${explicit} was saved by ${app}, need QIDIStudio-${cliDefaults.version}`);
    return { file: explicit, config: JSON.parse(strFromU8(zip['Metadata/project_settings.config'])) };
  }
  const file = path.join(import.meta.dirname, 'templates', `QIDIStudio-${cliDefaults.version}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No template for QIDI Studio ${cliDefaults.version}. Save any model as a project from the QIDI Studio ` +
      'GUI and pass it with --template <file.3mf>; then keep it as scripts/templates/QIDIStudio-<version>.json.');
  }
  const { config, perFilamentKeys = [] } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { file, config, perFilamentKeys };
}

const { file: templateFile, config: guiTemplate, perFilamentKeys = [] } = findGuiTemplate();
for (const k of PRIVATE_KEYS) if (k in guiTemplate) guiTemplate[k] = cliDefaults[k] ?? '';

function shapeLike(target, value) {
  if (Array.isArray(target) && !Array.isArray(value)) return [String(value)];
  if (!Array.isArray(target) && Array.isArray(value)) return value.length === 1 ? String(value[0]) : value.join(',');
  if (typeof target === 'string' && target.endsWith('%') && /^-?\d+(\.\d+)?$/.test(String(value))) return `${value}%`;
  return value;
}

const allPresetKeys = (type) => new Set([...presets.values()].filter((p) => p.type === type).flatMap((p) => Object.keys(p)));
const machineKeys = allPresetKeys('machine');
const otherPresetKeys = new Set([...allPresetKeys('process'), ...allPresetKeys('filament')]);

// The template keeps values of its own printer and of anything its author
// changed by hand; reset those to defaults unless the target presets set them.
function templateFor(machineSettings) {
  const t = structuredClone(guiTemplate);
  const reset = (k) => {
    if (k in cliDefaults) t[k] = shapeLike(t[k], cliDefaults[k]);
  };
  for (const k of Object.keys(t)) if (machineKeys.has(k) && !(k in machineSettings)) reset(k);
  for (const entry of guiTemplate.different_settings_to_system || []) {
    for (const k of String(entry).split(';').filter(Boolean)) {
      if (!(k in machineSettings) && !otherPresetKeys.has(k)) reset(k);
    }
  }
  return t;
}

const templateFilaments = guiTemplate.filament_settings_id.length;
const filamentKeys = Object.keys(threeFilaments)
  .filter((k) => Array.isArray(threeFilaments[k]) && Array.isArray(guiTemplate[k]) && guiTemplate[k].length > 0)
  .filter((k) => threeFilaments[k].length * templateFilaments === 3 * guiTemplate[k].length);
// The CLI misses some per-filament keys (hole/counter compensation, scarf
// seams…); the template file lists them, taken from a multi-filament project.
for (const k of perFilamentKeys) if (!filamentKeys.includes(k) && Array.isArray(guiTemplate[k])) filamentKeys.push(k);
for (const k of allPresetKeys('filament')) {
  if (!META_KEYS.has(k) && !k.startsWith('__') && !filamentKeys.includes(k) && (guiTemplate[k] === undefined || Array.isArray(guiTemplate[k]))) {
    filamentKeys.push(k);
  }
}
filamentKeys.sort();
const projectKeys = Object.keys(threeFilaments).sort();

// ---------------------------------------------------------------------------
// Output

const slug = (name) => name.toLowerCase().replace(/ nozzle$/, '').replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const f of fs.readdirSync(OUT_DIR)) if (f.endsWith('.json')) fs.rmSync(path.join(OUT_DIR, f));

const generatedAt = new Date().toISOString();
const index = { generatedAt, slicer: 'QIDIStudio', slicerVersion: guiTemplate.version, default: DEFAULT_PRINTER, printers: [] };
for (const m of machines) {
  const settings = flatten('machine', m.name, m.vendor);
  const processes = presetsFor('process', m.name);
  const filaments = presetsFor('filament', m.name);
  if (!Object.keys(processes).length || !Object.keys(filaments).length) continue;
  const defaultProcess = processes[settings.default_print_profile] ? settings.default_print_profile : Object.keys(processes)[0];
  const defaultFilament = filaments[(settings.default_filament_profile || [])[0]] ? settings.default_filament_profile[0] : Object.keys(filaments)[0];
  const file = `${slug(m.name)}.json`;
  const bundle = {
    generatedAt,
    slicer: 'QIDIStudio',
    slicerVersion: guiTemplate.version,
    printer: { name: m.name, model: settings.printer_model, nozzle: String(settings.nozzle_diameter?.[0] ?? ''), inherits: '', settings },
    defaults: { process: defaultProcess, filament: defaultFilament },
    template: templateFor(settings),
    projectKeys,
    filamentKeys,
    processes,
    filaments,
  };
  fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(bundle));
  index.printers.push({ name: m.name, model: settings.printer_model, nozzle: bundle.printer.nozzle, file });
  console.log(`${m.name.padEnd(26)} ${String(Object.keys(processes).length).padStart(3)} processes ${String(Object.keys(filaments).length).padStart(4)} filaments → ${file}`);
}
fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 1));
console.log(`\n${index.printers.length} printers, QIDI Studio ${guiTemplate.version}, template from ${path.basename(templateFile)}` +
  `${INCLUDE_USER ? ', INCLUDING your own presets – do not publish this build' : ''}`);
