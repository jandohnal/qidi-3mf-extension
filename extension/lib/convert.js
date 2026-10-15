// Converts 3MF projects from MakerWorld (Bambu Studio) and Printables
// (PrusaSlicer) into QIDI Studio projects for the printer in the profile bundle.
// Runs in the extension service worker (no DOM) and in Node for tests.

import { unzipSync, zipSync, strFromU8, strToU8 } from '../vendor/fflate.js';
import { convertPrusaConfig } from './prusa.js';
import { restructurePrusaModel } from './prusa-model.js';
import { PORTABLE_PROCESS_KEYS } from './portable.js';
import { diffProjects } from './diff.js';
import {
  PLATE_GAP, bambuObjectMeshes, bedSize, emptyBounds, exclusionRects, extendBounds, fitShift, formatNumber,
  multiply, overlaps, parseMatrix, placeBox, plateColumns, rotate90About, usableAreas,
} from './layout.js';

export { PORTABLE_PROCESS_KEYS };

const QIDI_PREFIX = 'QIDIStudio';

export function convert3mf(input, bundle, options = {}) {
  const files = unzipSync(input instanceof Uint8Array ? input : new Uint8Array(input));
  const original = { ...files };
  const report = { source: 'unknown', sourcePrinter: '', changed: false, notes: [], warnings: [] };
  const app = readApplication(files);

  if (files['Metadata/project_settings.config']) {
    const src = JSON.parse(strFromU8(files['Metadata/project_settings.config']));
    report.sourcePrinter = src.printer_settings_id || src.printer_model || '';
    report.source = app.startsWith(QIDI_PREFIX) ? 'qidi' : app.startsWith('Orca') ? 'orca' : 'bambu';
    if (report.source === 'qidi' && report.sourcePrinter === bundle.printer.name && !options.force) {
      report.notes.push(`Už je to projekt QIDI Studia pro ${bundle.printer.name}, beze změny.`);
      return { bytes: input, report };
    }
    convertBambuFamily(files, src, bundle, options, report);
  } else if (files['Metadata/Slic3r_PE.config']) {
    report.source = 'prusa';
    const ini = parseIni(strFromU8(files['Metadata/Slic3r_PE.config']));
    report.sourcePrinter = ini.printer_settings_id || ini.printer_model || '';
    convertPrusa(files, ini, bundle, options, report);
  } else {
    report.source = 'plain';
    report.notes.push('3MF neobsahuje nastavení sliceru, QIDI Studio ho otevře s aktuálními profily. Beze změny.');
    return { bytes: input, report };
  }

  report.changed = true;
  report.diff = diffProjects(original, files, report.source);
  const size = Object.values(files).reduce((n, f) => n + f.length, 0);
  return { bytes: zipSync(files, { level: size > 100e6 ? 1 : 6 }), report };
}

// ---------------------------------------------------------------------------
// Bambu Studio / Orca / QIDI (other printer) projects

function convertBambuFamily(files, src, bundle, options, report) {
  const filamentCount = Math.max(1, (src.filament_settings_id || src.filament_colour || ['']).length);
  const sourceFilaments = Array.from({ length: filamentCount }, (_, i) => ({
    type: at(src.filament_type, i) || 'PLA',
    name: at(src.filament_settings_id, i) || '',
    colour: at(src.filament_colour, i) || '#FFFFFF',
  }));

  const overlay = options.keepDesignerSettings === false ? {} : pickPortable(src);
  const project = buildProject(bundle, {
    process: chooseProcess(bundle, options, overlay.layer_height ?? src.layer_height),
    filaments: sourceFilaments.map((f) => chooseFilament(bundle, options, f)),
    colours: sourceFilaments.map((f) => f.colour),
    overlay,
    report,
  });

  // Per-filament values that describe the model rather than the material.
  copyIfShape(project, src, 'filament_multi_colour', filamentCount);
  copyIfShape(project, src, 'filament_colour_type', filamentCount);
  copyIfShape(project, src, 'flush_volumes_matrix', filamentCount * filamentCount);
  if (Array.isArray(src.flush_multiplier) && src.flush_multiplier.length === project.flush_multiplier?.length) {
    project.flush_multiplier = src.flush_multiplier;
  }

  relocatePlates(files, src, project, report);
  files['Metadata/project_settings.config'] = strToU8(JSON.stringify(project, null, 4));
  cleanModelSettings(files, project, report);
  rewriteModelMetadata(files, bundle);
  rewriteSliceInfo(files, bundle);
  dropSlicerArtifacts(files, report);

  report.notes.push(
    `Tiskárna ${report.sourcePrinter || '?'} → ${bundle.printer.name}`,
    `Proces: ${project.print_settings_id}`,
    `Filamenty: ${project.filament_settings_id.join(', ')}`,
  );
  noteApplied(report);
}

