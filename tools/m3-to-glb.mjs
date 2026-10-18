#!/usr/bin/env node
// Convert a StarCraft II .m3 model to binary glTF 2.0 (.glb):
//   node tools/m3-to-glb.mjs <model.m3> <out.glb> [--regions 0,2] [--anims Walk,Attack] [--frames 8 | Walk:32,Attack:8]
//   node tools/m3-to-glb.mjs --check <file.glb>
//
// One self-contained file with the geometry tools/m3-to-obj.mjs writes, in
// less space and without text parsing:
//   - bind pose: one mesh node "region_N" per exported region (same region
//     choice, vertices, UVs, normals and axes as the OBJ: Y up, v up)
//   - --anims: for each sequence, --frames nodes "<Anim>_<k>" (all regions
//     merged), posed at k/frames of the loop like m3-to-obj --anim. --frames is
//     one count for every animation ("8") or per animation ("Walk:32,Attack:8";
//     a bare number sets the others, default 8), as import-sc2's frames. Every frame
//     reuses the model's UV accessor and one index accessor: only POSITION and
//     NORMAL are stored per frame.
//   - no materials or textures (the game textures models from ASSETS.tex)
//   - asset.extras: source, regions, anims { loopMs, moveSpeed (SC2 units/s), frames };
//     node.extras: region, material and textures / anim, frame, timeMs
// Indexed triangles (uint16 when the vertex count allows), float32 attributes.
// The written file is read back and checked (--check runs the same checks).
import fs from 'node:fs';
import path from 'node:path';
import { parseM3, skinMatrices, skinRegion, pickRegions } from './m3.mjs';

const FLOAT = 5126, U16 = 5123, U32 = 5125, ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;   // glTF component types, view targets

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] ?? '' : null; };
const checkOnly = flag('--check');
if (checkOnly !== null) {
  const r = validateGlb(fs.readFileSync(checkOnly));
  console.log(`${checkOnly}: ${r.ok ? 'valid' : 'INVALID'} — ${r.summary}`);
  for (const e of r.errors) console.log('  error: ' + e);
  for (const w of r.warnings) console.log('  warning: ' + w);
  process.exit(r.ok ? 0 : 1);
}
const only = flag('--regions'), animNames = flag('--anims'), framesArg = flag('--frames');
const [input, output] = args;
if (!input || !output) {
  console.error([
    'usage: node tools/m3-to-glb.mjs <model.m3> <out.glb> [--regions 0,2] [--anims Walk,Attack] [--frames 8 | Walk:32,Attack:8]',
    '       node tools/m3-to-glb.mjs --check <file.glb>'].join('\n'));
  process.exit(1);
}
// frames per animation: '' = the count of every animation not named
const frameSpec = { '': 8 };
for (const part of (framesArg || '8').split(',')) {
  const m = /^(?:([^:]+):)?(\d+)$/.exec(part.trim());
  if (!m || +m[2] < 1) { console.error(`--frames: "${part}" is not N or Anim:N with N ≥ 1`); process.exit(1); }
  frameSpec[m[1] ?? ''] = +m[2];
}

const m3 = parseM3(fs.readFileSync(input));
const picked = pickRegions(m3, only);   // --regions, else every textured region (as m3-to-obj)
if (!picked.length) { console.error('nothing to export (no textured regions — use m3-to-obj --list and --regions)'); process.exit(1); }
const anims = (animNames ? animNames.split(',') : []).map(name => {
  const seq = m3.sequences.find(s => s.name === name);
  if (!seq) { console.error(`no animation "${name}" (have: ${m3.sequences.map(s => s.name).join(', ')})`); process.exit(1); }
  return seq;
});
if (new Set(anims.map(s => s.name)).size !== anims.length) { console.error('--anims lists an animation twice'); process.exit(1); }
for (const name of Object.keys(frameSpec)) if (name && !anims.some(s => s.name === name)) { console.error(`--frames names "${name}", which --anims does not list`); process.exit(1); }
const framesOf = seq => frameSpec[seq.name] ?? frameSpec[''];
for (const r of picked) for (let f = r.firstFace; f < r.firstFace + r.faceIndexCount; f++) {
  if (m3.faces[f] >= r.vertexCount) { console.error(`region ${r.index}: face index ${m3.faces[f]} ≥ its ${r.vertexCount} vertices`); process.exit(1); }
}

