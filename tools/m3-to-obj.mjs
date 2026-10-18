#!/usr/bin/env node
// Convert a StarCraft II .m3 model to .obj:
//   node tools/m3-to-obj.mjs <model.m3> <out.obj> [--regions 0,2] [--list]
//   node tools/m3-to-obj.mjs <model.m3> <out.obj> --anim Walk [--frames 8]
//
// --list     print the model's regions, textures and animation sequences
// --regions  export only these regions (default: every drawn region whose
//            material has a diffuse texture, i.e. not glow/FX planes)
// --anim     bake that animation sequence instead of the bind pose: one
//            "o <anim>_<k>" object per frame (all regions merged), evenly
//            spaced over the loop; the frames share one set of UVs
// --point    print where an attachment point (e.g. "Ref_Head") is, in OBJ
//            coordinates, instead of converting: --point "Ref_Head" [--anim Attack --at 420]
//
// Output matches what Blender's m3 import + OBJ export writes, which is what
// the game's loader expects: Y up (M3 is Z up), OpenGL-style UVs (v up), one
// "o region_N" object per region.
import fs from 'node:fs';
import path from 'node:path';
import { parseM3, skinMatrices, skinRegion, attachmentPosition, drawnRegions, pickRegions } from './m3.mjs';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] ?? '' : null; };
const list = args.includes('--list'); if (list) args.splice(args.indexOf('--list'), 1);
const only = flag('--regions'), anim = flag('--anim'), frameCount = +(flag('--frames') || 8);
const point = flag('--point'), at = +(flag('--at') || 0);
const [input, output] = args;
if (!input || (!output && !list && !point)) {
  console.error([
    'usage: node tools/m3-to-obj.mjs <model.m3> <out.obj> [--regions 0,2] [--anim Walk [--frames 8]]',
    '       node tools/m3-to-obj.mjs <model.m3> --list',
    '       node tools/m3-to-obj.mjs <model.m3> --point Ref_Head [--anim Attack --at 420]'].join('\n'));
  process.exit(1);
}

const m3 = parseM3(fs.readFileSync(input));

if (point) {
  const seq = anim ? m3.sequences.find(s => s.name === anim) : null;
  if (anim && !seq) { console.error(`no animation "${anim}"`); process.exit(1); }
  const [x, y, z] = attachmentPosition(m3, point, seq, at);
  console.log(`${point}${anim ? ` in "${anim}" at ${at} ms` : ' (initial pose)'}: [${[x, z, -y].map(c => +c.toFixed(3)).join(', ')}]  (OBJ coordinates, model units)`);
  process.exit(0);
}
const drawn = drawnRegions(m3);

if (list) {
  console.log(`${path.basename(input)}: ${m3.vertices.length} vertices, ${m3.faces.length / 3} triangles, ${m3.regions.length} regions`);
  for (const r of drawn) {
    const mat = r.material ? `${r.material.type} "${r.material.name}"` : 'not drawn';
    console.log(`  region ${r.index}: ${r.vertexCount} vertices, ${r.faceIndexCount / 3} triangles — ${mat}`);
    for (const [layer, tex] of Object.entries(r.material?.layers || {})) console.log(`      ${layer.padEnd(10)} ${tex}`);
  }
  console.log(`  animations: ${m3.sequences.map(s => `${s.name} (${s.length} ms)`).join(', ')}`);
  console.log(`  attachment points: ${m3.attachments.map(a => a.name).join(', ')}`);
  process.exit(0);
}

const picked = pickRegions(m3, only);   // --regions, else every textured region
if (!picked.length) { console.error('nothing to export (no textured regions — use --list and --regions)'); process.exit(1); }

const fmt = x => (Math.abs(x) < 5e-7 ? 0 : +x.toFixed(6));
const out = [
  `# ${path.basename(input)} → OBJ (${anim ? `"${anim}" animation, ${frameCount} frames` : 'bind pose'}) by tools/m3-to-obj.mjs`,
  `# regions: ${picked.map(r => r.index).join(', ')}`,
  ...[...new Set(picked.flatMap(r => Object.entries(r.material?.layers || {}).filter(([k]) => ['diffuse', 'emissive', 'normal'].includes(k)).map(([k, v]) => `#   ${k}: ${v}`)))],
];