function noteApplied(report) {
  if (report.applied?.length) {
    report.notes.push(`Převzato od autora (odlišné od profilu): ${report.applied.join(', ')}`);
  }
}

// Only what the designer changed against their own process preset (Bambu
// Studio records it in different_settings_to_system), plus the layer height.
function pickPortable(src) {
  const changed = new Set(String(at(src.different_settings_to_system, 0) ?? '').split(';').filter(Boolean));
  changed.add('layer_height');
  const out = {};
  for (const k of PORTABLE_PROCESS_KEYS) if (src[k] !== undefined && changed.has(k)) out[k] = src[k];
  return out;
}

// ---------------------------------------------------------------------------
// PrusaSlicer projects (Printables)

function convertPrusa(files, ini, bundle, options, report) {
  const { overlay, filaments: sourceFilaments } = convertPrusaConfig(ini);
  const keep = options.keepDesignerSettings === false ? {} : overlay;
  const project = buildProject(bundle, {
    process: chooseProcess(bundle, options, keep.layer_height ?? ini.layer_height),
    filaments: sourceFilaments.map((f) => chooseFilament(bundle, options, f)),
    colours: sourceFilaments.map((f) => f.colour),
    overlay: keep,
    report,
  });

  files['Metadata/project_settings.config'] = strToU8(JSON.stringify(project, null, 4));
  const newBed = { ...bedSize(project.printable_area), exclude: project.bed_exclude_area };
  restructurePrusaModel(files, {
    oldBed: bedSize(String(ini.bed_shape || '').split(',').filter(Boolean)),
    newBed,
    app: `${QIDI_PREFIX}-${bundle.slicerVersion}`,
    project,
    report,
  });
  rewriteSliceInfo(files, bundle);
  report.notes.push(
    `Tiskárna ${report.sourcePrinter || '?'} → ${bundle.printer.name}`,
    `Proces: ${project.print_settings_id}`,
    `Filamenty: ${project.filament_settings_id.join(', ')}`,
  );
  noteApplied(report);
}

// ---------------------------------------------------------------------------
// Project config assembly

// Chosen in the QIDI Studio GUI rather than by presets.
const KEEP_FROM_TEMPLATE = new Set(['seal', 'curr_bed_type', 'host_type', 'print_host', 'printhost_apikey']);

function conformTo(target, value) {
  if (Array.isArray(target) && !Array.isArray(value)) return [String(value)];
  if (!Array.isArray(target) && Array.isArray(value)) return value.length === 1 ? String(value[0]) : value.join(',');
  if (typeof target === 'string' && target.endsWith('%') && /^-?\d+(\.\d+)?$/.test(String(value))) return `${value}%`;
  return structuredClone(value);
}

