// Rewrites the model part of a PrusaSlicer 3MF into the layout QIDI Studio
// (a Bambu Studio fork) writes itself: one sub-model file per object, every
// volume a separate mesh, settings and part types in model_settings.config.

import { strFromU8, strToU8 } from '../vendor/fflate.js';
import { mapPrusaSettings } from './prusa.js';
import { LocalizedError, msg } from './i18n.js';
import { emptyBounds, extendBounds, placeBox, rotate90About, multiply, fitShift, usableAreas } from './layout.js';

const PART_TYPES = {
  ModelPart: 'normal_part',
  ParameterModifier: 'modifier_part',
  NegativeVolume: 'negative_part',
  SupportEnforcer: 'support_enforcer',
  SupportBlocker: 'support_blocker',
};

// PrusaSlicer and Bambu-based slicers serialise painted facets the same way,
// only the attribute names differ.
const PAINT_ATTRS = {
  'slic3rpe:mmu_segmentation': 'paint_color',
  'slic3rpe:custom_supports': 'paint_supports',
  'slic3rpe:custom_seam': 'paint_seam',
};

const IDENTITY_4x4 = '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1';
const IDENTITY_3x4 = '1 0 0 0 1 0 0 0 1 0 0 0';
const NS_CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const NS_PROD = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const NS_QIDI = 'http://schemas.qiditech.com/package/2021';
const REL_MODEL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';