// ── Binary chunk: 4-byte aligned bufferViews, accessors into them ───────────
const bin = [], bufferViews = [], accessors = [];
let binLength = 0;
function addView(typed, target) {
  const pad = (4 - binLength % 4) % 4;
  if (pad) { bin.push(Buffer.alloc(pad)); binLength += pad; }
  bin.push(Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength));
  bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: typed.byteLength, target });
  binLength += typed.byteLength;
  return bufferViews.length - 1;
}
// float VEC2/VEC3 accessor over `count` items from item `first` of a view
// holding `data`; POSITION gets the min/max glTF requires (of the float32 values)
function addFloats(view, data, size, first, count, bounds) {
  const a = { bufferView: view, byteOffset: first * size * 4, componentType: FLOAT, count, type: 'VEC' + size };
  if (bounds) {
    a.min = [Infinity, Infinity, Infinity]; a.max = [-Infinity, -Infinity, -Infinity];
    for (let i = first * 3; i < (first + count) * 3; i++) { const c = i % 3; a.min[c] = Math.min(a.min[c], data[i]); a.max[c] = Math.max(a.max[c], data[i]); }
  }
  return accessors.push(a) - 1;
}
function addIndices(view, data, first, count) {
  return accessors.push({ bufferView: view, byteOffset: first * data.BYTES_PER_ELEMENT, componentType: data.BYTES_PER_ELEMENT === 2 ? U16 : U32, count, type: 'SCALAR' }) - 1;
}
// uint16 indices unless a primitive has more vertices (65535 is WebGL2's primitive restart index)
const indexArray = (n, maxVertices) => (maxVertices <= 65535 ? new Uint16Array(n) : new Uint32Array(n));

// ── Bind pose: regions side by side in shared position / normal / UV / index views ──
const total = picked.reduce((s, r) => s + r.vertexCount, 0);
const corners = picked.reduce((s, r) => s + r.faceIndexCount, 0);
const bindPos = new Float32Array(total * 3), bindNrm = new Float32Array(total * 3), uvs = new Float32Array(total * 2);
const bindIdx = indexArray(corners, Math.max(...picked.map(r => r.vertexCount)));
{
  let v = 0, c = 0;
  for (const r of picked) {
    for (let i = r.firstVertex; i < r.firstVertex + r.vertexCount; i++, v++) {
      const { position: [x, y, z], normal: [nx, ny, nz], uv: [[u, w]] } = m3.vertices[i], len = Math.hypot(nx, ny, nz) || 1;
      bindPos.set([x, z, -y], v * 3);                               // Z up → Y up
      bindNrm.set([nx / len, nz / len, -ny / len], v * 3);
      uvs.set([u, 1 - w], v * 2);                                   // M3 v runs down
    }
    for (let f = r.firstFace; f < r.firstFace + r.faceIndexCount; f++) bindIdx[c++] = m3.faces[f];   // region-relative
  }
}
const posView = addView(bindPos, ARRAY_BUFFER), nrmView = addView(bindNrm, ARRAY_BUFFER);
const uvView = addView(uvs, ARRAY_BUFFER), idxView = addView(bindIdx, ELEMENT_ARRAY_BUFFER);
const meshes = [], nodes = [];
{
  let v = 0, c = 0;
  for (const r of picked) {
    const name = `region_${r.index}`;
    const textures = Object.fromEntries(Object.entries(r.material?.layers || {}).filter(([k]) => ['diffuse', 'emissive', 'normal'].includes(k)));
    r.uvAccessor = addFloats(uvView, uvs, 2, v, r.vertexCount);
    r.idxAccessor = addIndices(idxView, bindIdx, c, r.faceIndexCount);
    meshes.push({ name, primitives: [{ attributes: { POSITION: addFloats(posView, bindPos, 3, v, r.vertexCount, true), NORMAL: addFloats(nrmView, bindNrm, 3, v, r.vertexCount), TEXCOORD_0: r.uvAccessor }, indices: r.idxAccessor, mode: 4 }] });
    nodes.push({ name, mesh: meshes.length - 1, extras: { region: r.index, material: r.material?.name ?? null, textures } });
    v += r.vertexCount; c += r.faceIndexCount;
  }
}