export function buildProject(bundle, { process, filaments, colours, overlay = {}, report }) {
  const allowed = new Set(bundle.projectKeys);
  const filamentKeys = new Set(bundle.filamentKeys);
  const project = structuredClone(bundle.template);

  // Preset files and saved projects sometimes serialise the same option
  // differently (array vs. comma separated string); follow the template.
  const put = (k, v) => {
    if (KEEP_FROM_TEMPLATE.has(k) || !(allowed.has(k) || k in project)) return;
    project[k] = k in project ? conformTo(project[k], v) : structuredClone(v);
  };

  for (const [k, v] of Object.entries(bundle.printer.settings)) put(k, v);
  for (const [k, v] of Object.entries(process.settings)) if (!filamentKeys.has(k)) put(k, v);

  // Per-filament arrays: concatenate each filament preset's values.
  const templateFilaments = Math.max(1, bundle.template.filament_settings_id?.length ?? 1);
  const presetFilaments = filaments.map((f) => f.preset.settings);
  for (const k of filamentKeys) {
    const current = project[k];
    if (!allowed.has(k) && current === undefined) continue;
    if (current !== undefined && !Array.isArray(current)) {
      // Scalar in projects (e.g. filament_notes): first filament wins.
      if (presetFilaments[0][k] !== undefined) project[k] = conformTo(current, presetFilaments[0][k]);
      continue;
    }
    const unit = current ? current.slice(0, Math.max(1, current.length / templateFilaments)) : [];
    const parts = presetFilaments.map((s) => {
      const v = s[k];
      if (v === undefined) return unit;
      return Array.isArray(v) ? v : [v];
    });
    if (parts.every((p) => p.length === 0)) continue;
    project[k] = parts.flat().map(String);
  }

  const n = filaments.length;
  project.filament_colour = colours.slice(0, n);
  project.filament_multi_colour = colours.slice(0, n);
  project.filament_settings_id = filaments.map((f) => f.name);
  project.filament_ids = filaments.map((f) => String(f.preset.settings.filament_id ?? at(project.filament_ids, 0) ?? ''));
  project.filament_self_index = filaments.map((_, i) => String(i + 1));
  project.filament_map = filaments.map(() => '1');
  if (Array.isArray(project.flush_volumes_matrix)) {
    project.flush_volumes_matrix = Array.from({ length: n * n }, (_, i) =>
      Math.floor(i / n) === i % n ? '0' : String(at(project.flush_volumes_vector, 0) ?? '140'));
  }

  // Designer settings on top of the chosen process.
  const applied = [];
  for (const [k, v] of Object.entries(overlay)) {
    if (!(k in project)) continue;
    const shaped = shapeLike(project[k], v);
    if (shaped === undefined || JSON.stringify(shaped) === JSON.stringify(project[k])) continue;
    project[k] = shaped;
    applied.push(k);
  }
  for (const k of ['support_filament', 'support_interface_filament', 'wall_filament', 'sparse_infill_filament', 'solid_infill_filament']) {
    if (Number(project[k]) > n) project[k] = '0';
  }

  const processDiff = diffKeys(process, bundle.processes, 'process').concat(applied);
  project.print_settings_id = process.name;
  project.printer_settings_id = bundle.printer.name;
  project.default_print_profile = bundle.printer.settings.default_print_profile ?? project.default_print_profile;
  project.print_compatible_printers = [bundle.printer.name];
  project.upward_compatible_machine = [];
  project.inherits_group = [process.inherits, ...filaments.map((f) => f.inherits), bundle.printer.inherits || ''];
  project.different_settings_to_system = [
    [...new Set(processDiff)].sort().join(';'),
    ...filaments.map((f) => diffKeys(f, bundle.filaments, 'filament').sort().join(';')),
    '',
  ];
  project.name = 'project_settings';
  project.from = 'project';
  project.version = bundle.slicerVersion;

  if (report && applied.length) report.applied = applied;
  return project;
}

function diffKeys(entry, collection) {
  if (!entry.inherits) return [];
  const parent = collection[entry.inherits];
  if (!parent) return [];
  return Object.keys(entry.preset.settings).filter(
    (k) => JSON.stringify(entry.preset.settings[k]) !== JSON.stringify(parent.settings[k]),
  );
}

