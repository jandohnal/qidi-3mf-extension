import { defaultFilamentFor } from './lib/convert.js';
import { fmt, setLanguage, t, translatePage } from './lib/i18n.js';
import {
  MATERIALS, applicablePresets, loadBundle, loadIndex, loadSettings, loadUserPresets, parseUserPreset, presetType,
  printerSettings, saveSettings, saveUserPresets,
} from './lib/settings.js';
import { putUpload } from './lib/uploads.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== undefined && c !== null));
  return node;
};

const [index, settings] = await Promise.all([loadIndex(), loadSettings()]);
let bundle;

translatePage();
$('enabled').checked = settings.enabled;
$('keep').checked = settings.keepDesignerSettings;
$('suffix').value = settings.suffix;
$('language').value = settings.language;
$('footer').textContent = t('footer', { printers: new Set(index.printers.map((p) => p.model)).size, version: index.slicerVersion });
$('user-hint').textContent = t('userPresetsHint', {
  path: /Win/.test(navigator.platform) ? '%APPDATA%\\QIDIStudio\\user\\…' : '~/Library/Application Support/QIDIStudio/user/…',
});

// --- printer --------------------------------------------------------------

const models = [...new Set(index.printers.map((p) => p.model))];
$('model').append(...models.map((m) => el('option', { value: m, textContent: `QIDI ${m}` })));

function fillNozzles(model, selected) {
  const options = index.printers.filter((p) => p.model === model);
  $('nozzle').replaceChildren(...options.map((p) => el('option', { value: p.name, textContent: `${p.nozzle} mm` })));
  $('nozzle').value = options.some((p) => p.name === selected) ? selected : (options.find((p) => p.nozzle === '0.4') || options[0]).name;
}

const current = index.printers.find((p) => p.name === settings.printer) || index.printers[0];
$('model').value = current.model;
fillNozzles(current.model, current.name);

$('model').addEventListener('change', () => {
  fillNozzles($('model').value);
  changePrinter();
});
$('nozzle').addEventListener('change', changePrinter);

async function changePrinter() {
  settings.printer = $('nozzle').value;
  await saveSettings(settings);
  await renderPrinter();
}

// --- per-printer profiles ------------------------------------------------

const userMark = (entry) => (entry.user ? ' ★' : '');
const shortName = (name) => name.replace(/ @[^()]*?nozzle/, '');

async function renderPrinter() {
  bundle = await loadBundle(settings.printer);
  const p = printerSettings(settings);
  $('printer-line').textContent = `${bundle.printer.name} · QIDI Studio ${bundle.slicerVersion}`;

  $('process').replaceChildren(
    el('option', { value: 'auto', textContent: t('processAuto') }),
    ...Object.entries(bundle.processes).map(([name, e]) => el('option', { value: name, textContent: name + userMark(e) })),
  );
  $('process').value = bundle.processes[p.process] ? p.process : 'auto';

  const filaments = Object.entries(bundle.filaments).sort(([a, fa], [b, fb]) => Number(fb.user) - Number(fa.user) || a.localeCompare(b));
  $('materials').replaceChildren(...MATERIALS.map((key) => {
    const select = el('select', { id: `mat-${key}` });
    select.append(
      el('option', { value: '', textContent: t('defaultFilament', { name: shortName(defaultFilamentFor(bundle, key)) }) }),
      ...filaments.map(([name, f]) => el('option', { value: name, textContent: shortName(name) + userMark(f) })),
    );
    select.value = bundle.filaments[p.filamentMap[key]] ? p.filamentMap[key] : '';
    select.addEventListener('change', save);
    return el('label', { className: 'row' }, el('span', { textContent: t('materials')[key] || key }), select);
  }));
  await renderUserPresets();
}

for (const id of ['enabled', 'keep', 'process']) $(id).addEventListener('change', save);
$('suffix').addEventListener('input', save);
$('language').addEventListener('change', async () => {
  settings.language = $('language').value;
  await saveSettings(settings);
  setLanguage(settings.language);
  location.reload();
});

async function save() {
  settings.enabled = $('enabled').checked;
  settings.keepDesignerSettings = $('keep').checked;
  settings.suffix = $('suffix').value;
  settings.printers[settings.printer] = {
    process: $('process').value,
    filamentMap: Object.fromEntries(MATERIALS.map((key) => [key, $(`mat-${key}`)?.value]).filter(([, v]) => v)),
  };
  await saveSettings(settings);
}

