// User settings shared by the service worker and the popup.

export const MATERIALS = [
  ['PLA', 'PLA'],
  ['PLA-SILK', 'PLA Silk'],
  ['PLA-CF', 'PLA-CF'],
  ['PETG', 'PETG'],
  ['PETG-CF', 'PETG-CF'],
  ['ABS', 'ABS'],
  ['ASA', 'ASA'],
  ['TPU', 'TPU'],
  ['PC', 'PC'],
  ['PA', 'PA / Nylon'],
  ['SUPPORT', 'Podpůrný (PVA…)'],
];

export const DEFAULT_SETTINGS = {
  enabled: true,
  process: 'auto',
  filamentMap: {},
  keepDesignerSettings: true,
  suffix: ' (Q1 Pro)',
};

export async function loadSettings() {
  const stored = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

export async function saveSettings(settings) {
  await chrome.storage.sync.set({ settings });
}

let bundlePromise;
export function loadBundle() {
  bundlePromise ??= fetch(chrome.runtime.getURL('profiles/printer.json')).then((r) => r.json());
  return bundlePromise;
}

export function outputName(name, suffix) {
  const base = name.replace(/\.3mf$/i, '');
  return `${base}${suffix || ''}.3mf`;
}

// History of recent conversions, shown in the popup.
export async function addHistory(entry) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift({ ...entry, time: Date.now() });
  await chrome.storage.local.set({ history: history.slice(0, 15) });
}