if (anim) {
  const seq = m3.sequences.find(s => s.name === anim);
  if (!seq) { console.error(`no animation "${anim}" (have: ${m3.sequences.map(s => s.name).join(', ')})`); process.exit(1); }
  const f4 = x => (Math.abs(x) < 5e-5 ? 0 : +x.toFixed(4));          // frames: 0.1 mm is plenty
  const total = picked.reduce((s, r) => s + r.vertexCount, 0);
  out.push(`# loop: ${seq.length} ms, movement speed ${seq.speed / 100} SC2 units/s`);
  for (const r of picked) for (let i = r.firstVertex; i < r.firstVertex + r.vertexCount; i++) {
    const [u, v] = m3.vertices[i].uv[0];
    out.push(`vt ${fmt(u)} ${fmt(1 - v)}`);
  }
  for (let k = 0; k < frameCount; k++) {
    const mats = skinMatrices(m3, seq, (k / frameCount) * seq.length);
    out.push(`o ${anim}_${k}`);
    const posed = picked.map(r => skinRegion(m3, r, mats));
    for (const { positions } of posed) for (const [x, y, z] of positions) out.push(`v ${f4(x)} ${f4(z)} ${f4(-y)}`);
    for (const { normals } of posed) for (const [x, y, z] of normals) out.push(`vn ${+x.toFixed(3)} ${+z.toFixed(3)} ${+(-y).toFixed(3)}`);
    let vb = 1 + k * total, tb = 1;                                     // this frame's v/vn block · shared vt block
    for (const r of picked) {
      for (let f = r.firstFace; f < r.firstFace + r.faceIndexCount; f += 3) {
        out.push('f ' + [0, 1, 2].map(j => { const i = m3.faces[f + j]; return `${vb + i}/${tb + i}/${vb + i}`; }).join(' '));
      }
      vb += r.vertexCount; tb += r.vertexCount;
    }
  }
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, out.join('\n') + '\n');
  console.log(`${output}: "${anim}" ${frameCount} frames × ${total} vertices (regions ${picked.map(r => r.index).join(', ')})`);
  process.exit(0);
}

let base = 1;   // OBJ indices are 1-based and global
for (const r of picked) {
  out.push(`o region_${r.index}`);
  if (r.material) out.push(`usemtl ${r.material.name.replace(/\s+/g, '_') || 'material'}`);
  for (let i = r.firstVertex; i < r.firstVertex + r.vertexCount; i++) {
    const { position: [x, y, z] } = m3.vertices[i];
    out.push(`v ${fmt(x)} ${fmt(z)} ${fmt(-y)}`);              // Z up → Y up
  }
  for (let i = r.firstVertex; i < r.firstVertex + r.vertexCount; i++) {
    const [u, v] = m3.vertices[i].uv[0];
    out.push(`vt ${fmt(u)} ${fmt(1 - v)}`);                    // M3 v runs down
  }
  for (let i = r.firstVertex; i < r.firstVertex + r.vertexCount; i++) {
    const [x, y, z] = m3.vertices[i].normal, len = Math.hypot(x, y, z) || 1;
    out.push(`vn ${fmt(x / len)} ${fmt(z / len)} ${fmt(-y / len)}`);
  }
  for (let f = r.firstFace; f < r.firstFace + r.faceIndexCount; f += 3) {
    const [a, b, c] = [0, 1, 2].map(k => base + m3.faces[f + k]);
    out.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
  }
  base += r.vertexCount;
}
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, out.join('\n') + '\n');
console.log(`${output}: regions ${picked.map(r => r.index).join(', ')} — ${picked.reduce((s, r) => s + r.vertexCount, 0)} vertices, ${picked.reduce((s, r) => s + r.faceIndexCount / 3, 0)} triangles`);
