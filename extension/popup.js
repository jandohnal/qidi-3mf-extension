import { convert3mf, defaultFilamentFor } from './lib/convert.js';
import { MATERIALS, addHistory, loadBundle, loadSettings, outputName, saveSettings } from './lib/settings.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== undefined && c !== null));
  return node;
};

const [bundle, settings] = await Promise.all([loadBundle(), loadSettings()]);

$('printer').textContent = `${bundle.printer.name} · QIDI Studio ${bundle.slicerVersion}`;
$('footer').textContent =
  `Profily: ${Object.keys(bundle.processes).length} procesů, ${Object.keys(bundle.filaments).length} filamentů ` +
  `(vygenerováno ${new Date(bundle.generatedAt).toLocaleDateString('cs-CZ')})`;

// --- settings form ----------------------------------------------------------

$('enabled').checked = settings.enabled;
$('keep').checked = settings.keepDesignerSettings;
$('suffix').value = settings.suffix;

const userMark = (entry) => (entry.user ? ' ★' : '');

$('process').append(
  el('option', { value: 'auto', textContent: 'Automaticky podle výšky vrstvy' }),
  ...Object.entries(bundle.processes).map(([name, p]) => el('option', { value: name, textContent: name + userMark(p) })),
);
$('process').value = bundle.processes[settings.process] ? settings.process : 'auto';

const filamentNames = Object.entries(bundle.filaments).sort(([a, fa], [b, fb]) => Number(fb.user) - Number(fa.user) || a.localeCompare(b));
for (const [key, label] of MATERIALS) {
  const select = el('select', { id: `mat-${key}` });
  const auto = defaultFilamentFor(bundle, key);
  select.append(
    el('option', { value: '', textContent: `Výchozí (${shortName(auto)})` }),
    ...filamentNames.map(([name, f]) => el('option', { value: name, textContent: shortName(name) + userMark(f) })),
  );
  select.value = bundle.filaments[settings.filamentMap[key]] ? settings.filamentMap[key] : '';
  select.addEventListener('change', save);
  $('materials').append(el('label', { className: 'row' }, el('span', { textContent: label }), select));
}

function shortName(name) {
  return name.replace(/ @[^()]*?nozzle/, '');
}

for (const id of ['enabled', 'keep', 'process']) $(id).addEventListener('change', save);
$('suffix').addEventListener('input', save);

async function save() {
  settings.enabled = $('enabled').checked;
  settings.keepDesignerSettings = $('keep').checked;
  settings.process = $('process').value;
  settings.suffix = $('suffix').value;
  settings.filamentMap = Object.fromEntries(
    MATERIALS.map(([key]) => [key, $(`mat-${key}`).value]).filter(([, v]) => v),
  );
  await saveSettings(settings);
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

async function convertFiles(files) {
  const result = $('result');
  result.hidden = false;
  result.replaceChildren();
  for (const file of files) {
    const box = el('div', { className: 'report' }, el('h3', { textContent: `${file.name} – převádím…` }));
    result.append(box);
    await new Promise((r) => setTimeout(r, 0));
    try {
      const { bytes, report } = convert3mf(new Uint8Array(await file.arrayBuffer()), bundle, settings);
      const filename = report.changed ? outputName(file.name, settings.suffix) : file.name;
      if (report.changed) {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'model/3mf' }));
        const res = await chrome.runtime.sendMessage({ type: 'save', url, filename });
        if (res?.error) throw new Error(res.error);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      box.replaceWith(renderReport(file.name, filename, report));
      await addHistory({ name: file.name, filename, report });
    } catch (e) {
      box.replaceWith(renderError(file.name, e));
      await addHistory({ name: file.name, error: String(e?.message || e) });
    }
  }
  renderHistory();
}

function renderReport(name, filename, report) {
  const title = report.changed ? `✓ ${filename}` : `${name} – beze změny`;
  return el(
    'div',
    { className: 'report' },
    el('h3', { className: report.changed ? 'ok' : '', textContent: title }),
    el(
      'ul',
      {},
      ...report.warnings.map((w) => el('li', { className: 'warn', textContent: w })),
      ...report.notes.map((n) => el('li', { textContent: n })),
    ),
  );
}

function renderError(name, e) {
  return el(
    'div',
    { className: 'report' },
    el('h3', { className: 'err', textContent: `✗ ${name}` }),
    el('p', { textContent: String(e?.message || e) }),
  );
}

// --- history ---------------------------------------------------------------

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  const list = $('history');
  list.replaceChildren();
  if (!history.length) {
    list.append(el('li', { className: 'meta', textContent: 'Zatím nic.' }));
    return;
  }
  for (const h of history) {
    const when = new Date(h.time).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' });
    const status = h.error ? `chyba: ${h.error}` : h.report?.changed ? `→ ${h.filename}` : 'beze změny';
    const warnings = h.report?.warnings?.length ? ` · ⚠ ${h.report.warnings.length}` : '';
    list.append(
      el(
        'li',
        { title: [...(h.report?.warnings || []), ...(h.report?.notes || [])].join('\n') },
        el('div', { textContent: h.name }),
        el('div', { className: 'meta', textContent: `${when} · ${status}${warnings}` }),
      ),
    );
  }
}

renderHistory();
