// Renders a conversion report (notes, warnings and the change list against
// the original file) as DOM. Used by the save dialog.

import { CATEGORIES } from './diff.js';
import { fmt, t } from './i18n.js';

export const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.flat().filter((c) => c !== undefined && c !== null && c !== false));
  return node;
};

const kb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`);
const num = (v) => (Number.isFinite(v) ? String(Math.round(v * 10) / 10) : '?');
const label = (group, key) => t(group)?.[key] ?? key;

function value(v) {
  if (v === undefined) return el('span', { className: 'val none', textContent: '—' });
  if (v === '') return el('span', { className: 'val none', textContent: t('empty') });
  return el('span', { className: 'val', textContent: v, title: v });
}

export function renderReport(report) {
  const d = report.diff;
  const out = el('div', { className: 'report' });

  if (report.warnings.length) {
    out.append(el('section', { className: 'warnings' },
      el('h2', { textContent: t('warnings') }),
      el('ul', {}, report.warnings.map((w) => el('li', { textContent: fmt(w) })))));
  }
  out.append(el('section', {},
    el('h2', { textContent: t('summary') }),
    el('ul', {}, report.notes.map((n) => el('li', { textContent: fmt(n) })))));
  if (!d) return out;

  out.append(filesSection(d.files), modelSection(d), settingsSection(d.settings));
  return out;
}

function filesSection(f) {
  const rows = [
    ...f.changed.map((x) => ['changed', x.name, `${kb(x.before)} → ${kb(x.after)}`]),
    ...f.added.map((x) => ['added', x.name, kb(x.size)]),
    ...f.removed.map((x) => ['removed', x.name, kb(x.size)]),
  ];
  const tagText = { changed: t('fileChanged'), added: t('fileAdded'), removed: t('fileRemoved') };
  return el('section', {},
    el('h2', { textContent: t('filesTitle') }),
    el('p', { className: 'muted', textContent: t('filesSummary', {
      total: f.added.length + f.removed.length + f.changed.length + f.unchanged.length,
      changed: f.changed.length,
      added: f.added.length,
      removed: f.removed.length,
      unchanged: f.unchanged.length,
    }) }),
    rows.length
      ? table(['', t('colFile'), t('colSize')], rows.map(([s, n, k]) => [el('span', { className: `tag ${s}`, textContent: tagText[s] }), n, k]))
      : null,
    f.unchanged.length
      ? details(t('unchangedList', { n: f.unchanged.length }),
        el('ul', { className: 'plain' }, f.unchanged.map((x) => el('li', { textContent: `${x.name} · ${kb(x.size)}` }))))
      : null);
}

function modelSection(d) {
  const { metadata, items, restructured } = d.model;
  const moved = items.filter((i) => i.moved || i.rotated || !i.from);
  const parts = [el('h2', { textContent: t('modelTitle') })];
  if (restructured) parts.push(el('p', { className: 'muted', textContent: t('restructured') }));
  if (metadata.length) {
    parts.push(table([t('colHeader'), t('colOriginal'), t('colConverted')], metadata.map((m) => [m.key, value(m.before), value(m.after)])));
  }
  if (items.length) {
    parts.push(el('p', { className: 'muted', textContent: moved.length
      ? t('placementMoved', { moved: moved.length, total: items.length })
      : t('placementKept', { n: items.length }) }));
    if (moved.length) {
      parts.push(table(['#', t('colOriginalXY'), t('colNewXY'), ''], moved.slice(0, 200).map((i) => [
        String(i.index),
        i.from ? `${num(i.from[0])}, ${num(i.from[1])}` : '—',
        `${num(i.to[0])}, ${num(i.to[1])}`,
        i.rotated ? t('rotated90') : '',
      ])));
    }
  }
  if (d.sliceInfo) {
    const keys = [...new Set([...Object.keys(d.sliceInfo.before), ...Object.keys(d.sliceInfo.after)])];
    parts.push(table(['slice_info.config', t('colOriginal'), t('colConverted')],
      keys.map((k) => [k, value(d.sliceInfo.before[k]), value(d.sliceInfo.after[k])])));
  }
  return el('section', {}, parts);
}

function settingsSection(s) {
  const counts = el('div', { className: 'chips' });
  const section = el('section', {},
    el('h2', { textContent: t('settingsTitle') }),
    el('p', { className: 'muted', textContent: t('settingsSummary', {
      before: s.countBefore, after: s.countAfter, changed: s.changed.length, same: s.same.length,
      removed: s.removed.length, added: s.added.length,
    }) }),
    counts,
    table(['', t('colSetting'), t('colOriginal'), t('colConverted')], s.highlights.map((h) => [
      el('span', { className: h.same ? 'mark same' : 'mark diff', textContent: h.same ? '=' : '≠', title: t(h.same ? 'same' : 'changed') }),
      el('span', { textContent: label('highlights', h.key), title: h.key }),
      value(h.before),
      value(h.after),
    ]), 'highlights'));

  for (const id of CATEGORIES) {
    const rows = s.changed.filter((c) => c.category === id);
    if (!rows.length) continue;
    const name = label('categories', id);
    counts.append(el('span', { className: 'chip', textContent: `${name}: ${rows.length}` }));
    section.append(details(t('categoryChanged', { label: name, n: rows.length }),
      table([t('colKey'), t('colOriginal'), t('colConverted')], rows.map((r) => [el('code', { textContent: r.key }), value(r.before), value(r.after)]))));
  }
  if (s.removed.length) {
    section.append(details(t('removedKeys', { n: s.removed.length }),
      table([t('colKey'), t('colOriginalValue')], s.removed.map((r) => [el('code', { textContent: r.key }), value(r.before)]))));
  }
  if (s.added.length) {
    section.append(details(t('addedKeys', { n: s.added.length }),
      table([t('colKey'), t('colValue')], s.added.map((r) => [el('code', { textContent: r.key }), value(r.after)]))));
  }
  if (s.same.length) {
    section.append(details(t('unchangedKeys', { n: s.same.length }), el('p', { className: 'keys', textContent: s.same.join(', ') })));
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
