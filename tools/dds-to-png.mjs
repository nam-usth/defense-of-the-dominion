#!/usr/bin/env node
// Convert a .dds texture (DXT1, DXT5 or uncompressed 32-bit) to .png, top mip only:
//   node tools/dds-to-png.mjs <in.dds> <out.png> [--size 64] [--channel a]
//
// Browsers cannot show DDS in HTML, so HUD icons are converted to PNG.
// --size    resize (box filter) to this width/height
// --channel write one channel as greyscale (r, g, b or a) — handy for looking
//           at team-colour masks and normal maps
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

export function decodeDDS(buf) {
  if (buf.toString('latin1', 0, 4) !== 'DDS ') throw new Error('not a DDS file');
  const height = buf.readUInt32LE(12), width = buf.readUInt32LE(16);
  const pfFlags = buf.readUInt32LE(80), fourCC = buf.toString('latin1', 84, 88);
  const rgba = new Uint8Array(width * height * 4);
  let o = 128;
  if (pfFlags & 0x4) {                                   // compressed (FOURCC)
    if (fourCC !== 'DXT1' && fourCC !== 'DXT5') throw new Error(`unsupported DDS format ${fourCC}`);
    const dxt5 = fourCC === 'DXT5';
    for (let by = 0; by < height; by += 4) for (let bx = 0; bx < width; bx += 4) {
      let alpha = null;
      if (dxt5) {
        const a0 = buf[o], a1 = buf[o + 1];
        const pal = [a0, a1];
        if (a0 > a1) for (let i = 1; i <= 6; i++) pal.push(((7 - i) * a0 + i * a1) / 7);
        else { for (let i = 1; i <= 4; i++) pal.push(((5 - i) * a0 + i * a1) / 5); pal.push(0, 255); }
        let bits = 0n; for (let i = 0; i < 6; i++) bits |= BigInt(buf[o + 2 + i]) << BigInt(8 * i);
        alpha = Array.from({ length: 16 }, (_, i) => pal[Number((bits >> BigInt(3 * i)) & 7n)]);
        o += 8;
      }
      const c0 = buf.readUInt16LE(o), c1 = buf.readUInt16LE(o + 2), idx = buf.readUInt32LE(o + 4);
      o += 8;
      const rgb = c => [(c >> 11 & 31) * 255 / 31, (c >> 5 & 63) * 255 / 63, (c & 31) * 255 / 31];
      const p0 = rgb(c0), p1 = rgb(c1);
      const four = dxt5 || c0 > c1;
      const pal = [p0, p1,
        four ? p0.map((v, k) => (2 * v + p1[k]) / 3) : p0.map((v, k) => (v + p1[k]) / 2),
        four ? p0.map((v, k) => (v + 2 * p1[k]) / 3) : [0, 0, 0]];
      for (let i = 0; i < 16; i++) {
        const x = bx + (i & 3), y = by + (i >> 2);
        if (x >= width || y >= height) continue;
        const sel = idx >> (2 * i) & 3, d = (y * width + x) * 4;
        rgba[d] = pal[sel][0]; rgba[d + 1] = pal[sel][1]; rgba[d + 2] = pal[sel][2];
        rgba[d + 3] = alpha ? alpha[i] : (!four && sel === 3 ? 0 : 255);
      }
    }
  } else {                                               // uncompressed, masks give the channel order
    const bits = buf.readUInt32LE(88);
    if (bits !== 32 && bits !== 24) throw new Error(`unsupported uncompressed DDS (${bits} bits)`);
    const masks = [92, 96, 100, 104].map(at => buf.readUInt32LE(at));
    const shift = m => (m ? Math.log2(m & -m) : -1);
    const shifts = masks.map(shift), hasAlpha = pfFlags & 0x1, step = bits / 8;
    for (let i = 0; i < width * height; i++, o += step) {
      const px = step === 4 ? buf.readUInt32LE(o) : buf.readUIntLE(o, 3);
      for (let k = 0; k < 3; k++) rgba[i * 4 + k] = (px >>> shifts[k]) & 255;
      rgba[i * 4 + 3] = hasAlpha && shifts[3] >= 0 ? (px >>> shifts[3]) & 255 : 255;
    }
  }
  return { width, height, fourCC: pfFlags & 0x4 ? fourCC : 'RGBA', rgba };
}

export function encodePNG(width, height, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;  // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function resize({ width, height, rgba }, size) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const x0 = Math.floor(x * width / size), x1 = Math.max(x0 + 1, Math.floor((x + 1) * width / size));
    const y0 = Math.floor(y * height / size), y1 = Math.max(y0 + 1, Math.floor((y + 1) * height / size));
    const acc = [0, 0, 0, 0]; let n = 0;
    for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
      const s = (sy * width + sx) * 4, a = rgba[s + 3] / 255;
      acc[0] += rgba[s] * a; acc[1] += rgba[s + 1] * a; acc[2] += rgba[s + 2] * a; acc[3] += a; n++;
    }
    const d = (y * size + x) * 4;
    for (let k = 0; k < 3; k++) out[d + k] = acc[3] ? acc[k] / acc[3] : 0;   // alpha-weighted: no dark fringes
    out[d + 3] = acc[3] / n * 255;
  }
  return { width: size, height: size, rgba: out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const size = opt('--size'), channel = opt('--channel');
  const [input, output] = args;
  if (!input || !output) { console.error('usage: node tools/dds-to-png.mjs <in.dds> <out.png> [--size 64] [--channel a]'); process.exit(1); }
  let img = decodeDDS(fs.readFileSync(input));
  const format = img.fourCC;
  if (channel) {
    const k = 'rgba'.indexOf(channel);
    if (k < 0) throw new Error('--channel must be r, g, b or a');
    for (let i = 0; i < img.rgba.length; i += 4) { const v = img.rgba[i + k]; img.rgba[i] = img.rgba[i + 1] = img.rgba[i + 2] = v; img.rgba[i + 3] = 255; }
  }
  if (size) img = resize(img, +size);
  fs.writeFileSync(output, encodePNG(img.width, img.height, img.rgba));
  console.log(`${output}: ${img.width}×${img.height} (from ${format})`);
}