// ── Baked frames: one merged primitive per frame, UVs and indices shared ─────
const animInfo = {};
if (anims.length) {
  // one region: its own UV / index accessors already describe the merged mesh
  let frameUv = picked[0].uvAccessor, frameIdx = picked[0].idxAccessor;
  if (picked.length > 1) {
    const merged = indexArray(corners, total);
    let c = 0, base = 0;
    for (const r of picked) {
      for (let f = r.firstFace; f < r.firstFace + r.faceIndexCount; f++) merged[c++] = base + m3.faces[f];
      base += r.vertexCount;
    }
    frameUv = addFloats(uvView, uvs, 2, 0, total);
    frameIdx = addIndices(addView(merged, ELEMENT_ARRAY_BUFFER), merged, 0, corners);
  }
  for (const seq of anims) {
    const frameCount = framesOf(seq);
    const pos = new Float32Array(frameCount * total * 3), nrm = new Float32Array(frameCount * total * 3);
    for (let k = 0; k < frameCount; k++) {
      const mats = skinMatrices(m3, seq, (k / frameCount) * seq.length);
      let o = k * total * 3;
      for (const r of picked) {
        const { positions, normals } = skinRegion(m3, r, mats);
        positions.forEach(([x, y, z], i) => { pos.set([x, z, -y], o + i * 3); const [nx, ny, nz] = normals[i]; nrm.set([nx, nz, -ny], o + i * 3); });
        o += r.vertexCount * 3;
      }
    }
    const pv = addView(pos, ARRAY_BUFFER), nv = addView(nrm, ARRAY_BUFFER);
    animInfo[seq.name] = { loopMs: seq.length, moveSpeed: seq.speed / 100, frames: frameCount };
    for (let k = 0; k < frameCount; k++) {
      const name = `${seq.name}_${k}`;
      meshes.push({ name, primitives: [{ attributes: { POSITION: addFloats(pv, pos, 3, k * total, total, true), NORMAL: addFloats(nv, nrm, 3, k * total, total), TEXCOORD_0: frameUv }, indices: frameIdx, mode: 4 }] });
      nodes.push({ name, mesh: meshes.length - 1, extras: { anim: seq.name, frame: k, timeMs: (k / frameCount) * seq.length, loopMs: seq.length, moveSpeed: seq.speed / 100 } });
    }
  }
}

// ── GLB container: 12-byte header, JSON chunk (space padded), BIN chunk (zero padded) ──
const gltf = {
  asset: { version: '2.0', generator: 'tools/m3-to-glb.mjs', extras: { source: path.basename(input), regions: picked.map(r => r.index), anims: animInfo } },
  scene: 0, scenes: [{ name: m3.name || path.basename(input, '.m3'), nodes: nodes.map((_, i) => i) }],
  nodes, meshes, accessors, bufferViews, buffers: [{ byteLength: binLength }],
};
const pad4 = (b, fill) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - b.length % 4, fill)]) : b);
const json = pad4(Buffer.from(JSON.stringify(gltf)), 0x20), data = pad4(Buffer.concat(bin), 0);
const header = Buffer.alloc(12), chunkHeader = (length, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(length, 0); h.writeUInt32LE(type, 4); return h; };
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + data.length, 8);   // "glTF", version 2
const glb = Buffer.concat([header, chunkHeader(json.length, 0x4e4f534a), json, chunkHeader(data.length, 0x004e4942), data]);   // "JSON", "BIN\0"
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, glb);

const check = validateGlb(fs.readFileSync(output));
const frames = anims.map(s => `${s.name} ${framesOf(s)}`).join(' + ');
console.log(`${output}: regions ${picked.map(r => r.index).join(', ')} — ${total} vertices, ${corners / 3} triangles${frames ? `, frames ${frames} × ${total} vertices` : ''}, ${glb.length} bytes (${check.ok ? 'valid' : 'INVALID'})`);
for (const e of check.errors) console.error('  error: ' + e);
for (const w of check.warnings) console.error('  warning: ' + w);
if (!check.ok) process.exit(1);

