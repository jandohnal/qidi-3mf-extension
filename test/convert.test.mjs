import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { zipSync, unzipSync, strToU8, strFromU8 } from '../extension/vendor/fflate.js';
import { convert3mf, materialKey, chooseProcess } from '../extension/lib/convert.js';
import { placeBox, plateColumns } from '../extension/lib/layout.js';

const bundle = JSON.parse(fs.readFileSync(new URL('../extension/profiles/q1-pro-0.4.json', import.meta.url)));

const cube = (size = 20) => {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
    .map((p) => p.map((c) => (c - 0.5) * size));
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return {
    vertices: v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join(''),
    triangles: t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join(''),
  };
};

function bambu3mf({ items, plates = 1, settings = {} }) {
  const c = cube();
  const objects = items.map((_, i) => `<object id="${i * 2 + 2}" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>`);
  const build = items.map(([x, y], i) => `<item objectid="${i * 2 + 2}" transform="1 0 0 0 1 0 0 0 1 ${x} ${y} 10" printable="1"/>`);
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="Application">BambuStudio-02.02.00.00</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>${objects.join('')}</resources><build>${build.join('')}</build></model>`;
  const sub = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${c.vertices}</vertices><triangles>${c.triangles}</triangles></mesh></object></resources><build/></model>`;
  const plateXml = Array.from({ length: plates }, (_, i) => `<plate><metadata key="plater_id" value="${i + 1}"/><metadata key="gcode_file" value="Metadata/plate_${i + 1}.gcode"/></plate>`).join('');
  const project = {
    printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
    printable_area: ['0x0', '256x0', '256x256', '0x256'],
    layer_height: '0.12',
    wall_loops: '4',
    sparse_infill_density: '25%',
    outer_wall_speed: ['999'],
    different_settings_to_system: ['wall_loops;sparse_infill_density;outer_wall_speed', '', ''],
    filament_settings_id: ['Bambu PETG HF @BBL X1C', 'Bambu PLA Silk @BBL X1C'],
    filament_type: ['PETG', 'PLA'],
    filament_colour: ['#FF0000', '#00FF00'],
    wipe_tower_x: Array(plates).fill('165'),
    wipe_tower_y: Array(plates).fill('220'),
    ...settings,
  };
  return zipSync({
    '3D/3dmodel.model': strToU8(model),
    '3D/Objects/object_1.model': strToU8(sub),
    'Metadata/project_settings.config': strToU8(JSON.stringify(project)),
    'Metadata/model_settings.config': strToU8(`<config><object id="2"><metadata key="wall_loops" value="5"/><metadata key="bambu_only_option" value="1"/></object>${plateXml}</config>`),
    'Metadata/plate_1.gcode': strToU8('; gcode'),
    'Metadata/filament_settings_1.config': strToU8('{}'),
  });
}

function prusa3mf() {
  const c = cube();
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
 <metadata name="Title">cube</metadata>
 <metadata name="Application">PrusaSlicer-2.8.1</metadata>
 <resources><object id="1" type="model"><mesh><vertices>${c.vertices}</vertices><triangles>${c.triangles}</triangles></mesh></object></resources>
 <build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 125 105 10" printable="1"/></build></model>`;
  const modelConfig = `<config><object id="1" instances_count="1"><metadata type="object" key="name" value="Kostka"/><metadata type="object" key="perimeters" value="5"/>
  <volume firstid="0" lastid="11"><metadata type="volume" key="name" value="cube.stl"/><metadata type="volume" key="volume_type" value="ModelPart"/></volume></object></config>`;
  const ini = ['; bed_shape = 0x0,250x0,250x210,0x210', '; layer_height = 0.15', '; perimeters = 3', '; fill_density = 20%',
    '; fill_pattern = gyroid', '; support_material = 1', '; support_material_style = organic', '; filament_type = PETG',
    '; filament_colour = #FF8000', '; printer_model = MK4S'].join('\n');
  return zipSync({
    '3D/3dmodel.model': strToU8(model),
    'Metadata/Slic3r_PE.config': strToU8(ini),
    'Metadata/Slic3r_PE_model.config': strToU8(modelConfig),
  });
}

const read = (bytes) => unzipSync(bytes);
const config = (files) => JSON.parse(strFromU8(files['Metadata/project_settings.config']));
const items = (files) => [...strFromU8(files['3D/3dmodel.model']).matchAll(/<item\b[^>]*transform="([^"]*)"/g)].map((m) => m[1].split(' ').map(Number));

