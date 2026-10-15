// Maps PrusaSlicer print settings (Metadata/Slic3r_PE.config) onto the
// Bambu/QIDI Studio keys used in project_settings.config.

const INFILL = {
  rectilinear: 'zig-zag', alignedrectilinear: 'alignedrectilinear', grid: 'grid', triangles: 'triangles',
  stars: 'tri-hexagon', cubic: 'cubic', line: 'line', concentric: 'concentric', honeycomb: 'honeycomb',
  '3dhoneycomb': '3dhoneycomb', gyroid: 'gyroid', hilbertcurve: 'hilbertcurve',
  archimedeanchords: 'archimedeanchords', octagramspiral: 'octagramspiral', adaptivecubic: 'adaptivecubic',
  supportcubic: 'supportcubic', lightning: 'lightning',
};
const SURFACE = {
  rectilinear: 'zig-zag', monotonic: 'monotonic', monotoniclines: 'monotonicline',
  alignedrectilinear: 'alignedrectilinear', concentric: 'concentric', hilbertcurve: 'hilbertcurve',
  archimedeanchords: 'archimedeanchords', octagramspiral: 'octagramspiral',
};
const SEAM = { aligned: 'aligned', nearest: 'nearest', rear: 'back', random: 'random' };
const SUPPORT_STYLE = { grid: 'grid', snug: 'snug', organic: 'organic' };
const IRONING = { top: 'top', topmost: 'topmost', solid: 'solid' };
const BRIM = { outer_only: 'outer_only', inner_only: 'inner_only', outer_and_inner: 'outer_and_inner', no_brim: 'no_brim' };

const num = (v) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : String(Number(v)));
const bool = (v) => (v === undefined || v === '' ? undefined : v === '1' ? '1' : '0');
const map = (table) => (v) => (v === undefined ? undefined : table[v]);
const percent = (v) => (v === undefined || v === '' ? undefined : /%$/.test(v) ? v : `${Number(v)}%`);

// key in PrusaSlicer → [key in QIDI Studio, value converter]
const SIMPLE = {
  layer_height: ['layer_height', num],
  first_layer_height: ['initial_layer_print_height', num],
  perimeters: ['wall_loops', num],
  top_solid_layers: ['top_shell_layers', num],
  bottom_solid_layers: ['bottom_shell_layers', num],
  top_solid_min_thickness: ['top_shell_thickness', num],
  bottom_solid_min_thickness: ['bottom_shell_thickness', num],
  fill_density: ['sparse_infill_density', percent],
  fill_pattern: ['sparse_infill_pattern', map(INFILL)],
  top_fill_pattern: ['top_surface_pattern', map(SURFACE)],
  bottom_fill_pattern: ['bottom_surface_pattern', map(SURFACE)],
  solid_fill_pattern: ['internal_solid_infill_pattern', map(SURFACE)],
  fill_angle: ['infill_direction', num],
  seam_position: ['seam_position', map(SEAM)],
  thin_walls: ['detect_thin_wall', bool],
  spiral_vase: ['spiral_mode', bool],
  raft_layers: ['raft_layers', num],
  support_material_buildplate_only: ['support_on_build_plate_only', bool],
  support_material_contact_distance: ['support_top_z_distance', num],
  support_material_bottom_contact_distance: ['support_bottom_z_distance', num],
  support_material_interface_layers: ['support_interface_top_layers', num],
  support_material_bottom_interface_layers: ['support_interface_bottom_layers', (v) => (v === '-1' ? undefined : num(v))],
  support_material_threshold: ['support_threshold_angle', num],
  support_material_enforce_layers: ['enforce_support_layers', num],
  support_material_pattern: ['support_base_pattern', map({ rectilinear: 'rectilinear', 'rectilinear-grid': 'rectilinear-grid', honeycomb: 'honeycomb' })],
  support_material_interface_pattern: ['support_interface_pattern', map({ rectilinear: 'rectilinear', concentric: 'concentric', auto: 'auto' })],
  support_material_spacing: ['support_base_pattern_spacing', num],
  brim_type: ['brim_type', map(BRIM)],
  brim_width: ['brim_width', num],
  brim_separation: ['brim_object_gap', num],
  skirts: ['skirt_loops', num],
  skirt_distance: ['skirt_distance', num],
  skirt_height: ['skirt_height', num],
  elefant_foot_compensation: ['elefant_foot_compensation', num],
  xy_size_compensation: ['xy_contour_compensation', num],
  fuzzy_skin: ['fuzzy_skin', map({ none: 'none', external: 'external', all: 'all' })],
  fuzzy_skin_thickness: ['fuzzy_skin_thickness', num],
  fuzzy_skin_point_dist: ['fuzzy_skin_point_distance', num],
  wipe_tower: ['enable_prime_tower', bool],
  wipe_tower_width: ['prime_tower_width', num],
  interface_shells: ['interface_shells', bool],
  ensure_vertical_shell_thickness: ['ensure_vertical_shell_thickness', (v) =>
    v === undefined ? undefined : v === '1' || v === 'enabled' ? 'enabled' : v === '0' || v === 'disabled' ? 'none' : undefined],
};

