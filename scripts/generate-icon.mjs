// Generates the app icon source PNGs (1024x1024 RGBA): a rounded square with
// an emerald checkmark, in light and dark variants. Pure Node, no dependencies.
// Run via: node scripts/generate-icon.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 1024;
const CX = 512;
const CY = 512;
const SCALE = 1.15; // overall icon scale: grows the rounded rect and checkmark around the canvas center (smaller margin)
const HALF = 400 * SCALE; // rounded-rect half size
const RADIUS = 190 * SCALE; // corner radius
const STROKE_HALF = 46 * SCALE; // checkmark half stroke width

// Scale a coordinate around the canvas center (direct multiplication would
// drift the checkmark away from center).
const S = (v) => CX + (v - CX) * SCALE;

// Checkmark polyline segments (from,to).
const SEGMENTS = [
  [S(320), S(540), S(462), S(682)],
  [S(462), S(682), S(724), S(362)],
];

// Icon variants: background + checkmark color, and the output file.
const VARIANTS = [
  {
    name: "light",
    BG: [255, 255, 255], // white
    CHECK: [5, 150, 105], // emerald-600
    file: "scripts/icon-src-light.png",
  },
  {
    name: "dark",
    BG: [30, 41, 59], // slate-800
    CHECK: [52, 211, 153], // emerald-400
    file: "scripts/icon-src-dark.png",
  },
];

// --- PNG encoding -----------------------------------------------------------

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function ihdr() {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(SIZE, 0);
  b.writeUInt32BE(SIZE, 4);
  b[8] = 8; // bit depth
  b[9] = 6; // color type: RGBA
  return b;
}

// --- Rasterize --------------------------------------------------------------

function segDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)),
  );
  const dx = px - (ax + t * abx);
  const dy = py - (ay + t * aby);
  return Math.hypot(dx, dy);
}

function render(BG, CHECK) {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Rounded-rect SDF -> background alpha (1px antialias edge).
      const qx = Math.abs(x - CX) - (HALF - RADIUS);
      const qy = Math.abs(y - CY) - (HALF - RADIUS);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - RADIUS;
      const bgA = Math.min(1, Math.max(0, 0.5 - d));

      let cr = BG[0];
      let cg = BG[1];
      let cb = BG[2];
      let ca = bgA;

      if (bgA > 0) {
        let dmin = Infinity;
        for (const [ax, ay, bx, by] of SEGMENTS) {
          dmin = Math.min(dmin, segDist(x, y, ax, ay, bx, by));
        }
        const ckA = Math.min(1, Math.max(0, 0.5 - (dmin - STROKE_HALF)));
        cr += (CHECK[0] - cr) * ckA;
        cg += (CHECK[1] - cg) * ckA;
        cb += (CHECK[2] - cb) * ckA;
      }

      const i = (y * SIZE + x) * 4;
      pixels[i] = Math.round(cr);
      pixels[i + 1] = Math.round(cg);
      pixels[i + 2] = Math.round(cb);
      pixels[i + 3] = Math.round(ca * 255);
    }
  }
  return pixels;
}

// --- Assemble PNG -----------------------------------------------------------

function encodePng(pixels) {
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (1 + SIZE * 4)] = 0; // filter: none
    pixels.copy(raw, y * (1 + SIZE * 4) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr()),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const variant of VARIANTS) {
  writeFileSync(variant.file, encodePng(render(variant.BG, variant.CHECK)));
  console.log(`wrote ${variant.file} (${variant.name})`);
}
