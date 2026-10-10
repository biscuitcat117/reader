// Draws the app icon: icons/icon-180.png and icon-512.png for the web app,
// plus the 1024px icon for the iOS app's asset catalog.
// Run with: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const SS = 3; // supersampling factor for smooth edges

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function png(size, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) rgb.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function draw(size) {
  const n = size * SS;
  const px = new Float32Array(n * n * 3);
  const u = n / 100; // design grid is 100×100

  for (let y = 0; y < n; y++) {
    const t = y / n;
    for (let x = 0; x < n; x++) {
      px.set([246 - 26 * t, 158 - 58 * t, 66 - 26 * t], (y * n + x) * 3);
    }
  }

  const rect = (x0, y0, x1, y1, r, color) => {
    for (let y = Math.floor(y0 * u); y < y1 * u; y++) {
      for (let x = Math.floor(x0 * u); x < x1 * u; x++) {
        const dx = Math.max(x0 * u + r * u - x, x - (x1 * u - r * u), 0);
        const dy = Math.max(y0 * u + r * u - y, y - (y1 * u - r * u), 0);
        if (dx * dx + dy * dy <= r * u * r * u) px.set(color, (y * n + x) * 3);
      }
    }
  };

  const paper = [255, 252, 246];
  const ink = [226, 205, 180];
  rect(17, 26, 49, 76, 3, paper);
  rect(51, 26, 83, 76, 3, paper);
  for (let i = 0; i < 6; i++) {
    const y = 34 + i * 6.5;
    rect(22, y, i === 5 ? 36 : 44, y + 2, 1, ink);
    rect(56, y, i === 2 ? 70 : 78, y + 2, 1, ink);
  }

  const out = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) sum += px[((y * SS + j) * n + x * SS + i) * 3 + c];
        out[(y * size + x) * 3 + c] = Math.round(sum / (SS * SS));
      }
    }
  }
  return png(size, out);
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
for (const size of [180, 512]) {
  writeFileSync(new URL(`../icons/icon-${size}.png`, import.meta.url), draw(size));
}
writeFileSync(new URL('../ios/Reader/Assets.xcassets/AppIcon.appiconset/icon-1024.png', import.meta.url), draw(1024));