test('Bambu project gets QIDI printer, presets and designer settings', () => {
  const { bytes, report } = convert3mf(bambu3mf({ items: [[128, 128]] }), bundle, {});
  assert.equal(report.source, 'bambu');
  const files = read(bytes);
  const c = config(files);
  assert.equal(c.printer_settings_id, bundle.printer.name);
  assert.equal(c.print_settings_id, '0.12mm Fine @Q1 Pro');
  assert.deepEqual(c.filament_colour, ['#FF0000', '#00FF00']);
  assert.match(c.filament_settings_id[0], /PETG/);
  assert.match(c.filament_settings_id[1], /PLA/);
  assert.equal(c.wall_loops, '4');
  assert.equal(c.sparse_infill_density, '25%');
  // Speeds are machine specific and come from the QIDI preset.
  assert.notDeepEqual(c.outer_wall_speed, ['999']);
  assert.equal(c.nozzle_temperature.length, 2);
  assert.ok(!files['Metadata/plate_1.gcode']);
  assert.ok(!files['Metadata/filament_settings_1.config']);
  const model = strFromU8(files['3D/3dmodel.model']);
  assert.match(model, /name="Application">QIDIStudio-/);
  assert.match(model, /QIDIStudio:3mfVersion/);
  const settings = strFromU8(files['Metadata/model_settings.config']);
  assert.match(settings, /key="wall_loops" value="5"/);
  assert.doesNotMatch(settings, /bambu_only_option|gcode_file/);
});

test('designer settings can be ignored', () => {
  const c = config(read(convert3mf(bambu3mf({ items: [[128, 128]] }), bundle, { keepDesignerSettings: false }).bytes));
  assert.equal(c.wall_loops, bundle.processes[c.print_settings_id].settings.wall_loops);
});

test('filament mapping and process from settings win', () => {
  const pla = Object.keys(bundle.filaments).find((n) => /PLA/.test(n) && !/Generic/.test(n));
  const c = config(read(convert3mf(bambu3mf({ items: [[128, 128]] }), bundle, {
    process: '0.20mm Standard @Q1 Pro',
    filamentMap: { 'PLA-SILK': pla },
  }).bytes));
  assert.equal(c.print_settings_id, '0.20mm Standard @Q1 Pro');
  assert.equal(c.filament_settings_id[1], pla);
});

test('objects move from the Bambu plate grid to the QIDI one', () => {
  // 4 plates on a 256 mm bed: stride 307.2, 2 columns; plate 4 is at (307.2, -307.2).
  const { bytes } = convert3mf(bambu3mf({ items: [[128, 128], [307.2 + 250, -307.2 + 128]], plates: 4 }), bundle, {});
  const [a, b] = items(read(bytes));
  const bed = 245;
  const stride = bed * 1.2;
  assert.ok(a[9] > 10 && a[9] < bed - 10 && a[10] > 10 && a[10] < bed - 10, `plate 1 item at ${a[9]},${a[10]}`);
  // The second cube sat at the right edge of plate 4; it must end inside the new bed.
  assert.ok(b[9] - stride + 10 <= bed && b[9] - stride - 10 >= 0, `plate 4 item x ${b[9]}`);
  assert.ok(Math.abs(b[10] + stride - 128) < 20, `plate 4 item y ${b[10]}`);
  const c = config(read(bytes));
  assert.equal(c.wipe_tower_x.length, 4);
});

test('a plate too tall for the bed is rotated by 90°', () => {
  const box = [10, 0, 110, 243];
  const place = placeBox(box, { x0: 0, y0: 0, w: 245, d: 245, exclude: bundle.printer.settings.bed_exclude_area });
  assert.equal(place.rotated, true);
});

test('plate columns follow Bambu Studio', () => {
  assert.deepEqual([1, 2, 4, 5, 9, 10].map(plateColumns), [1, 2, 2, 3, 3, 4]);
});

test('PrusaSlicer project is rebuilt in the QIDI layout', () => {
  const { bytes, report } = convert3mf(prusa3mf(), bundle, {});
  assert.equal(report.source, 'prusa');
  const files = read(bytes);
  assert.ok(!files['Metadata/Slic3r_PE.config']);
  assert.ok(files['3D/Objects/object_1.model']);
  const c = config(files);
  assert.equal(c.printer_settings_id, bundle.printer.name);
  assert.equal(c.layer_height, '0.15');
  assert.equal(c.wall_loops, '3');
  assert.equal(c.sparse_infill_pattern, 'gyroid');
  assert.equal(c.enable_support, '1');
  assert.equal(c.support_type, 'tree(auto)');
  assert.match(c.filament_settings_id[0], /PETG/);
  const settings = strFromU8(files['Metadata/model_settings.config']);
  assert.match(settings, /key="name" value="Kostka"/);
  assert.match(settings, /key="wall_loops" value="5"/);
  assert.match(settings, /<model_instance>/);
  const [t] = items(files);
  // Centred on the 245 mm bed instead of the 250×210 one.
  assert.ok(Math.abs(t[9] - 122.5) < 2 && Math.abs(t[10] - 122) < 5, `item at ${t[9]},${t[10]}`);
});

test('plain 3MF and QIDI projects pass through unchanged', () => {
  const plain = zipSync({ '3D/3dmodel.model': strToU8('<model></model>') });
  assert.equal(convert3mf(plain, bundle, {}).report.changed, false);
  const qidi = read(convert3mf(bambu3mf({ items: [[128, 128]] }), bundle, {}).bytes);
  assert.equal(convert3mf(zipSync(qidi), bundle, {}).report.changed, false);
});

