// Describes what a conversion changed against the original 3MF: files in the
// archive, the model header and object placement, and the project settings.

import { strFromU8 } from '../vendor/fflate.js';
import { mapPrusaSettings } from './prusa.js';
import { PORTABLE_PROCESS_KEYS } from './portable.js';

// Settings shown first, in this order (labels in i18n.js).
export const HIGHLIGHTS = [
  'printer_settings_id',
  'printer_model',
  'print_settings_id',
  'filament_settings_id',
  'filament_type',
  'filament_colour',
  'printable_area',
  'printable_height',
  'bed_exclude_area',
  'nozzle_diameter',
  'gcode_flavor',
  'machine_start_gcode',
  'layer_height',
  'initial_layer_print_height',
  'wall_loops',
  'top_shell_layers',
  'bottom_shell_layers',
  'sparse_infill_density',
  'sparse_infill_pattern',
  'enable_support',
  'support_type',
  'support_on_build_plate_only',
  'brim_type',
  'outer_wall_speed',
  'inner_wall_speed',
  'sparse_infill_speed',
  'travel_speed',
  'default_acceleration',
  'outer_wall_acceleration',
  'nozzle_temperature',
  'nozzle_temperature_initial_layer',
  'textured_plate_temp',
  'hot_plate_temp',
  'chamber_temperatures',
  'filament_max_volumetric_speed',
  'pressure_advance',
  'fan_max_speed',
  'retraction_length',
  'z_hop',
  'wipe_tower_x',
  'wipe_tower_y',
  'curr_bed_type',
];

export const CATEGORIES = ['profile', 'designer', 'speed', 'accel', 'temp', 'retract', 'fan', 'gcode', 'other'];

const PROFILE_KEYS = new Set([
  'printer_settings_id', 'printer_model', 'print_settings_id', 'filament_settings_id', 'filament_ids', 'printable_area',
  'printable_height', 'bed_exclude_area', 'nozzle_diameter', 'gcode_flavor', 'printer_variant', 'inherits_group',
  'different_settings_to_system', 'version', 'default_print_profile', 'default_filament_profile',
  'print_compatible_printers', 'upward_compatible_machine', 'extruder_variant_list', 'printer_extruder_variant',
  'print_extruder_variant', 'filament_extruder_variant', 'filament_vendor', 'printer_structure',
]);
const DESIGNER_KEYS = new Set(PORTABLE_PROCESS_KEYS);

export function categoryOf(key) {
  if (PROFILE_KEYS.has(key)) return 'profile';
  if (DESIGNER_KEYS.has(key)) return 'designer';
  if (/gcode/.test(key)) return 'gcode';
  if (/retract|z_hop|wipe_distance|deretraction/.test(key)) return 'retract';
  if (/accel|jerk/.test(key)) return 'accel';
  if (/speed/.test(key) && !/fan/.test(key)) return 'speed';
  if (/temp|chamber/.test(key)) return 'temp';
  if (/fan|cooling|slow_down/.test(key)) return 'fan';
  return 'other';
}

export function diffProjects(before, after, source) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const files = { added: [], removed: [], changed: [], unchanged: [] };
  for (const name of [...names].sort()) {
    const a = before[name];
    const b = after[name];
    if (!a) files.added.push({ name, size: b.length });
    else if (!b) files.removed.push({ name, size: a.length });
    else if (sameBytes(a, b)) files.unchanged.push({ name, size: a.length });
    else files.changed.push({ name, before: a.length, after: b.length });
  }

  return {
    files,
    model: diffModel(before, after),
    sliceInfo: diffSliceInfo(before, after),
    settings: diffSettings(sourceSettings(before, source), readJson(after['Metadata/project_settings.config'])),
  };
}

