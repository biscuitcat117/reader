// Minimal ZIP reader (stored + deflate entries) — all an EPUB container needs.
export class Zip {
  constructor(buffer) {
    this.buf = buffer;
    this.view = new DataView(buffer);
    this.entries = new Map();
    this.lower = new Map();
    this._readDirectory();
  }

  _readDirectory() {
    const v = this.view;
    let eocd = -1;
    const min = Math.max(0, v.byteLength - 65557);
    for (let i = v.byteLength - 22; i >= min; i--) {
      if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This file is not a valid EPUB.');
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (v.getUint32(p, true) !== 0x02014b50) break;
      const method = v.getUint16(p + 10, true);
      const csize = v.getUint32(p + 20, true);
      const usize = v.getUint32(p + 24, true);
      const nlen = v.getUint16(p + 28, true);
      const xlen = v.getUint16(p + 30, true);
      const clen = v.getUint16(p + 32, true);
      const offset = v.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(this.buf, p + 46, nlen));
      this.entries.set(name, { method, csize, usize, offset });
      this.lower.set(name.toLowerCase(), name);
      p += 46 + nlen + xlen + clen;
    }
  }

  // Returns the stored entry name for a path, tolerating case differences.
  find(name) {
    if (this.entries.has(name)) return name;
    return this.lower.get(name.toLowerCase()) ?? null;
  }

  size(name) {
    const found = this.find(name);
    return found ? this.entries.get(found).usize : 0;
  }

  async bytes(name) {
    const found = this.find(name);
    if (!found) throw new Error(`Missing file in EPUB: ${name}`);
    const e = this.entries.get(found);
    const v = this.view;
    const nlen = v.getUint16(e.offset + 26, true);
    const xlen = v.getUint16(e.offset + 28, true);
    const raw = new Uint8Array(this.buf, e.offset + 30 + nlen + xlen, e.csize);
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new Error('Unsupported compression in EPUB.');
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser is too old to open EPUB files. Please update iPadOS.');
    }
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async text(name) {
    return new TextDecoder().decode(await this.bytes(name)).replace(/^﻿/, '');
  }
}