function shapeLike(target, value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(target)) {
    const arr = Array.isArray(value) ? value : [value];
    if (arr.length === target.length) return arr.map(String);
    if (arr.length > 0) return target.map((_, i) => String(arr[Math.min(i, arr.length - 1)]));
    return undefined;
  }
  return String(Array.isArray(value) ? value[0] : value);
}

function copyIfShape(project, src, key, length) {
  if (Array.isArray(src[key]) && src[key].length === length && key in project) project[key] = src[key];
}

// ---------------------------------------------------------------------------
// Preset selection

export function chooseProcess(bundle, options, layerHeight) {
  let name = options.process && options.process !== 'auto' ? options.process : undefined;
  if (!name || !bundle.processes[name]) name = autoProcess(bundle, layerHeight);
  const p = bundle.processes[name];
  return { name, inherits: p.inherits || '', preset: p, settings: p.settings };
}

function autoProcess(bundle, layerHeight) {
  const lh = Number(Array.isArray(layerHeight) ? layerHeight[0] : layerHeight);
  const fallback = bundle.defaults.process;
  if (!lh) return fallback;
  const preference = ['Standard', 'Optimal', 'Fine', 'Draft', 'Extra Draft', 'High Quality', 'Extra Fine'];
  const candidates = Object.entries(bundle.processes)
    .filter(([, p]) => !p.user)
    .map(([name, p]) => ({ name, lh: Number(p.settings.layer_height) }))
    .filter((c) => c.lh);
  if (!candidates.length) return fallback;
  const best = Math.min(...candidates.map((c) => Math.abs(c.lh - lh)));
  const close = candidates.filter((c) => Math.abs(c.lh - lh) === best);
  const rank = (n) => {
    const i = preference.findIndex((p) => n.includes(` ${p} @`));
    return i < 0 ? preference.length : i;
  };
  close.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  return close[0].name;
}

// Normalised material family used as the key of the filament mapping.
export function materialKey(type, name = '') {
  const t = String(type || '').toUpperCase().replace(/\s+/g, '');
  if (/SILK/i.test(name) && t.startsWith('PLA')) return 'PLA-SILK';
  if (t.startsWith('PLA')) return t.includes('CF') ? 'PLA-CF' : 'PLA';
  if (t.startsWith('PETG') || t === 'PET') return t.includes('CF') ? 'PETG-CF' : 'PETG';
  if (t.startsWith('ABS')) return 'ABS';
  if (t.startsWith('ASA')) return 'ASA';
  if (t.startsWith('TPU') || t.startsWith('FLEX') || t === 'PEBA') return 'TPU';
  if (t.startsWith('PC')) return 'PC';
  if (t.startsWith('PA') || t.startsWith('NYLON')) return 'PA';
  if (t === 'PVA' || t.includes('SUPPORT') || t === 'HIPS') return 'SUPPORT';
  return t || 'PLA';
}

export function defaultFilamentFor(bundle, key) {
  const entries = Object.entries(bundle.filaments).filter(([, f]) => !f.user);
  const typeOf = (f) => materialKey(at(f.settings.filament_type, 0), '');
  const matches = entries.filter(([name, f]) =>
    key === 'PLA-SILK' ? /silk/i.test(name) && typeOf(f) === 'PLA' : typeOf(f) === key && !/silk/i.test(name));
  const pick = (re) => matches.find(([n]) => re.test(n))?.[0];
  return pick(/^Generic /) || pick(/^QIDI .*(Basic|Rapido)/) || pick(/^QIDI /) || matches[0]?.[0] ||
    (key !== 'PLA' ? defaultFilamentFor(bundle, 'PLA') : bundle.defaults.filament);
}

export function chooseFilament(bundle, options, source) {
  const key = materialKey(source.type, source.name);
  let name = options.filamentMap?.[key];
  if (!name || !bundle.filaments[name]) name = defaultFilamentFor(bundle, key);
  const preset = bundle.filaments[name];
  return { name, inherits: preset.inherits || '', preset, materialKey: key };
}

