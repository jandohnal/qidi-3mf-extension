// Bed geometry and object placement shared by the Bambu and Prusa converters.
// 3MF transforms are 3x4 matrices "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32"
// applied to row vectors: p' = p * M.

import { strFromU8 } from '../vendor/fflate.js';

// Bambu Studio and QIDI Studio lay plates out on a grid; plates are spaced by
// the bed size plus this fraction of it (LOGICAL_PART_PLATE_GAP).
export const PLATE_GAP = 0.2;

export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export function bedSize(area) {
  const pts = (area || []).map((p) => String(p).split('x').map(Number)).filter((p) => p.length === 2);
  if (!pts.length) return { x0: 0, y0: 0, w: 256, d: 256 };
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), d: Math.max(...ys) - Math.min(...ys) };
}

// Excluded rectangles of the bed (e.g. the Q1 Pro's back corners), plate-local.
export function exclusionRects(bed) {
  const pts = (bed.exclude || []).map((p) => String(p).split('x').map(Number)).filter((p) => p.length === 2);
  const rects = [];
  for (let i = 0; i + 3 < pts.length; i += 4) {
    const xs = pts.slice(i, i + 4).map((p) => p[0] - bed.x0);
    const ys = pts.slice(i, i + 4).map((p) => p[1] - bed.y0);
    const r = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (r[2] > r[0] && r[3] > r[1]) rects.push(r);
  }
  return rects;
}

export const overlaps = (a, b, gap = 0) =>
  a[0] < b[2] + gap && a[2] > b[0] - gap && a[1] < b[3] + gap && a[3] > b[1] - gap;

// Plate-local areas objects can be moved into, best first: the bed minus
// excluded strips along its edges, then the whole bed.
export function usableAreas(bed) {
  const strict = { x0: 0, y0: 0, x1: bed.w, y1: bed.d };
  for (const [ex0, ey0, ex1, ey1] of exclusionRects(bed)) {
    if (ey1 >= bed.d) strict.y1 = Math.min(strict.y1, ey0);
    else if (ey0 <= 0) strict.y0 = Math.max(strict.y0, ey1);
    else if (ex1 >= bed.w) strict.x1 = Math.min(strict.x1, ex0);
    else if (ex0 <= 0) strict.x0 = Math.max(strict.x0, ex1);
  }
  const shrink = (a, m) => ({ x0: a.x0 + m, y0: a.y0 + m, x1: a.x1 - m, y1: a.y1 - m });
  return [shrink(strict, 1), shrink({ x0: 0, y0: 0, x1: bed.w, y1: bed.d }, 0.5)];
}

// Where to put a plate-local box: unrotated or rotated by 90° (about its
// centre), in the first area it fits. Returns undefined if it fits nowhere.
export function placeBox(box, bed) {
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const w = box[2] - box[0];
  const d = box[3] - box[1];
  const rotatedBox = [cx - d / 2, cy - w / 2, cx + d / 2, cy + w / 2];
  for (const area of usableAreas(bed)) {
    for (const [rotated, b] of [[false, box], [true, rotatedBox]]) {
      if (!fits(b, area)) continue;
      const shift = fitShift(b, area);
      const moved = [b[0] + shift.x, b[1] + shift.y, b[2] + shift.x, b[3] + shift.y];
      return { rotated, shift, center: { x: cx, y: cy }, inExcluded: exclusionRects(bed).some((r) => overlaps(moved, r)) };
    }
  }
  return undefined;
}

// Same as PartPlateList::compute_colum_count in Bambu/QIDI Studio.
export function plateColumns(count) {
  const value = Math.sqrt(count);
  const round = Math.round(value);
  return value > round ? round + 1 : round;
}

// Shift that moves a plate-local XY box into the usable area: none if it
// already fits, the smallest one if it fits after moving, centred otherwise.
export function fitShift(bbox, usable) {
  const axis = (lo, hi, min, max) => {
    if (hi - lo > max - min) return (min + max) / 2 - (lo + hi) / 2;
    if (hi > max) return max - hi;
    if (lo < min) return min - lo;
    return 0;
  };
  return { x: axis(bbox[0], bbox[2], usable.x0, usable.x1), y: axis(bbox[1], bbox[3], usable.y0, usable.y1) };
}

export function fits(bbox, usable) {
  return bbox[2] - bbox[0] <= usable.x1 - usable.x0 && bbox[3] - bbox[1] <= usable.y1 - usable.y0;
}

