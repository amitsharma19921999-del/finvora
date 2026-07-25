// Generates the PWA icons (192/512 PNG) with zero dependencies: draws a dark
// gradient tile with three rising candlesticks, encodes PNG via node:zlib.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, draw) {
  const px = Buffer.alloc(size * size * 4);
  draw(px, size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const set = (px, size, x, y, r, g, b, a = 255) => {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
};

function rect(px, size, x0, y0, w, h, r, g, b) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(px, size, x, y, r, g, b);
}

function draw(px, size) {
  const u = size / 512; // design in 512-space
  // Background: charcoal vertical gradient (#16171a -> #0c0c0e), Finvora dark.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = y / size;
      set(px, size, x, y,
        Math.round(22 - t * 10),   // 22 -> 12
        Math.round(23 - t * 11),   // 23 -> 12
        Math.round(26 - t * 12));  // 26 -> 14
    }
  }
  const lime = [198, 246, 40]; // #c6f628
  const R = (x, y, w, h) => rect(px, size, Math.round(x * u), Math.round(y * u), Math.max(1, Math.round(w * u)), Math.max(1, Math.round(h * u)), ...lime);
  // Bold "F" monogram
  R(150, 140, 68, 250); // stem
  R(150, 140, 205, 64); // top bar
  R(150, 238, 150, 58); // middle bar
  // rising-candle accent to the right (brand motif)
  R(372, 278, 8, 132);  // wick
  R(360, 300, 32, 92);  // body
}

for (const size of [192, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), png(size, draw));
  console.log(`icons/icon-${size}.png written`);
}