// ---------------------------------------------------------------------------
// Archive parts

function readApplication(files) {
  const model = files['3D/3dmodel.model'];
  if (!model) return '';
  const head = strFromU8(model.subarray(0, Math.min(model.length, 20000)));
  return head.match(/<metadata name="Application">([^<]*)<\/metadata>/)?.[1] ?? '';
}

// Moves every build item from the old plate grid to the new one, keeps each
// plate's objects inside the (possibly smaller) bed and moves the plate's
// prime tower along with them.
function relocatePlates(files, src, project, report) {
  const path = '3D/3dmodel.model';
  const oldBed = bedSize(src.printable_area);
  const newBed = { ...bedSize(project.printable_area), exclude: project.bed_exclude_area };
  const xml = strFromU8(files[path]);
  const plateCount = Math.max(1, (strFromU8(files['Metadata/model_settings.config'] ?? new Uint8Array()).match(/<plate>/g) || []).length);
  const cols = plateColumns(plateCount);
  const oldStride = { x: oldBed.w * (1 + PLATE_GAP), y: oldBed.d * (1 + PLATE_GAP) };
  const newStride = { x: newBed.w * (1 + PLATE_GAP), y: newBed.d * (1 + PLATE_GAP) };
  const meshes = bambuObjectMeshes(files);

  const items = [...xml.matchAll(/<item\b[^>]*>/g)].map((match) => {
    const tag = match[0];
    const m = parseMatrix(tag.match(/\btransform="([^"]*)"/)?.[1]);
    const col = Math.max(0, Math.round((m[9] - oldBed.x0 - oldBed.w / 2) / oldStride.x));
    const row = Math.max(0, Math.round(-(m[10] - oldBed.y0 - oldBed.d / 2) / oldStride.y));
    const origin = { x: oldBed.x0 + col * oldStride.x, y: oldBed.y0 - row * oldStride.y };
    const bounds = emptyBounds();
    for (const part of meshes.get(tag.match(/\bobjectid="([^"]*)"/)?.[1]) || []) {
      extendBounds(bounds, part.vertices, multiply(part.matrix, m));
    }
    const local = Number.isFinite(bounds[0])
      ? [bounds[0] - origin.x, bounds[1] - origin.y, bounds[2] - origin.x, bounds[3] - origin.y]
      : undefined;
    return { tag, m, col, row, plate: row * cols + col + 1, local };
  });

  const shifts = new Map();
  for (let plate = 1; plate <= Math.max(plateCount, ...items.map((i) => i.plate)); plate++) {
    const onPlate = items.filter((i) => i.plate === plate);
    const boxes = onPlate.filter((i) => i.local).map((i) => i.local);
    if (!boxes.length) {
      shifts.set(plate, { x: (newBed.w - oldBed.w) / 2, y: (newBed.d - oldBed.d) / 2 });
      continue;
    }
    const box = boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
    const place = placeBox(box, newBed);
    if (!place) {
      const area = usableAreas(newBed)[1];
      shifts.set(plate, fitShift(box, area));
      report.warnings.push(
        `Deska ${plate}: objekty zabírají ${Math.round(box[2] - box[0])}×${Math.round(box[3] - box[1])} mm a na podložku ` +
          `${newBed.w}×${newBed.d} mm se nevejdou – v QIDI Studiu je přeskládej (Arrange) nebo rozděl na víc desek.`,
      );
      continue;
    }
    let rotation;
    if (place.rotated) {
      const { col, row } = onPlate[0];
      const { x: cx, y: cy } = place.center;
      rotation = { local: place.center, matrix: rotate90About(cx + oldBed.x0 + col * oldStride.x, cy + oldBed.y0 - row * oldStride.y) };
      for (const it of onPlate) it.m = multiply(it.m, rotation.matrix);
      report.notes.push(`Deska ${plate}: otočena o 90°, aby se vešla na podložku`);
    }
    if (place.inExcluded) {
      report.warnings.push(`Deska ${plate}: objekty zasahují k vyloučené oblasti podložky – zkontroluj rozložení v QIDI Studiu.`);
    }
    shifts.set(plate, { ...place.shift, rotation });
  }

  let i = 0;
  let moved = 0;
  files[path] = strToU8(xml.replace(/<item\b[^>]*>/g, () => {
    const { tag, m, col, row, plate } = items[i++];
    const s = shifts.get(plate);
    const t = [...m];
    const before = parseMatrix(tag.match(/\btransform="([^"]*)"/)?.[1]);
    t[9] = m[9] - oldBed.x0 - col * oldStride.x + newBed.x0 + col * newStride.x + s.x;
    t[10] = m[10] - oldBed.y0 + row * oldStride.y + newBed.y0 - row * newStride.y + s.y;
    if (t.some((v, k) => Math.abs(v - before[k]) > 1e-3)) moved++;
    const transform = t.map(formatNumber).join(' ');
    return /\btransform="/.test(tag) ? tag.replace(/\btransform="[^"]*"/, `transform="${transform}"`) : tag.replace(/\s*\/?>$/, ` transform="${transform}"$&`);
  }));

  // Prime tower positions are stored per plate in plate-local coordinates.
  // QIDI Studio itself pulls a tower that sticks out back onto the bed (its
  // default for the Q1 Pro is y=241), so only keep it within the bed.
  const plates = Array.from({ length: plateCount }, (_, k) => k + 1);
  const towerWidth = Number(project.prime_tower_width) || 35;
  const towers = plates.map((p) => {
    const s = shifts.get(p);
    let x = Number(at(src.wipe_tower_x, p - 1) ?? at(src.wipe_tower_x, 0));
    let y = Number(at(src.wipe_tower_y, p - 1) ?? at(src.wipe_tower_y, 0));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [at(project.wipe_tower_x, 0), at(project.wipe_tower_y, 0)];
    if (s.rotation) [x, y] = [s.rotation.local.x - (y - s.rotation.local.y), s.rotation.local.y + (x - s.rotation.local.x)];
    x = Math.min(Math.max(x + s.x, 0), newBed.w - towerWidth);
    y = Math.min(Math.max(y + s.y, 0), newBed.d);
    // The tower's depth depends on the purge volumes; assume it is square-ish
    // and keep it clear of excluded areas, which QIDI Studio refuses.
    const depth = towerWidth + 5;
    for (const r of exclusionRects(newBed)) {
      const tower = [x, Math.min(y, newBed.d - depth), x + towerWidth, Math.min(y, newBed.d - depth) + depth];
      if (overlaps(tower, r, 5)) y = Math.max(0, r[1] - 5 - depth);
    }
    return [formatNumber(x), formatNumber(y)];
  });
  project.wipe_tower_x = towers.map((t) => String(t[0]));
  project.wipe_tower_y = towers.map((t) => String(t[1]));

  if (oldBed.w !== newBed.w || oldBed.d !== newBed.d) {
    const plates = `${plateCount} ${plateCount === 1 ? 'deska' : plateCount < 5 ? 'desky' : 'desek'}`;
    report.notes.push(moved
      ? `Podložka ${oldBed.w}×${oldBed.d} → ${newBed.w}×${newBed.d} mm, přesunuto ${moved} z ${items.length} objektů (${plates})`
      : `Podložka ${oldBed.w}×${oldBed.d} → ${newBed.w}×${newBed.d} mm, objekty se vejdou a zůstaly na místě (${plates})`);
  }
}