export function parseMatrix(s) {
  const m = String(s || '').trim().split(/\s+/).map(Number);
  return m.length === 12 && !m.some(Number.isNaN) ? m : IDENTITY;
}

// a then b
export function multiply(a, b) {
  const r = new Array(12);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j] + (i === 3 ? b[9 + j] : 0);
    }
  }
  return r;
}

const ATTR_RE = { x: /\bx="([^"]*)"/, y: /\by="([^"]*)"/, z: /\bz="([^"]*)"/ };
function num(attrs, name) {
  return Number(attrs.match(ATTR_RE[name])?.[1]);
}

// Exact XY bounds of vertices under a transform; extends `box` in place.
export function extendBounds(box, vertices, m) {
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i];
    const y = vertices[i + 1];
    const z = vertices[i + 2];
    const wx = x * m[0] + y * m[3] + z * m[6] + m[9];
    const wy = x * m[1] + y * m[4] + z * m[7] + m[10];
    if (wx < box[0]) box[0] = wx;
    if (wy < box[1]) box[1] = wy;
    if (wx > box[2]) box[2] = wx;
    if (wy > box[3]) box[3] = wy;
  }
  return box;
}

export const emptyBounds = () => [Infinity, Infinity, -Infinity, -Infinity];

// Vertices of every mesh object in a Bambu/QIDI style archive, per build
// object id, with the component transforms to apply.
export function bambuObjectMeshes(files) {
  const byFile = new Map();
  const objectsIn = (path) => {
    if (!byFile.has(path)) byFile.set(path, files[path] ? scanModel(files[path]) : new Map());
    return byFile.get(path);
  };

  const resolve = (path, id, matrix, out, depth = 0) => {
    const obj = objectsIn(path).get(id);
    if (!obj || depth > 4) return;
    if (obj.vertices.length) out.push({ vertices: obj.vertices, matrix });
    for (const c of obj.components) resolve(c.path || path, c.objectId, multiply(c.matrix, matrix), out, depth + 1);
  };

  const result = new Map();
  for (const id of objectsIn('3D/3dmodel.model').keys()) {
    const parts = [];
    resolve('3D/3dmodel.model', id, IDENTITY, parts);
    result.set(id, parts);
  }
  return result;
}

// Streams through a model file (sub-models of reliefs can exceed the maximum
// JS string length) collecting vertices and components per object.
export function scanModel(bytes, chunkSize = 16 * 1024 * 1024) {
  const objects = new Map();
  const decoder = new TextDecoder();
  const token = /<object\b([^>]*)>|<vertex\b([^>]*)\/>|<component\b([^>]*)\/>/g;
  let current;
  let verts = new Float64Array(3 * 1024);
  let count = 0;
  const finish = () => {
    if (current) current.vertices = verts.slice(0, count);
  };
  let carry = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const text = carry + decoder.decode(bytes.subarray(offset, offset + chunkSize), { stream: offset + chunkSize < bytes.length });
    const end = offset + chunkSize < bytes.length ? text.lastIndexOf('>') + 1 : text.length;
    const body = text.slice(0, end);
    carry = text.slice(end);
    token.lastIndex = 0;
    for (let m; (m = token.exec(body));) {
      if (m[1] !== undefined) {
        finish();
        current = { vertices: new Float64Array(0), components: [] };
        objects.set(m[1].match(/\bid="([^"]*)"/)?.[1], current);
        count = 0;
      } else if (m[2] !== undefined && current) {
        if (count + 3 > verts.length) {
          const grown = new Float64Array(verts.length * 2);
          grown.set(verts);
          verts = grown;
        }
        verts[count++] = num(m[2], 'x');
        verts[count++] = num(m[2], 'y');
        verts[count++] = num(m[2], 'z');
      } else if (m[3] !== undefined && current) {
        current.components.push(component(m[3]));
      }
    }
  }
  finish();
  return objects;
}

function component(attrs) {
  return {
    path: attrs.match(/\bp:path="\/?([^"]*)"/)?.[1],
    objectId: attrs.match(/\bobjectid="([^"]*)"/)?.[1],
    matrix: parseMatrix(attrs.match(/\btransform="([^"]*)"/)?.[1]),
  };
}

// Rotation by 90° about the Z axis through (cx, cy).
export function rotate90About(cx, cy) {
  return [0, 1, 0, -1, 0, 0, 0, 0, 1, cx + cy, cy - cx, 0];
}

export function formatNumber(v) {
  if (Math.abs(v) < 1e-12) return '0';
  return String(Number(Number(v).toPrecision(12)));
}
