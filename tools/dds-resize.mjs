#!/usr/bin/env node
// Shrink a .dds texture by dropping its largest mip levels (no recompression):
//   node tools/dds-resize.mjs <in.dds> <out.dds> --max 512
//
// SC2 textures carry a full mip chain, so the 512² level of a 1024² map is
// already in the file: the result is exactly what the GPU samples once the
// model is small on screen, at a quarter of the size. The units are a few
// dozen pixels tall at the game's zoom, so 512² loses nothing visible.
// Works for 2D DXT1, DXT5 and uncompressed textures (not cube maps or
// volumes); a file already at or below --max (or without mipmaps) is copied unchanged.
import fs from 'node:fs';

const args = process.argv.slice(2);
const i = args.indexOf('--max');
const max = i >= 0 ? +args.splice(i, 2)[1] : NaN;
const [input, output] = args;
if (!input || !output || !(max > 0)) {
  console.error('usage: node tools/dds-resize.mjs <in.dds> <out.dds> --max 512');
  process.exit(1);
}

const buf = fs.readFileSync(input);
if (buf.toString('latin1', 0, 4) !== 'DDS ') throw new Error(`${input}: not a DDS file`);
const DDSD_MIPMAPCOUNT = 0x20000, DDPF_FOURCC = 0x4;
const height = buf.readUInt32LE(12), width = buf.readUInt32LE(16);
const flags = buf.readUInt32LE(8), mips = flags & DDSD_MIPMAPCOUNT ? Math.max(1, buf.readUInt32LE(28)) : 1;
const pfFlags = buf.readUInt32LE(80), fourCC = buf.toString('latin1', 84, 88), bitCount = buf.readUInt32LE(88);
const DDSCAPS2_CUBEMAP = 0x200, DDSCAPS2_VOLUME = 0x200000;
if (buf.readUInt32LE(112) & (DDSCAPS2_CUBEMAP | DDSCAPS2_VOLUME)) throw new Error(`${input}: cube maps and volume textures are not supported`);
if (pfFlags & DDPF_FOURCC && fourCC === 'DX10') throw new Error(`${input}: DX10 header not supported`);
// bytes of one mip level
const blockBytes = pfFlags & DDPF_FOURCC ? { DXT1: 8, DXT3: 16, DXT5: 16 }[fourCC] : 0;
if (pfFlags & DDPF_FOURCC && !blockBytes) throw new Error(`${input}: unsupported format ${fourCC}`);
const levelSize = (w, h) => blockBytes ? Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * blockBytes : w * h * (bitCount >> 3);

let skip = 0, w = width, h = height, offset = 128;
while (skip < mips - 1 && Math.max(w, h) > max) { offset += levelSize(w, h); w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); skip++; }
if (!skip) { fs.copyFileSync(input, output); console.log(`${output}: ${width}×${height} (unchanged)`); process.exit(0); }

const out = Buffer.concat([buf.subarray(0, 128), buf.subarray(offset)]);
out.writeUInt32LE(h, 12); out.writeUInt32LE(w, 16);
out.writeUInt32LE(mips - skip, 28);
out.writeUInt32LE(blockBytes ? levelSize(w, h) : w * (bitCount >> 3), 20);   // linear size / pitch of the new top level
fs.writeFileSync(output, out);
console.log(`${output}: ${width}×${height} → ${w}×${h} (${mips - skip} mips), ${(buf.length / 1024) | 0} → ${(out.length / 1024) | 0} KB`);