function sameBytes(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function readJson(bytes) {
  try {
    return bytes ? JSON.parse(strFromU8(bytes)) : {};
  } catch {
    return {};
  }
}

// Original settings under QIDI Studio key names, so both sides compare.
function sourceSettings(files, source) {
  if (files['Metadata/project_settings.config']) return readJson(files['Metadata/project_settings.config']);
  if (source !== 'prusa' || !files['Metadata/Slic3r_PE.config']) return {};
  const ini = {};
  for (const line of strFromU8(files['Metadata/Slic3r_PE.config']).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:;\s*)?([A-Za-z0-9_]+)\s*=\s?(.*)$/);
    if (m) ini[m[1]] = m[2];
  }
  const list = (v) => (v === undefined ? undefined : v.split(';').map((s) => s.trim().replace(/^"(.*)"$/, '$1')));
  const out = {
    printer_settings_id: ini.printer_settings_id,
    printer_model: ini.printer_model,
    print_settings_id: ini.print_settings_id,
    filament_settings_id: list(ini.filament_settings_id),
    filament_type: list(ini.filament_type),
    filament_colour: list(ini.filament_colour),
    printable_area: ini.bed_shape?.split(','),
    printable_height: ini.max_print_height,
    nozzle_diameter: list(ini.nozzle_diameter),
    gcode_flavor: ini.gcode_flavor,
    machine_start_gcode: ini.start_gcode,
    machine_end_gcode: ini.end_gcode,
    nozzle_temperature: list(ini.temperature),
    nozzle_temperature_initial_layer: list(ini.first_layer_temperature),
    hot_plate_temp: list(ini.bed_temperature),
    filament_max_volumetric_speed: list(ini.filament_max_volumetric_speed),
    fan_max_speed: list(ini.max_fan_speed),
    retraction_length: list(ini.retract_length),
    z_hop: list(ini.retract_lift),
    travel_speed: ini.travel_speed,
    outer_wall_speed: ini.external_perimeter_speed,
    inner_wall_speed: ini.perimeter_speed,
    sparse_infill_speed: ini.infill_speed,
    default_acceleration: ini.default_acceleration,
    outer_wall_acceleration: ini.external_perimeter_acceleration,
    ...mapPrusaSettings(ini),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

const MAX_VALUE = 400;

function show(v) {
  if (v === undefined) return undefined;
  if (Array.isArray(v) && !v.length) return '';
  const s = Array.isArray(v) ? v.join(', ') : String(v);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s;
}

function diffSettings(a, b) {
  const changed = [];
  const removed = [];
  const added = [];
  const same = [];
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const inA = key in a;
    const inB = key in b;
    if (inA && !inB) removed.push({ key, before: show(a[key]) });
    else if (!inA && inB) added.push({ key, after: show(b[key]) });
    else if (JSON.stringify(a[key]) === JSON.stringify(b[key])) same.push(key);
    else changed.push({ key, before: show(a[key]), after: show(b[key]), category: categoryOf(key) });
  }
  const highlights = HIGHLIGHTS.filter((key) => key in a || key in b).map((key) => ({
    key,
    before: show(a[key]),
    after: show(b[key]),
    same: JSON.stringify(a[key]) === JSON.stringify(b[key]),
  }));
  return { countBefore: Object.keys(a).length, countAfter: Object.keys(b).length, changed, removed, added, same, highlights };
}

function modelHeader(files) {
  const bytes = files['3D/3dmodel.model'];
  if (!bytes) return '';
  return strFromU8(bytes.subarray(0, Math.min(bytes.length, 20000)));
}

function buildItems(files) {
  const bytes = files['3D/3dmodel.model'];
  if (!bytes) return [];
  // The build section is at the end; avoid decoding huge inline meshes.
  const tail = strFromU8(bytes.subarray(Math.max(0, bytes.length - 2_000_000)));
  return [...tail.matchAll(/<item\b[^>]*>/g)].map((m) => ({
    objectId: m[0].match(/\bobjectid="([^"]*)"/)?.[1],
    t: (m[0].match(/\btransform="([^"]*)"/)?.[1] || '1 0 0 0 1 0 0 0 1 0 0 0').trim().split(/\s+/).map(Number),
  }));
}

function diffModel(before, after) {
  const meta = (header) => Object.fromEntries([...header.matchAll(/<metadata name="([^"]+)">([^<]*)<\/metadata>/g)].map((m) => [m[1], m[2]]));
  const a = meta(modelHeader(before));
  const b = meta(modelHeader(after));
  const metadata = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] !== b[key] && !/^(Description|ProfileDescription)$/.test(key)) metadata.push({ key, before: a[key], after: b[key] });
  }
  const itemsA = buildItems(before);
  const itemsB = buildItems(after);
  const items = itemsB.map((it, i) => {
    const o = itemsA[i];
    if (!o) return { index: i + 1, to: it.t.slice(9) };
    const rotated = Math.abs(o.t[0] - it.t[0]) > 1e-6 || Math.abs(o.t[1] - it.t[1]) > 1e-6;
    const moved = [9, 10, 11].some((k) => Math.abs(o.t[k] - it.t[k]) > 1e-3);
    return { index: i + 1, from: o.t.slice(9), to: it.t.slice(9), moved, rotated };
  });
  return { metadata, items, restructured: itemsA.length !== itemsB.length || !!after['3D/_rels/3dmodel.model.rels'] !== !!before['3D/_rels/3dmodel.model.rels'] };
}

function diffSliceInfo(before, after) {
  const read = (f) => (f ? strFromU8(f) : '');
  const a = read(before['Metadata/slice_info.config']);
  const b = read(after['Metadata/slice_info.config']);
  if (a === b) return undefined;
  const items = (s) => Object.fromEntries([...s.matchAll(/key="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  return { before: items(a), after: items(b) };
}