// Drops per-object/part overrides QIDI Studio does not know and plate
// references to removed G-code.
function cleanModelSettings(files, project, report) {
  const path = 'Metadata/model_settings.config';
  if (!files[path]) return;
  const structural = new Set([
    'name', 'extruder', 'matrix', 'source_file', 'source_object_id', 'source_volume_id', 'source_offset_x',
    'source_offset_y', 'source_offset_z', 'source_in_inches', 'source_in_meters', 'mesh_shared', 'volume_type',
    'modifier_type', 'plater_id', 'plater_name', 'locked', 'filament_map_mode', 'filament_maps', 'filament_volume_maps',
    'thumbnail_file', 'thumbnail_no_light_file', 'top_file', 'pick_file', 'pattern_bbox_file', 'pattern_file',
    'object_id', 'instance_id', 'identify_id', 'print_sequence', 'first_layer_print_sequence',
    'other_layers_print_sequence', 'other_layers_print_sequence_nums', 'spiral_mode', 'bed_type',
    'nozzle_diameters', 'label_object_enabled', 'enable_wrapping_detection', 'filament_nozzle_maps',
  ]);
  const dropped = new Set();
  const xml = strFromU8(files[path])
    .replace(/\s*<metadata key="gcode_file" value="[^"]*"\/>/g, '')
    .replace(/(\s*)<metadata key="([^"]+)" value="[^"]*"\/>/g, (line, ws, key) => {
      if (structural.has(key) || key in project) return line;
      dropped.add(key);
      return '';
    });
  files[path] = strToU8(xml);
  if (dropped.size) report.warnings.push(`Nastavení u objektů, která QIDI Studio nezná (vynechána): ${[...dropped].join(', ')}`);
}

