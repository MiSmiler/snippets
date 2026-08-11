// Generates scripts/icon-src.png (1024x1024 RGBA): a rounded slate square
// with an emerald checkmark. Pure Node, no dependencies.
// Run via: node scripts/generate-icon.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 1024;
const CX = 512;
const CY = 512;
const HALF = 400; // rounded-rect half size
const RADIUS = 190; // corner radius
const STROKE_HALF = 46; // checkmark half stroke width

// Checkmark polyline segments (from,to).
const SEGMENTS = [
  [320, 540, 462, 682],
  [462, 682, 724, 362],
];

const BG = [30, 41, 59]; // slate-800
const CHECK = [52, 211, 153]; // emerald-400

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

// --- Assemble PNG -----------------------------------------------------------

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  raw[y * (1 + SIZE * 4)] = 0; // filter: none
  pixels.copy(raw, y * (1 + SIZE * 4) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr()),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync("scripts/icon-src.png", png);
console.log("wrote scripts/icon-src.png");
