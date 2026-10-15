// Draws the extension icon (an isometric cube on a rounded square) as PNGs.
// Usage: node scripts/make-icons.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.join(import.meta.dirname, '..', 'extension', 'icons');
const SS = 4; // supersampling per axis

const BG = [11, 116, 209];
const TOP = [255, 255, 255];
const LEFT = [214, 232, 250];
const RIGHT = [160, 200, 240];

function inRoundedSquare(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Cube centred in the unit square.
const c = [0.5, 0.52];
const s = 0.27;
const h = s * Math.tan(Math.PI / 6);
const top = [[c[0], c[1] - 2 * h - s * 0.15], [c[0] + s, c[1] - h - s * 0.15], [c[0], c[1] - s * 0.15], [c[0] - s, c[1] - h - s * 0.15]];
const left = [[c[0] - s, c[1] - h - s * 0.15 + 0.02], [c[0] - 0.012, c[1] - s * 0.15 + 0.02], [c[0] - 0.012, c[1] + s + 0.02], [c[0] - s, c[1] + s - h + 0.02]];
const right = [[c[0] + 0.012, c[1] - s * 0.15 + 0.02], [c[0] + s, c[1] - h - s * 0.15 + 0.02], [c[0] + s, c[1] + s - h + 0.02], [c[0] + 0.012, c[1] + s + 0.02]];

function pixel(x, y) {
  if (!inRoundedSquare(x, y, 0.22)) return null;
  if (inPolygon(x, y, top)) return TOP;
  if (inPolygon(x, y, left)) return LEFT;
  if (inPolygon(x, y, right)) return RIGHT;
  return BG;
}

function render(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const col = pixel((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          if (!col) continue;
          r += col[0];
          g += col[1];
          b += col[2];
          a++;
        }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((255 * a) / (SS * SS));
    }
  }
  return png(size, size, raw);
}

function png(w, h, raw) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) fs.writeFileSync(path.join(OUT, `icon${size}.png`), render(size));
console.log(`Icons written to ${OUT}`);
