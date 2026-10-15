// Renders a conversion report (notes, warnings and the change list against
// the original file) as DOM. Used by the save dialog.

import { CATEGORIES } from './diff.js';

export const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.flat().filter((c) => c !== undefined && c !== null && c !== false));
  return node;
};

const kb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`);
const value = (v) => el('span', { className: v === undefined ? 'val none' : 'val', textContent: v ?? '—', title: v ?? '' });
const num = (v) => (Number.isFinite(v) ? String(Math.round(v * 10) / 10) : '?');

export function renderReport(report) {
  const d = report.diff;
  const out = el('div', { className: 'report' });

  if (report.warnings.length) {
    out.append(el('section', { className: 'warnings' },
      el('h2', { textContent: 'Upozornění' }),
      el('ul', {}, report.warnings.map((w) => el('li', { textContent: w })))));
  }
  out.append(el('section', {},
    el('h2', { textContent: 'Shrnutí' }),
    el('ul', {}, report.notes.map((n) => el('li', { textContent: n })))));
  if (!d) return out;

  out.append(filesSection(d.files));
  out.append(modelSection(d));
  out.append(settingsSection(d.settings));
  return out;
}

function filesSection(f) {
  const total = f.added.length + f.removed.length + f.changed.length + f.unchanged.length;
  const rows = [
    ...f.changed.map((x) => ['změněn', x.name, `${kb(x.before)} → ${kb(x.after)}`]),
    ...f.added.map((x) => ['přidán', x.name, kb(x.size)]),
    ...f.removed.map((x) => ['odebrán', x.name, kb(x.size)]),
  ];
  return el('section', {},
    el('h2', { textContent: 'Soubory v archivu' }),
    el('p', { className: 'muted', textContent:
      `${total} souborů: ${f.changed.length} změněno, ${f.added.length} přidáno, ${f.removed.length} odebráno, ` +
      `${f.unchanged.length} beze změny (geometrie, obrázky a ostatní zůstaly do bajtu stejné).` }),
    rows.length ? table(['', 'Soubor', 'Velikost'], rows.map(([s, n, k]) => [el('span', { className: `tag ${s}`, textContent: s }), n, k])) : null,
    f.unchanged.length ? details(`Beze změny (${f.unchanged.length})`,
      el('ul', { className: 'plain' }, f.unchanged.map((x) => el('li', { textContent: `${x.name} · ${kb(x.size)}` })))) : null);
}

function modelSection(d) {
  const { metadata, items, restructured } = d.model;
  const moved = items.filter((i) => i.moved || i.rotated || !i.from);
  const parts = [el('h2', { textContent: 'Model (3D/3dmodel.model)' })];
  if (restructured) parts.push(el('p', { className: 'muted', textContent: 'Struktura modelu přestavěna do formátu QIDI Studia (díly a jejich nastavení v Metadata/model_settings.config).' }));
  if (metadata.length) parts.push(table(['Hlavička', 'Původní', 'Převedený'], metadata.map((m) => [m.key, value(m.before), value(m.after)])));
  if (items.length) {
    parts.push(el('p', { className: 'muted', textContent: moved.length
      ? `Umístění: ${moved.length} z ${items.length} objektů přesunuto nebo otočeno.`
      : `Umístění: ${items.length} ${items.length === 1 ? 'objekt zůstal' : 'objektů zůstalo'} na místě (vejde se na podložku).` }));
    if (moved.length) {
      parts.push(table(['#', 'Původní X, Y', 'Nové X, Y', ''], moved.slice(0, 200).map((i) => [
        String(i.index),
        i.from ? `${num(i.from[0])}, ${num(i.from[1])}` : '—',
        `${num(i.to[0])}, ${num(i.to[1])}`,
        i.rotated ? 'otočen 90°' : '',
      ])));
    }
  }
  if (d.sliceInfo) {
    const keys = [...new Set([...Object.keys(d.sliceInfo.before), ...Object.keys(d.sliceInfo.after)])];
    parts.push(table(['slice_info.config', 'Původní', 'Převedený'], keys.map((k) => [k, value(d.sliceInfo.before[k]), value(d.sliceInfo.after[k])])));
  }
  return el('section', {}, parts);
}

function settingsSection(s) {
  const section = el('section', {},
    el('h2', { textContent: 'Nastavení projektu (project_settings.config)' }),
    el('p', { className: 'muted', textContent:
      `${s.countBefore} → ${s.countAfter} klíčů: ${s.changed.length} změněno, ${s.same.length} beze změny, ` +
      `${s.removed.length} odebráno, ${s.added.length} přidáno.` }),
    table(['', 'Nastavení', 'Původní', 'Převedený'], s.highlights.map((h) => [
      el('span', { className: h.same ? 'mark same' : 'mark diff', textContent: h.same ? '=' : '≠', title: h.same ? 'beze změny' : 'změněno' }),
      el('span', { textContent: h.label, title: h.key }),
      value(h.before),
      value(h.after),
    ]), 'highlights'));

  const counts = el('div', { className: 'chips' });
  for (const [id, label] of CATEGORIES) {
    const rows = s.changed.filter((c) => c.category === id);
    if (!rows.length) continue;
    counts.append(el('span', { className: 'chip', textContent: `${label}: ${rows.length}` }));
    section.append(details(`${label} – změněno ${rows.length}`,
      table(['Klíč', 'Původní', 'Převedený'], rows.map((r) => [el('code', { textContent: r.key }), value(r.before), value(r.after)]))));
  }
  section.insertBefore(counts, section.children[2]);
  if (s.removed.length) {
    section.append(details(`Odebráno – QIDI Studio nezná (${s.removed.length})`,
      table(['Klíč', 'Původní hodnota'], s.removed.map((r) => [el('code', { textContent: r.key }), value(r.before)]))));
  }
  if (s.added.length) {
    section.append(details(`Přidáno z QIDI profilů (${s.added.length})`,
      table(['Klíč', 'Hodnota'], s.added.map((r) => [el('code', { textContent: r.key }), value(r.after)]))));
  }
  if (s.same.length) {
    section.append(details(`Beze změny (${s.same.length})`, el('p', { className: 'keys', textContent: s.same.join(', ') })));
  }
  return section;
}

function table(head, rows, className = '') {
  return el('div', { className: 'table-wrap' }, el('table', { className },
    el('thead', {}, el('tr', {}, head.map((h) => el('th', { textContent: h })))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, typeof c === 'string' ? document.createTextNode(c) : c)))))));
}

function details(summary, body) {
  return el('details', {}, el('summary', { textContent: summary }), body);
}