// A PrusaSlicer project stores the whole config without telling what the
// designer changed, so only settings that usually express intent are taken.
const INTENT_KEYS = [
  'layer_height', 'wall_loops', 'top_shell_layers', 'bottom_shell_layers', 'sparse_infill_density',
  'sparse_infill_pattern', 'enable_support', 'support_type', 'support_style', 'support_on_build_plate_only',
  'raft_layers', 'ironing_type', 'spiral_mode', 'fuzzy_skin', 'print_sequence',
];

export function convertPrusaConfig(ini) {
  const all = mapPrusaSettings(ini);
  const overlay = Object.fromEntries(INTENT_KEYS.filter((k) => all[k] !== undefined).map((k) => [k, all[k]]));
  if (all.enable_support !== '1') {
    delete overlay.support_type;
    delete overlay.support_style;
    delete overlay.support_on_build_plate_only;
  }
  if (Number(all.brim_width) > 0) {
    overlay.brim_type = all.brim_type && all.brim_type !== 'no_brim' ? all.brim_type : 'outer_only';
    overlay.brim_width = all.brim_width;
  }
  return { overlay, filaments: prusaFilaments(ini) };
}

// Works for the whole print config as well as for per-object/per-volume
// overrides, which only contain some keys.
export function mapPrusaSettings(ini) {
  const overlay = {};
  for (const [from, [to, conv]] of Object.entries(SIMPLE)) {
    const v = conv(ini[from]);
    if (v !== undefined) overlay[to] = v;
  }

  if (ini.perimeter_generator) overlay.wall_generator = ini.perimeter_generator === 'arachne' ? 'arachne' : 'classic';
  if (ini.external_perimeters_first !== undefined) {
    overlay.wall_sequence = ini.external_perimeters_first === '1' ? 'outer wall/inner wall' : 'inner wall/outer wall';
  }
  if (ini.complete_objects === '1') overlay.print_sequence = 'by object';
  if (ini.ironing !== undefined) {
    overlay.ironing_type = ini.ironing === '1' ? IRONING[ini.ironing_type] ?? 'top' : 'no ironing';
  }
  if (ini.support_material !== undefined) {
    const enabled = ini.support_material === '1';
    const auto = ini.support_material_auto !== '0';
    const organic = ini.support_material_style === 'organic';
    overlay.enable_support = enabled ? '1' : '0';
    overlay.support_type = `${organic ? 'tree' : 'normal'}(${auto ? 'auto' : 'manual'})`;
    const style = SUPPORT_STYLE[ini.support_material_style];
    if (style) overlay.support_style = style;
  } else if (ini.support_material_auto !== undefined) {
    overlay.support_type = `${ini.support_material_style === 'organic' ? 'tree' : 'normal'}(${ini.support_material_auto === '0' ? 'manual' : 'auto'})`;
  }
  if (overlay.brim_width === '0' && !ini.brim_type) overlay.brim_type = 'no_brim';
  return overlay;
}

function prusaFilaments(ini) {
  const split = (v) => (v === undefined ? [] : splitList(v));
  const types = split(ini.filament_type);
  const names = split(ini.filament_settings_id);
  const colours = split(ini.extruder_colour).map((c, i) => c || split(ini.filament_colour)[i]);
  const count = Math.max(1, types.length, names.length);
  return Array.from({ length: count }, (_, i) => ({
    type: types[i] || types[0] || 'PLA',
    name: names[i] || '',
    colour: normaliseColour(colours[i] || split(ini.filament_colour)[i]),
  }));
}

// PrusaSlicer serialises vectors as `a;b;c`, quoting strings: `"a";"b"`.
function splitList(v) {
  return v.split(';').map((part) => part.trim().replace(/^"(.*)"$/, '$1'));
}

function normaliseColour(c) {
  return /^#[0-9a-f]{6}$/i.test(c || '') ? c.toUpperCase() : '#FFFFFF';
}
