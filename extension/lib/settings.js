// User settings, printer profile bundles and imported user presets, shared by
// the service worker, the offscreen document and the extension pages.

import { setLanguage } from './i18n.js';

export const MATERIALS = ['PLA', 'PLA-SILK', 'PLA-CF', 'PETG', 'PETG-CF', 'ABS', 'ASA', 'TPU', 'PC', 'PA', 'SUPPORT'];

export const DEFAULT_SETTINGS = {
  enabled: true,
  language: 'auto',
  printer: '',
  keepDesignerSettings: true,
  suffix: ' ({printer})',
  // Per printer preset name: { process: 'auto' | name, filamentMap: { material: name } }
  printers: {},
};

export async function loadSettings() {
  const { settings: stored = {} } = await chrome.storage.sync.get('settings');
  const settings = { ...DEFAULT_SETTINGS, ...stored, printers: { ...(stored.printers || {}) } };
  // Version 1 stored one process and filament map for the Q1 Pro.
  if (stored.process !== undefined || stored.filamentMap !== undefined) {
    settings.printer ||= 'Q1 Pro 0.4 nozzle';
    settings.printers[settings.printer] ??= { process: stored.process ?? 'auto', filamentMap: stored.filamentMap ?? {} };
    delete settings.process;
    delete settings.filamentMap;
  }
  if (!settings.printer) settings.printer = (await loadIndex()).default;
  setLanguage(settings.language);
  return settings;
}

export async function saveSettings(settings) {
  await chrome.storage.sync.set({ settings });
}

export function printerSettings(settings, printer = settings.printer) {
  return { process: 'auto', filamentMap: {}, ...(settings.printers[printer] || {}) };
}

// What convert3mf needs from the settings.
export function conversionOptions(settings) {
  const p = printerSettings(settings);
  return { process: p.process, filamentMap: p.filamentMap, keepDesignerSettings: settings.keepDesignerSettings };
}

let indexPromise;
export function loadIndex() {
  indexPromise ??= fetch(chrome.runtime.getURL('profiles/index.json')).then((r) => r.json());
  return indexPromise;
}

const bundles = new Map();
// Profile bundle of a printer, with the user's imported presets merged in.
export async function loadBundle(printer, userPresets) {
  const index = await loadIndex();
  const entry = index.printers.find((p) => p.name === printer) || index.printers.find((p) => p.name === index.default);
  if (!bundles.has(entry.file)) {
    bundles.set(entry.file, fetch(chrome.runtime.getURL(`profiles/${entry.file}`)).then((r) => r.json()));
  }
  const bundle = structuredClone(await bundles.get(entry.file));
  return mergeUserPresets(bundle, userPresets ?? (await loadUserPresets()));
}

export function outputName(name, suffix, bundle) {
  const base = name.replace(/\.3mf$/i, '');
  const model = bundle?.printer?.model || 'QIDI';
  return `${base}${(suffix || '').replaceAll('{printer}', model)}.3mf`;
}

// History of recent conversions, shown in the popup.
export async function addHistory(entry) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift({ ...entry, time: Date.now() });
  await chrome.storage.local.set({ history: history.slice(0, 15) });
}

// ---------------------------------------------------------------------------
// User presets imported from QIDI Studio

// Keys describing the preset file itself rather than slicing settings.
const META_KEYS = new Set([
  'type', 'from', 'instantiation', 'inherits', 'version', 'setting_id', 'base_id', 'filament_id_old',
  'is_custom_defined', 'description', 'name', 'renamed_from', 'updated_time', 'user_id',
  'compatible_printers', 'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition',
]);

export async function loadUserPresets() {
  const { userPresets = [] } = await chrome.storage.local.get('userPresets');
  return userPresets;
}

export async function saveUserPresets(list) {
  await chrome.storage.local.set({ userPresets: list });
}

// Parses QIDI Studio user preset files. Returns presets keyed by type and
// name; they are flattened later against the printer they inherit from.
export function parseUserPreset(text, path = '') {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object' || !j.name || !j.inherits) return undefined;
  const type = j.type || (/(^|\/)process\//.test(path) ? 'process' : /(^|\/)filament\//.test(path) ? 'filament' : undefined) ||
    (j.filament_settings_id || j.filament_type ? 'filament' : j.print_settings_id || j.layer_height ? 'process' : undefined);
  // Undecided types are resolved against the bundle by the parent preset.
  if (type && type !== 'process' && type !== 'filament') return undefined;
  const settings = {};
  for (const [k, v] of Object.entries(j)) if (!META_KEYS.has(k)) settings[k] = v;
  return { type, name: j.name, inherits: j.inherits, settings };
}

// Process or filament, by the file or by where its parent preset is.
export function presetType(bundle, preset) {
  if (preset.type) return preset.type;
  if (bundle.processes[preset.inherits]) return 'process';
  if (bundle.filaments[preset.inherits]) return 'filament';
  return undefined;
}

// Adds user presets whose parent preset exists in this printer's bundle.
export function mergeUserPresets(bundle, presets) {
  for (const type of ['process', 'filament']) {
    const target = type === 'process' ? bundle.processes : bundle.filaments;
    // Parents may be other user presets; resolve until nothing changes.
    let pending = presets.filter((p) => presetType(bundle, p) === type);
    for (let pass = 0; pass < 4 && pending.length; pass++) {
      pending = pending.filter((p) => {
        const parent = target[p.inherits];
        if (!parent) return true;
        target[p.name] = { user: true, inherits: p.inherits, settings: { ...parent.settings, ...p.settings } };
        return false;
      });
    }
  }
  return bundle;
}

// Which presets of a list would apply to a bundle.
export function applicablePresets(bundle, presets) {
  const merged = mergeUserPresets(structuredClone({ processes: bundle.processes, filaments: bundle.filaments }), presets);
  return presets.filter((p) => (presetType(bundle, p) === 'process' ? merged.processes : merged.filaments)[p.name]?.user);
}