test('material keys', () => {
  assert.equal(materialKey('PLA', 'Bambu PLA Silk @BBL X1C'), 'PLA-SILK');
  assert.equal(materialKey('PETG-CF'), 'PETG-CF');
  assert.equal(materialKey('PA6-CF'), 'PA');
  assert.equal(materialKey('PVA'), 'SUPPORT');
  assert.equal(chooseProcess(bundle, {}, '0.28').name, '0.28mm Extra Draft @Q1 Pro');
});

test('report lists changes against the original', () => {
  const { report } = convert3mf(bambu3mf({ items: [[128, 128]] }), bundle, {});
  const d = report.diff;
  assert.deepEqual(d.files.removed.map((f) => f.name).sort(), ['Metadata/filament_settings_1.config', 'Metadata/plate_1.gcode']);
  assert.ok(d.files.changed.some((f) => f.name === 'Metadata/project_settings.config'));
  assert.ok(d.files.unchanged.some((f) => f.name === '3D/Objects/object_1.model'));
  assert.deepEqual(d.model.metadata.find((m) => m.key === 'Application').before, 'BambuStudio-02.02.00.00');
  const printer = d.settings.highlights.find((h) => h.key === 'printer_settings_id');
  assert.equal(printer.before, 'Bambu Lab P1S 0.4 nozzle');
  assert.equal(printer.after, bundle.printer.name);
  assert.ok(d.settings.highlights.find((h) => h.key === 'wall_loops').same);
  const speed = d.settings.changed.find((c) => c.key === 'outer_wall_speed');
  assert.equal(speed.category, 'speed');
  assert.equal(speed.before, '999');
});

test('report for a PrusaSlicer project compares mapped settings', () => {
  const d = convert3mf(prusa3mf(), bundle, {}).report.diff;
  assert.ok(d.files.removed.some((f) => f.name === 'Metadata/Slic3r_PE.config'));
  assert.equal(d.settings.highlights.find((h) => h.key === 'printable_area').before, '0x0, 250x0, 250x210, 0x210');
  assert.ok(d.model.items[0].moved);
});

test('imported user presets extend the bundle of their printer only', async () => {
  const { mergeUserPresets, parseUserPreset, applicablePresets } = await import('../extension/lib/settings.js');
  const mine = parseUserPreset(JSON.stringify({
    name: 'My PLA', inherits: 'Generic PLA @Qidi Q1 Pro 0.4 nozzle', from: 'User', nozzle_temperature: ['215'],
  }), 'user/default/filament/My PLA.json');
  const other = parseUserPreset(JSON.stringify({ name: 'Elsewhere', inherits: 'Generic PLA @Qidi X-Max 3 0.4 nozzle', filament_type: ['PLA'] }));
  assert.equal(mine.type, 'filament');
  assert.equal(parseUserPreset('not json'), undefined);
  assert.deepEqual(applicablePresets(bundle, [mine, other]).map((p) => p.name), ['My PLA']);
  const merged = mergeUserPresets(structuredClone(bundle), [mine, other]);
  assert.equal(merged.filaments['My PLA'].user, true);
  assert.deepEqual(merged.filaments['My PLA'].settings.nozzle_temperature, ['215']);
  assert.equal(merged.filaments['My PLA'].settings.filament_type[0], 'PLA');
  const c = config(read(convert3mf(bambu3mf({ items: [[128, 128]] }), merged, { filamentMap: { PETG: 'My PLA' } }).bytes));
  assert.equal(c.filament_settings_id[0], 'My PLA');
  assert.equal(c.inherits_group[1], 'Generic PLA @Qidi Q1 Pro 0.4 nozzle');
});

test('output names use the printer model', async () => {
  const { outputName } = await import('../extension/lib/settings.js');
  assert.equal(outputName('Boat.3mf', ' ({printer})', bundle), 'Boat (Q1 Pro).3mf');
  assert.equal(outputName('Boat.3MF', '', bundle), 'Boat.3mf');
});

test('report messages render in English and Czech', async () => {
  const { fmt, setLanguage } = await import('../extension/lib/i18n.js');
  const { report } = convert3mf(bambu3mf({ items: [[128, 128]] }), bundle, {});
  const note = report.notes.find((n) => n.id === 'notePrinter');
  setLanguage('en');
  assert.equal(fmt(note), `Printer Bambu Lab P1S 0.4 nozzle → ${bundle.printer.name}`);
  setLanguage('cs');
  assert.equal(fmt(note), `Tiskárna Bambu Lab P1S 0.4 nozzle → ${bundle.printer.name}`);
  assert.match(fmt(report.notes.find((n) => n.id === 'noteGcodeRemoved')), /1 deska/);
  setLanguage('en');
});

test('archives unpacking beyond the limit are refused', async () => {
  const { MAX_UNPACKED } = await import('../extension/lib/convert.js');
  // A zero-filled entry compresses to almost nothing but unpacks past the limit.
  const big = zipSync({ 'big.bin': new Uint8Array(Math.ceil(MAX_UNPACKED) + 1) }, { level: 1 });
  assert.throws(() => convert3mf(big, bundle, {}), /MB/);
});