// ── Structure check of a .glb as this tool writes it (no extensions, no strides) ──
function validateGlb(buf) {
  const errors = [], warnings = [], err = m => errors.push(m);
  const done = summary => ({ ok: !errors.length, errors, warnings, summary });
  if (buf.length < 28 || buf.readUInt32LE(0) !== 0x46546c67) { err('not a GLB file'); return done('-'); }
  if (buf.readUInt32LE(4) !== 2) err(`container version ${buf.readUInt32LE(4)}, expected 2`);
  if (buf.readUInt32LE(8) !== buf.length) err(`header length ${buf.readUInt32LE(8)} ≠ file size ${buf.length}`);
  if (buf.length % 4) err(`file size ${buf.length} not a multiple of 4`);
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) err('first chunk is not JSON');
  if (jsonLen % 4) err(`JSON chunk length ${jsonLen} not a multiple of 4`);
  const binAt = 20 + jsonLen;
  if (binAt + 8 > buf.length) { err('BIN chunk missing'); return done('-'); }
  const binLen = buf.readUInt32LE(binAt);
  if (buf.readUInt32LE(binAt + 4) !== 0x004e4942) err('second chunk is not BIN');
  if (binLen % 4) err(`BIN chunk length ${binLen} not a multiple of 4`);
  if (binAt + 8 + binLen !== buf.length) { err(`chunks end at ${binAt + 8 + binLen}, file at ${buf.length}`); return done('-'); }
  let g;
  try { g = JSON.parse(buf.toString('utf8', 20, binAt)); } catch (e) { err('JSON chunk: ' + e.message); return done('-'); }
  const binData = buf.subarray(binAt + 8, binAt + 8 + binLen);
  if (g.asset?.version !== '2.0') err(`asset.version ${g.asset?.version}`);
  if (g.extensionsUsed?.length || g.extensionsRequired?.length) err('extensions are not expected');
  if (g.buffers?.length !== 1 || g.buffers[0].uri !== undefined) err('expected exactly one buffer: the BIN chunk');
  const bufLen = g.buffers?.[0]?.byteLength ?? 0;
  if (bufLen > binLen || binLen - bufLen > 3) err(`buffer byteLength ${bufLen} vs BIN chunk ${binLen}`);
  (g.bufferViews || []).forEach((v, i) => {
    if (v.buffer !== 0) err(`bufferView ${i}: buffer ${v.buffer}`);
    if ((v.byteOffset || 0) % 4) err(`bufferView ${i}: byteOffset ${v.byteOffset} not 4-aligned`);
    if ((v.byteOffset || 0) + v.byteLength > bufLen) err(`bufferView ${i}: ends at ${(v.byteOffset || 0) + v.byteLength} > buffer ${bufLen}`);
    if (v.byteStride !== undefined) err(`bufferView ${i}: byteStride not expected`);
  });
  const SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }, COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const READ = { 5123: (o) => binData.readUInt16LE(o), 5125: (o) => binData.readUInt32LE(o), 5126: (o) => binData.readFloatLE(o) };
  // accessor i → its values (plain numbers), after the bounds checks
  const values = (g.accessors || []).map((a, i) => {
    const v = g.bufferViews?.[a.bufferView], size = SIZE[a.componentType], n = COMPONENTS[a.type];
    if (!v || !size || !n || !READ[a.componentType]) { err(`accessor ${i}: bad bufferView / componentType / type`); return null; }
    const off = a.byteOffset || 0;
    if (off % size || ((v.byteOffset || 0) + off) % size) err(`accessor ${i}: offset ${off} not aligned to its ${size}-byte components`);
    if (a.type !== 'SCALAR' && (size * n) % 4) err(`accessor ${i}: ${a.type} of ${size}-byte components is not 4-byte aligned per element`);
    if (!(a.count > 0)) err(`accessor ${i}: count ${a.count}`);
    if (off + a.count * size * n > v.byteLength) { err(`accessor ${i}: ends at ${off + a.count * size * n} > bufferView ${a.bufferView} (${v.byteLength} bytes)`); return null; }
    const out = new Float64Array(a.count * n), at = (v.byteOffset || 0) + off;
    for (let k = 0; k < out.length; k++) out[k] = READ[a.componentType](at + k * size);
    if (out.some(x => !Number.isFinite(x))) err(`accessor ${i}: NaN or infinite values`);
    if (a.min || a.max) {
      for (let c = 0; c < n; c++) {
        let lo = Infinity, hi = -Infinity;
        for (let k = c; k < out.length; k += n) { lo = Math.min(lo, out[k]); hi = Math.max(hi, out[k]); }
        if (a.min?.[c] !== lo || a.max?.[c] !== hi) err(`accessor ${i}: min/max [${a.min}]/[${a.max}] ≠ data component ${c} (${lo}, ${hi})`);
      }
    }
    return out;
  });
  let vertices = 0, triangles = 0, nonUnit = 0;
  (g.meshes || []).forEach((m, mi) => m.primitives.forEach((p, pi) => {
    const where = `mesh ${mi} "${m.name}" primitive ${pi}`, at = p.attributes || {};
    if ((p.mode ?? 4) !== 4) err(`${where}: mode ${p.mode}, expected triangles`);
    for (const name of ['POSITION', 'NORMAL', 'TEXCOORD_0']) if (g.accessors?.[at[name]] === undefined) err(`${where}: no ${name}`);
    const pos = g.accessors?.[at.POSITION], count = pos?.count;
    if (pos && (pos.type !== 'VEC3' || pos.componentType !== FLOAT || !pos.min || !pos.max)) err(`${where}: POSITION must be float VEC3 with min/max`);
    for (const [name, a] of Object.entries(at)) {
      if (g.accessors?.[a]?.count !== count) err(`${where}: ${name} count ${g.accessors?.[a]?.count} ≠ POSITION count ${count}`);
      if (g.bufferViews?.[g.accessors?.[a]?.bufferView]?.target !== ARRAY_BUFFER) err(`${where}: ${name} view is not an ARRAY_BUFFER`);
    }
    const nrm = values[at.NORMAL];
    if (nrm) for (let k = 0; k < nrm.length; k += 3) if (Math.abs(Math.hypot(nrm[k], nrm[k + 1], nrm[k + 2]) - 1) > 1e-4) nonUnit++;
    const ia = g.accessors?.[p.indices], idx = values[p.indices];
    if (!ia || ia.type !== 'SCALAR' || ![U16, U32].includes(ia.componentType)) { err(`${where}: indices missing or not uint16/uint32`); return; }
    if (g.bufferViews?.[ia.bufferView]?.target !== ELEMENT_ARRAY_BUFFER) err(`${where}: index view is not an ELEMENT_ARRAY_BUFFER`);
    if (ia.count % 3) err(`${where}: ${ia.count} indices is not whole triangles`);
    if (idx) {
      let bad = 0;
      for (const k of idx) if (k >= count || (ia.componentType === U16 && k === 65535)) bad++;
      if (bad) err(`${where}: ${bad} indices out of range (${count} vertices)`);
    }
    vertices += count || 0; triangles += ia.count / 3;
  }));
  if (nonUnit) warnings.push(`${nonUnit} normals are not unit length`);
  const sceneNodes = g.scenes?.[g.scene ?? 0]?.nodes || [];
  if (sceneNodes.length !== (g.nodes || []).length || new Set(sceneNodes).size !== sceneNodes.length) err('the scene does not list every node once');
  (g.nodes || []).forEach((n, i) => { if (g.meshes?.[n.mesh] === undefined) err(`node ${i} "${n.name}": no mesh`); });
  // frames of one animation must share UVs and indices (the point of the format)
  const groups = {};
  for (const n of g.nodes || []) { const m = /^(.+)_(\d+)$/.exec(n.name); if (m && m[1] !== 'region') (groups[m[1]] ||= []).push(g.meshes[n.mesh]?.primitives[0]); }
  for (const [anim, prims] of Object.entries(groups)) {
    if (new Set(prims.map(p => p?.attributes.TEXCOORD_0)).size !== 1 || new Set(prims.map(p => p?.indices)).size !== 1) err(`${anim} frames do not share one UV and one index accessor`);
  }
  const regions = (g.nodes || []).filter(n => /^region_\d+$/.test(n.name)).length;
  return done(`${regions} region nodes, ${Object.entries(groups).map(([a, p]) => `${a} ${p.length}`).join(' + ') || 'no'} frames, ${g.accessors?.length} accessors, ${g.bufferViews?.length} bufferViews, ${vertices} vertices / ${triangles} triangles in all primitives, ${buf.length} bytes`);
}