export function restructurePrusaModel(files, { oldBed, newBed, app, project, report }) {
  const modelXml = strFromU8(files['3D/3dmodel.model']);
  const modelConfig = files['Metadata/Slic3r_PE_model.config'] ? strFromU8(files['Metadata/Slic3r_PE_model.config']) : '';
  const objects = parseObjects(modelXml);
  const configs = parseModelConfig(modelConfig);
  const items = [...modelXml.matchAll(/<item\b([^>]*)\/?>/g)].map((m) => ({
    objectId: attr(m[1], 'objectid'),
    transform: (attr(m[1], 'transform') || IDENTITY_3x4).trim().split(/\s+/).map(Number),
    printable: attr(m[1], 'printable') ?? '1',
  }));

  if (!objects.size || objects.has(null)) throw new LocalizedError('errUnsupportedPrusa');

  // Main model object ids and sub-model mesh ids, numbered like QIDI does.
  let nextId = 1;
  const converted = [];
  const subFiles = {};
  for (const [id, obj] of objects) {
    const cfg = configs.get(id) || { meta: {}, volumes: [] };
    const volumes = cfg.volumes.length
      ? cfg.volumes
      : [{ first: 0, last: obj.triangles.length - 1, meta: { name: cfg.meta.name || `Object_${id}` } }];
    const parts = volumes.map((v) => ({ ...v, subId: nextId++ }));
    const mainId = nextId++;
    const fileName = `3D/Objects/object_${converted.length + 1}.model`;
    subFiles[fileName] = subModel(obj, parts);
    converted.push({ srcId: id, mainId, fileName, parts, meta: cfg.meta, solid: solidVertices(obj, parts) });
  }

  // Place everything on the new bed: keep the layout, move it into the
  // usable area, warn if it does not fit.
  const byId = new Map(converted.map((c) => [c.srcId, c]));
  const all = emptyBounds();
  for (const it of items) {
    const c = byId.get(it.objectId);
    if (c) extendBounds(all, c.solid, it.transform);
  }
  let dx = (newBed.w - oldBed.w) / 2 + newBed.x0 - oldBed.x0;
  let dy = (newBed.d - oldBed.d) / 2 + newBed.y0 - oldBed.y0;
  let rotation;
  if (Number.isFinite(all[0])) {
    // Work in new-bed coordinates (both slicers' beds start at their origin).
    // Keep the layout where it was relative to the bed centre, then make it fit.
    const cx = (newBed.w - oldBed.w) / 2 + newBed.x0 - oldBed.x0;
    const cy = (newBed.d - oldBed.d) / 2 + newBed.y0 - oldBed.y0;
    const local = [all[0] + cx - newBed.x0, all[1] + cy - newBed.y0, all[2] + cx - newBed.x0, all[3] + cy - newBed.y0];
    const place = placeBox(local, newBed);
    if (place) {
      dx = cx + place.shift.x;
      dy = cy + place.shift.y;
      if (place.rotated) {
        rotation = rotate90About(place.center.x - cx + newBed.x0, place.center.y - cy + newBed.y0);
        report.notes.push(msg('noteLayoutRotated'));
      }
      if (place.inExcluded) report.warnings.push(msg('warnExcluded'));
    } else {
      const shift = fitShift(local, usableAreas(newBed)[1]);
      dx = cx + shift.x;
      dy = cy + shift.y;
      report.warnings.push(msg('warnTooBig', {
        w: Math.round(all[2] - all[0]), d: Math.round(all[3] - all[1]), bw: newBed.w, bd: newBed.d,
      }));
    }
  }

  const instanceCount = new Map();
  const build = items.map((it, i) => {
    const c = byId.get(it.objectId);
    if (!c) return '';
    const k = instanceCount.get(c.mainId) ?? 0;
    instanceCount.set(c.mainId, k + 1);
    const t = rotation ? multiply(it.transform, rotation) : [...it.transform];
    t[9] += dx;
    t[10] += dy;
    return `  <item objectid="${c.mainId}" p:UUID="${uuid(0xb1ec, i + 1)}" transform="${t.map(fmt).join(' ')}" printable="${it.printable}"/>\n`;
  });

  const metadata = [...modelXml.matchAll(/<metadata name="([^"]+)">([^<]*)<\/metadata>/g)]
    .filter(([, name]) => !/^(Application|slic3rpe:.*|BambuStudio:.*|QIDIStudio:.*)$/.test(name))
    .map(([, name, value]) => [name, value]);
  metadata.push(['Application', app], ['QIDIStudio:3mfVersion', '1']);
  metadata.sort(([a], [b]) => a.localeCompare(b));

  const resources = converted.map((c, i) =>
    `  <object id="${c.mainId}" p:UUID="${uuid(0x61cb, i + 1)}" type="model">\n   <components>\n` +
    c.parts.map((p, j) =>
      `    <component p:path="/${c.fileName}" objectid="${p.subId}" p:UUID="${uuid(0x0001 + j, i + 1)}" transform="${IDENTITY_3x4}"/>\n`).join('') +
    '   </components>\n  </object>\n');

  files['3D/3dmodel.model'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<model unit="millimeter" xml:lang="en-US" xmlns="${NS_CORE}" xmlns:QIDIStudio="${NS_QIDI}" xmlns:p="${NS_PROD}" requiredextensions="p">\n` +
      metadata.map(([n, v]) => ` <metadata name="${n}">${v}</metadata>\n`).join('') +
      ' <resources>\n' + resources.join('') + ' </resources>\n' +
      ` <build p:UUID="${uuid(0x2c7c, 0)}">\n` + build.join('') + ' </build>\n</model>\n',
  );
  Object.assign(files, subFiles);
  files['3D/_rels/3dmodel.model.rels'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
      converted.map((c, i) => ` <Relationship Target="/${c.fileName}" Id="rel-${i + 1}" Type="${REL_MODEL}"/>\n`).join('') +
      '</Relationships>\n',
  );
  files['Metadata/model_settings.config'] = strToU8(modelSettings(converted, items, byId, project, report));

  for (const name of Object.keys(files)) {
    if (/^Metadata\/(Slic3r_PE.*|Prusa_Slicer_.*)\.(config|txt|xml)$/i.test(name)) delete files[name];
  }
  report.notes.push(msg('notePrusaRebuilt', { objects: converted.length, instances: items.length }));
}

function parseObjects(xml) {
  const out = new Map();
  for (const m of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = attr(m[1], 'id');
    if (!m[2].includes('<mesh')) {
      out.set(null, null);
      continue;
    }
    const vertices = [];
    for (const v of m[2].matchAll(/<vertex\b([^>]*)\/>/g)) {
      vertices.push([Number(attr(v[1], 'x')), Number(attr(v[1], 'y')), Number(attr(v[1], 'z'))]);
    }
    const triangles = [];
    for (const t of m[2].matchAll(/<triangle\b([^>]*)\/>/g)) {
      const paint = [];
      for (const [from, to] of Object.entries(PAINT_ATTRS)) {
        const value = attr(t[1], from);
        if (value) paint.push(`${to}="${value}"`);
      }
      triangles.push({ v: [Number(attr(t[1], 'v1')), Number(attr(t[1], 'v2')), Number(attr(t[1], 'v3'))], paint });
    }
    out.set(id, { vertices, triangles });
  }
  return out;
}

function parseModelConfig(xml) {
  const out = new Map();
  for (const m of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = attr(m[1], 'id');
    const body = m[2];
    const volumes = [];
    for (const v of body.matchAll(/<volume\b([^>]*)>([\s\S]*?)<\/volume>/g)) {
      volumes.push({ first: Number(attr(v[1], 'firstid')), last: Number(attr(v[1], 'lastid')), meta: metas(v[2]) });
    }
    const objectBody = body.replace(/<volume\b[\s\S]*?<\/volume>/g, '');
    out.set(id, { meta: metas(objectBody), volumes });
  }
  return out;
}

function metas(xml) {
  const out = {};
  for (const m of xml.matchAll(/<metadata\b([^>]*)\/>/g)) {
    const key = attr(m[1], 'key');
    if (key) out[key] = attr(m[1], 'value') ?? '';
  }
  return out;
}

function subModel(obj, parts) {
  const chunks = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    `<model unit="millimeter" xml:lang="en-US" xmlns="${NS_CORE}" xmlns:QIDIStudio="${NS_QIDI}" xmlns:p="${NS_PROD}" requiredextensions="p">\n`,
    ' <metadata name="QIDIStudio:3mfVersion">1</metadata>\n <resources>\n',
  ];
  parts.forEach((part, i) => {
    const remap = new Map();
    const verts = [];
    const tris = [];
    for (let t = part.first; t <= part.last && t < obj.triangles.length; t++) {
      const tri = obj.triangles[t];
      const idx = tri.v.map((v) => {
        if (!remap.has(v)) {
          remap.set(v, verts.length);
          verts.push(obj.vertices[v]);
        }
        return remap.get(v);
      });
      tris.push(`     <triangle v1="${idx[0]}" v2="${idx[1]}" v3="${idx[2]}"${tri.paint.length ? ' ' + tri.paint.join(' ') : ''}/>\n`);
    }
    chunks.push(
      `  <object id="${part.subId}" p:UUID="${uuid(0x81cb, i + 1)}" type="model">\n   <mesh>\n    <vertices>\n`,
      verts.map((v) => `     <vertex x="${fmt(v[0])}" y="${fmt(v[1])}" z="${fmt(v[2])}"/>\n`).join(''),
      '    </vertices>\n    <triangles>\n',
      tris.join(''),
      '    </triangles>\n   </mesh>\n  </object>\n',
    );
  });
  chunks.push(' </resources>\n <build/>\n</model>\n');
  return strToU8(chunks.join(''));
}

function modelSettings(converted, items, byId, project, report) {
  const unknown = new Set();
  const settingLines = (meta, indent) => {
    const settings = Object.fromEntries(Object.entries(meta).filter(([k]) => !KNOWN_META.has(k)));
    for (const [k, v] of Object.entries(settings)) {
      if (!Object.keys(mapPrusaSettings({ [k]: v })).length) unknown.add(k);
    }
    return Object.entries(mapPrusaSettings(settings))
      .filter(([k]) => k in project)
      .map(([k, v]) => `${indent}<metadata key="${k}" value="${esc(v)}"/>\n`)
      .join('');
  };

  const out = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n'];
  for (const c of converted) {
    const name = c.meta.name || c.parts[0]?.meta.name || `Object_${c.srcId}`;
    out.push(
      `  <object id="${c.mainId}">\n`,
      `    <metadata key="name" value="${esc(name)}"/>\n`,
      `    <metadata key="extruder" value="${esc(c.meta.extruder && c.meta.extruder !== '0' ? c.meta.extruder : '1')}"/>\n`,
      settingLines(c.meta, '    '),
    );
    for (const p of c.parts) {
      const type = PART_TYPES[p.meta.volume_type] || 'normal_part';
      out.push(
        `    <part id="${p.subId}" subtype="${type}">\n`,
        `      <metadata key="name" value="${esc(p.meta.name || name)}"/>\n`,
        `      <metadata key="matrix" value="${IDENTITY_4x4}"/>\n`,
        p.meta.extruder && p.meta.extruder !== '0' ? `      <metadata key="extruder" value="${esc(p.meta.extruder)}"/>\n` : '',
        settingLines(p.meta, '      '),
        '    </part>\n',
      );
    }
    out.push('  </object>\n');
  }
  out.push(
    '  <plate>\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n' +
      '    <metadata key="locked" value="false"/>\n',
  );
  const seen = new Map();
  for (const it of items) {
    const c = byId.get(it.objectId);
    if (!c) continue;
    const k = seen.get(c.mainId) ?? 0;
    seen.set(c.mainId, k + 1);
    out.push(
      `    <model_instance>\n      <metadata key="object_id" value="${c.mainId}"/>\n` +
        `      <metadata key="instance_id" value="${k}"/>\n    </model_instance>\n`,
    );
  }
  out.push('  </plate>\n</config>\n');
  if (unknown.size) report.warnings.push(msg('warnUnmappedObjectSettings', { keys: [...unknown].join(', ') }));
  return out.join('');
}

const KNOWN_META = new Set([
  'name', 'extruder', 'volume_type', 'matrix', 'source_file', 'source_object_id', 'source_volume_id',
  'source_offset_x', 'source_offset_y', 'source_offset_z', 'source_in_inches', 'source_in_meters',
  'mesh_stat', 'modifier', 'text_data',
]);

// Vertices of the printable parts (modifiers and blockers do not take space).
function solidVertices(obj, parts) {
  const used = new Set();
  for (const p of parts) {
    if (p.meta.volume_type && p.meta.volume_type !== 'ModelPart') continue;
    for (let t = p.first; t <= p.last && t < obj.triangles.length; t++) for (const v of obj.triangles[t].v) used.add(v);
  }
  const out = new Float64Array(used.size * 3);
  let i = 0;
  for (const v of used) out.set(obj.vertices[v], (i++) * 3);
  return out;
}

function attr(s, name) {
  const re = new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}="([^"]*)"`);
  return s.match(re)?.[1];
}

function uuid(group, n) {
  const hex = (v, len) => (v >>> 0).toString(16).padStart(len, '0').slice(-len);
  return `${hex(n, 8)}-${hex(group, 4)}-4c03-9d28-80fed5dfa1dc`;
}

function fmt(v) {
  if (Math.abs(v) < 1e-12) return '0';
  return String(Number(Number(v).toPrecision(9)));
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