// --- user presets ----------------------------------------------------------

$('import').addEventListener('click', () => $('preset-files').click());
$('preset-files').addEventListener('change', async () => {
  const files = [...$('preset-files').files];
  const parsed = [];
  const skipped = [];
  for (const f of files) {
    const preset = parseUserPreset(await f.text(), f.webkitRelativePath || f.name);
    if (preset) parsed.push(preset);
    else skipped.push(f.name);
  }
  for (const p of parsed) p.type ??= presetType(bundle, p);
  const usable = applicablePresets(bundle, parsed);
  for (const p of parsed) if (!usable.includes(p)) skipped.push(p.name);
  // Keep presets for other printers too; replace ones with the same name.
  const existing = await loadUserPresets();
  const keep = parsed.filter((p) => p.type);
  const names = new Set(keep.map((p) => `${p.type}:${p.name}`));
  await saveUserPresets([...existing.filter((p) => !names.has(`${p.type}:${p.name}`)), ...keep]);
  $('import-result').hidden = false;
  $('import-result').textContent = [
    t('userPresetsImported', { n: usable.length, printer: bundle.printer.name }),
    skipped.length ? t('userPresetsSkipped', { names: skipped.join(', ') }) : '',
  ].filter(Boolean).join(' ');
  $('preset-files').value = '';
  await renderPrinter();
});

async function renderUserPresets() {
  const all = await loadUserPresets();
  const here = applicablePresets(bundle, all);
  const list = $('user-presets');
  list.replaceChildren();
  if (!here.length) {
    list.append(el('li', { className: 'meta', textContent: t('userPresetsNone') }));
    return;
  }
  for (const p of here) {
    const remove = el('button', { type: 'button', className: 'link', textContent: t('userPresetsRemove') });
    remove.addEventListener('click', async () => {
      await saveUserPresets((await loadUserPresets()).filter((x) => !(x.type === p.type && x.name === p.name)));
      await renderPrinter();
    });
    list.append(el('li', {}, el('span', { textContent: `${p.name} ` }), el('span', { className: 'meta', textContent: `(${p.type}) ` }), remove));
  }
}

// --- manual conversion -----------------------------------------------------

const drop = $('drop');
$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', () => convertFiles([...$('file').files]));
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  convertFiles([...e.dataTransfer.files].filter((f) => /\.3mf$/i.test(f.name)));
});

// Each file opens the save dialog, which shows the changes and saves.
async function convertFiles(files) {
  if (!files.length) return;
  const result = $('result');
  result.hidden = false;
  result.replaceChildren(el('p', {
    textContent: files.length === 1 ? t('converting', { name: files[0].name }) : t('convertingMany', { n: files.length }),
  }));
  try {
    for (const file of files) {
      const key = crypto.randomUUID();
      await putUpload(key, file);
      const res = await chrome.runtime.sendMessage({ type: 'convert-upload', key, name: file.name });
      if (res?.error) throw new Error(res.error);
    }
    window.close();
  } catch (e) {
    result.replaceChildren(el('p', { className: 'err', textContent: t('error', { error: e?.message || e }) }));
  }
}

// --- history ---------------------------------------------------------------

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  const list = $('history');
  list.replaceChildren();
  if (!history.length) {
    list.append(el('li', { className: 'meta', textContent: t('historyEmpty') }));
    return;
  }
  for (const h of history) {
    const when = new Date(h.time).toLocaleString(document.documentElement.lang, { dateStyle: 'short', timeStyle: 'short' });
    const status = h.error
      ? t('historyError', { error: fmt(h.error) })
      : h.action === 'cancel' ? t('historyNotSaved') : h.report?.changed ? `→ ${h.filename}` : t('historyUnchanged');
    const warnings = h.report?.warnings?.length ? ` · ⚠ ${h.report.warnings.length}` : '';
    list.append(el('li', { title: [...(h.report?.warnings || []), ...(h.report?.notes || [])].map(fmt).join('\n') },
      el('div', { textContent: h.name }),
      el('div', { className: 'meta', textContent: `${when} · ${status}${warnings}` })));
  }
}

await renderPrinter();
renderHistory();