function rewriteModelMetadata(files, bundle) {
  const path = '3D/3dmodel.model';
  let xml = strFromU8(files[path]);
  const app = `${QIDI_PREFIX}-${bundle.slicerVersion}`;
  xml = xml.replace(/<metadata name="Application">[^<]*<\/metadata>/, `<metadata name="Application">${app}</metadata>`);
  if (!xml.includes('name="QIDIStudio:3mfVersion"')) {
    xml = xml.replace(
      /(<metadata name="BambuStudio:3mfVersion">[^<]*<\/metadata>)/,
      `$1\n <metadata name="QIDIStudio:3mfVersion">1</metadata>`,
    );
  }
  files[path] = strToU8(xml);
}

function rewriteSliceInfo(files, bundle) {
  files['Metadata/slice_info.config'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n' +
      '    <header_item key="X-QDT-Client-Type" value="slicer"/>\n' +
      `    <header_item key="X-QDT-Client-Version" value="${bundle.slicerVersion}"/>\n` +
      '  </header>\n</config>\n',
  );
}

// Sliced G-code and embedded Bambu presets only make sense for the source printer.
function dropSlicerArtifacts(files, report) {
  const removed = [];
  for (const name of Object.keys(files)) {
    if (/^Metadata\/plate_\d+\.gcode(\.md5)?$/.test(name) ||
        /^Metadata\/(filament|print|machine|process)_settings_\d+\.config$/.test(name)) {
      delete files[name];
      removed.push(name);
    }
  }
  if (!removed.length) return;
  for (const name of Object.keys(files)) {
    if (!name.endsWith('.rels')) continue;
    const xml = strFromU8(files[name]);
    const cleaned = xml.replace(/\s*<Relationship\b[^>]*Target="\/?([^"]+)"[^>]*\/>/g, (rel, target) =>
      removed.includes(target) ? '' : rel);
    if (cleaned !== xml) files[name] = strToU8(cleaned);
  }
  const gcode = removed.filter((n) => n.endsWith('.gcode')).length;
  if (gcode) report.notes.push(`Odstraněn G-code pro původní tiskárnu (${gcode} ${gcode === 1 ? 'deska' : 'desek'})`);
}

// ---------------------------------------------------------------------------
// Helpers

function at(arr, i) {
  return Array.isArray(arr) ? arr[i] : i === 0 ? arr : undefined;
}

export function parseIni(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:;\s*)?([A-Za-z0-9_]+)\s*=\s?(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
