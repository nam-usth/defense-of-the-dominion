// Minimal reader for StarCraft II .m3 models (MD34): mesh, regions, materials
// and the texture each material layer points at, plus the skeleton and the
// bone tracks of each animation sequence (enough to bake skinned poses).
//
// An MD34 file is a list of typed arrays ("index entries": tag, offset, count,
// version). Structures point at each other through References
// (count u32, entry index u32, flags u32). Tags are stored reversed ("LDOM").

const VERTEX_COLORS = 0x200, UV1 = 0x40000, UV2 = 0x80000, UV3 = 0x100000;

// Field offsets inside the structures this reader needs (all MODL versions
// seen in SC2 / HotS / LotV files share these).
const MODL = { vertexFlags: 96, vertices: 100, divisions: 112, boneLookup: 124, bones: 80, materialRefs: 300, standardMaterials: 312 };
const DIV = { faces: 0, regions: 12, batches: 24 };

// Material layer order of the standard material (MAT_). v19+ inserted a gloss
// layer after the specular one and appended four more.
const LAYERS_V15 = ['diffuse', 'decal', 'specular', 'emissive', 'emissive2', 'evio', 'evioMask', 'alphaMask', 'alphaMask2', 'normal', 'height', 'lightMap', 'ambientOcclusion'];
const LAYERS_V19 = ['diffuse', 'decal', 'specular', 'gloss', 'emissive', 'emissive2', 'evio', 'evioMask', 'alphaMask', 'alphaMask2', 'normal', 'height', 'lightMap', 'ambientOcclusion'];
const MAT_SIZE = { 15: 268, 20: 352 };   // bytes per standard material, by version
const MATERIAL_TYPES = { 1: 'standard', 2: 'displacement', 3: 'composite', 4: 'terrain', 5: 'volume', 7: 'creep', 8: 'volumeNoise', 9: 'splatTerrainBake', 10: 'reflection', 11: 'lensFlare' };

export function parseM3(buf) {
  if (buf.toString('latin1', 0, 4) !== '43DM') throw new Error('not an MD34 .m3 file');
  const indexOffset = buf.readUInt32LE(4), count = buf.readUInt32LE(8);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = indexOffset + i * 16;
    entries.push({ tag: buf.toString('latin1', o, o + 4).split('').reverse().join(''), offset: buf.readUInt32LE(o + 4), count: buf.readUInt32LE(o + 8), version: buf.readUInt32LE(o + 12) });
  }
  // element size of an entry = distance to the next entry / count (entries are 16-byte padded)
  const byOffset = [...entries].sort((a, b) => a.offset - b.offset);
  byOffset.forEach((e, k) => { e.bytes = (k + 1 < byOffset.length ? byOffset[k + 1].offset : indexOffset) - e.offset; });

  const ref = (at, tag) => {
    const n = buf.readUInt32LE(at), index = buf.readUInt32LE(at + 4);
    if (!n) return null;
    const e = entries[index];
    if (!e || (tag && e.tag !== tag)) throw new Error(`expected a ${tag} reference at 0x${at.toString(16)}, found ${e ? e.tag : 'nothing'}`);
    return e;
  };
  const string = e => (e ? buf.toString('latin1', e.offset, e.offset + e.count - 1) : '');
  const u16s = e => (e ? Array.from({ length: e.count }, (_, i) => buf.readUInt16LE(e.offset + i * 2)) : []);
  // References inside one structure element, in order (used for material layers)
  const refsIn = (start, size, tag) => {
    const out = [];
    for (let o = start; o + 12 <= start + size; o += 4) {
      const n = buf.readUInt32LE(o), index = buf.readUInt32LE(o + 4), flags = buf.readUInt32LE(o + 8);
      if (n && index < entries.length && entries[index].tag === tag && entries[index].count === n && flags === 0) { out.push(entries[index]); o += 8; }
    }
    return out;
  };

  const modelEntry = entries[buf.readUInt32LE(16)];
  if (!modelEntry || modelEntry.tag !== 'MODL') throw new Error('MODL not found');
  const m = modelEntry.offset;
  const name = string(ref(m, 'CHAR'));
  const vertexFlags = buf.readUInt32LE(m + MODL.vertexFlags);
  const vertexBytes = ref(m + MODL.vertices, 'U8__');
  const div = ref(m + MODL.divisions, 'DIV_');
  const faces = u16s(ref(div.offset + DIV.faces, 'U16_'));
  const boneLookup = u16s(ref(m + MODL.boneLookup, 'U16_'));

  // Regions: a slice of the vertex buffer plus a slice of the face list whose
  // indices are relative to the region's first vertex. Effect-only models
  // (particles, no mesh) have none.
  const regEntry = ref(div.offset + DIV.regions, 'REGN');
  const regSize = regEntry && regEntry.version >= 5 ? 48 : regEntry && regEntry.version === 4 ? 40 : 36;
  const regions = Array.from({ length: regEntry ? regEntry.count : 0 }, (_, i) => {
    const o = regEntry.offset + i * regSize;
    return {
      index: i,
      firstVertex: buf.readUInt32LE(o + 8), vertexCount: buf.readUInt32LE(o + 12),
      firstFace: buf.readUInt32LE(o + 16), faceIndexCount: buf.readUInt32LE(o + 20),
      boneCount: buf.readUInt16LE(o + 24), firstBoneLookup: buf.readUInt16LE(o + 26), boneLookupCount: buf.readUInt16LE(o + 28),
    };
  });
  const vertexCount = regions.reduce((s, r) => Math.max(s, r.firstVertex + r.vertexCount), 0);

  // Vertex layout follows the flags; check it against the buffer size.
  const uvCount = 1 + !!(vertexFlags & UV1) + !!(vertexFlags & UV2) + !!(vertexFlags & UV3);
  const vertexSize = 12 + 4 + 4 + 4 + (vertexFlags & VERTEX_COLORS ? 4 : 0) + uvCount * 4 + 4;
  if (vertexCount * vertexSize !== (vertexBytes ? vertexBytes.count : 0)) throw new Error(`vertex layout mismatch: ${vertexCount} vertices × ${vertexSize} B ≠ ${vertexBytes.count} B (flags 0x${vertexFlags.toString(16)})`);
  const vertices = Array.from({ length: vertexCount }, (_, i) => {
    let o = vertexBytes.offset + i * vertexSize;
    const v = {
      position: [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)],
      weights: [buf[o + 12], buf[o + 13], buf[o + 14], buf[o + 15]].map(w => w / 255),
      lookup: [buf[o + 16], buf[o + 17], buf[o + 18], buf[o + 19]],
      normal: [buf[o + 20], buf[o + 21], buf[o + 22]].map(c => c / 255 * 2 - 1),
    };
    o += 24;
    if (vertexFlags & VERTEX_COLORS) { v.color = [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]]; o += 4; }
    v.uv = [];
    for (let k = 0; k < uvCount; k++, o += 4) v.uv.push([buf.readInt16LE(o) / 2048, buf.readInt16LE(o + 2) / 2048]);
    return v;
  });

  // Materials: MATM entries say which typed list (standard, composite, ...) and index.
  const stdEntry = ref(m + MODL.standardMaterials, null);
  // entry padding makes bytes/count ambiguous for small counts: use the known sizes
  const stdSize = stdEntry ? (MAT_SIZE[stdEntry.version] || Math.floor(stdEntry.bytes / stdEntry.count)) : 0;
  const layerNames = stdEntry && stdEntry.version >= 19 ? LAYERS_V19 : LAYERS_V15;
  const standard = stdEntry ? Array.from({ length: stdEntry.count }, (_, i) => {
    const o = stdEntry.offset + i * stdSize;
    const layers = {};
    refsIn(o + 12, stdSize - 12, 'LAYR').forEach((l, k) => {
      const path = string(refsIn(l.offset, Math.floor(l.bytes / l.count), 'CHAR')[0]);
      if (path) layers[layerNames[k] || 'layer' + k] = path;
    });
    return { name: string(ref(o, 'CHAR')), layers };
  }) : [];
  const matmEntry = ref(m + MODL.materialRefs, 'MATM');
  const materials = Array.from({ length: matmEntry ? matmEntry.count : 0 }, (_, i) => {
    const type = buf.readUInt32LE(matmEntry.offset + i * 8), index = buf.readUInt32LE(matmEntry.offset + i * 8 + 4);
    const typeName = MATERIAL_TYPES[type] || 'type' + type;
    return typeName === 'standard' ? { type: typeName, ...standard[index] } : { type: typeName, name: `${typeName} #${index}`, layers: {} };
  });

  // Batches tie a region to a material; regions without a batch are never drawn.
  const batEntry = ref(div.offset + DIV.batches, 'BAT_');
  const batches = Array.from({ length: batEntry ? batEntry.count : 0 }, (_, i) => {
    const o = batEntry.offset + i * 14;
    return { region: buf.readUInt16LE(o + 4), material: buf.readUInt16LE(o + 10) };
  });

  // ── Skeleton ──────────────────────────────────────────────────────────────
  // BONE: name, parent, then location / rotation / scale, each an animation
  // reference (interpolation u16, flags u16, animation id u32) + initial value.
  const vec3 = o => [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)];
  const quat = o => [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8), buf.readFloatLE(o + 12)];
  const boneEntry = ref(m + MODL.bones, 'BONE');
  const bones = Array.from({ length: boneEntry ? boneEntry.count : 0 }, (_, i) => {
    const o = boneEntry.offset + i * 160;
    return {
      name: string(ref(o + 4, 'CHAR')), parent: buf.readInt16LE(o + 20),
      location: { id: buf.readUInt32LE(o + 28), init: vec3(o + 32) },
      rotation: { id: buf.readUInt32LE(o + 64), init: quat(o + 68) },
      scale:    { id: buf.readUInt32LE(o + 108), init: vec3(o + 112) },
    };
  });
  // The other skeleton/animation lists sit at version-dependent offsets in
  // MODL, but their tags are unique there: find them by tag.
  const inModel = tag => refsIn(m, modelEntry.bytes, tag)[0] || null;
  const iref = inModel('IREF');   // inverse bind matrices, 16 floats each (column-major)
  const inverseBind = bones.map((_, i) => Array.from({ length: 16 }, (_, k) => buf.readFloatLE(iref.offset + i * 64 + k * 4)));
  // Attachment points ("Ref_Weapon 01", "Ref_Head", ...): a name on a bone
  const attEntry = inModel('ATT_');
  const attachments = Array.from({ length: attEntry ? attEntry.count : 0 }, (_, i) => {
    const o = attEntry.offset + i * 20;
    return { name: string(ref(o + 4, 'CHAR')), bone: buf.readUInt32LE(o + 16) };
  });

  // ── Animation ─────────────────────────────────────────────────────────────
  // SEQS (sequence: name, length) ↔ STG_ (same index: list of STC_ indices) →
  // STC_ (animation ids + a typed reference to each id's key track).
  const seqEntry = inModel('SEQS'), stgEntry = inModel('STG_'), stcEntry = inModel('STC_');
  const seqSize = seqEntry && seqEntry.version >= 2 ? 92 : 96;
  const STC_TRACKS = 48, SD3V = 2, SD4Q = 3;     // STC_: 13 typed track lists from byte 48; vec3 = type 2, quat = type 3
  const u32s = e => (e ? Array.from({ length: e.count }, (_, i) => buf.readUInt32LE(e.offset + i * 4)) : []);
  const track = (sd, index, read, size) => {        // SDxx: frame times (I32_), flags, end, keys
    const o = sd.offset + index * 32, frames = ref(o, 'I32_'), keys = ref(o + 20, null);
    return { times: Array.from({ length: frames ? frames.count : 0 }, (_, k) => buf.readInt32LE(frames.offset + k * 4)),
             keys: Array.from({ length: keys ? keys.count : 0 }, (_, k) => read(keys.offset + k * size)) };
  };
  const sequences = Array.from({ length: seqEntry ? seqEntry.count : 0 }, (_, i) => {
    const o = seqEntry.offset + i * seqSize;
    const tracks = new Map();                       // animation id → { times, keys }
    for (const s of u32s(ref(stgEntry.offset + i * 24 + 12, 'U32_'))) {
      const c = stcEntry.offset + s * 204;
      const ids = u32s(ref(c + 20, 'U32_')), refs = u32s(ref(c + 32, 'U32_'));
      const sd3v = ref(c + STC_TRACKS + SD3V * 12, null), sd4q = ref(c + STC_TRACKS + SD4Q * 12, null);
      ids.forEach((id, k) => {
        const type = refs[k] >>> 16, index = refs[k] & 0xffff;
        if (type === SD3V && sd3v) tracks.set(id, track(sd3v, index, vec3, 12));
        if (type === SD4Q && sd4q) tracks.set(id, track(sd4q, index, quat, 16));
      });
    }
    return { name: string(ref(o + 8, 'CHAR')), length: buf.readUInt32LE(o + 24) - buf.readUInt32LE(o + 20), speed: buf.readFloatLE(o + 28), tracks };
  });

  return { name, vertexFlags, vertexSize, vertices, faces, regions, boneLookup, materials, batches, bones, inverseBind, attachments, sequences };
}

// ── Region selection (shared by the converters) ─────────────────────────────
// Every region with the material its batch draws it with (null: never drawn).
export function drawnRegions(m3) {
  return m3.regions.map(r => {
    const batch = m3.batches.find(b => b.region === r.index);
    return { ...r, material: batch ? m3.materials[batch.material] : null };
  });
}
// The regions to export: the listed ones (only = "0,2"), else every drawn
// region whose standard material has a diffuse texture (not glow/FX planes).
export function pickRegions(m3, only) {
  const drawn = drawnRegions(m3);
  return only
    ? only.split(',').map(Number).map(i => { if (!drawn[i]) throw new Error(`no region ${i}`); return drawn[i]; })
    : drawn.filter(r => r.material?.type === 'standard' && r.material.layers.diffuse);
}

// ── Posing and skinning ─────────────────────────────────────────────────────
const lerp = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
function nlerp(a, b, t) {                            // quaternion blend along the short arc
  const s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  const q = a.map((v, k) => v + (s * b[k] - v) * t), n = Math.hypot(...q) || 1;
  return q.map(v => v / n);
}
function sampleTrack({ times, keys }, t, blend) {
  if (!keys.length) return null;
  if (t <= times[0]) return keys[0];
  for (let k = 1; k < times.length; k++) if (t <= times[k]) return blend(keys[k - 1], keys[k], (t - times[k - 1]) / (times[k] - times[k - 1] || 1));
  return keys[keys.length - 1];
}
function compose([px, py, pz], [x, y, z, w], [sx, sy, sz]) {   // T · R · S, column-major
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    px, py, pz, 1];
}
function multiply(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

// Model-space matrices of every bone in sequence `seq` at time t (ms);
// seq = null gives the bones' initial values.
export function boneMatrices(m3, seq, t) {
  const world = [];
  const boneWorld = i => {
    if (world[i]) return world[i];
    const b = m3.bones[i], at = (ch, blend) => (seq && seq.tracks.has(ch.id) && sampleTrack(seq.tracks.get(ch.id), t, blend)) || ch.init;
    const local = compose(at(b.location, lerp), at(b.rotation, nlerp), at(b.scale, lerp));
    return (world[i] = b.parent >= 0 ? multiply(boneWorld(b.parent), local) : local);
  };
  return m3.bones.map((_, i) => boneWorld(i));
}

// Skinning matrices (bone matrix × inverse bind) of sequence `seq` at time t (ms).
export function skinMatrices(m3, seq, t) {
  return boneMatrices(m3, seq, t).map((w, i) => multiply(w, m3.inverseBind[i]));
}

// Model-space position of an attachment point ("Ref_Weapon 01") at time t (ms).
export function attachmentPosition(m3, name, seq, t) {
  const a = m3.attachments.find(x => x.name === name);
  if (!a) throw new Error(`no attachment "${name}" (have: ${m3.attachments.map(x => x.name).join(', ')})`);
  const w = boneMatrices(m3, seq, t)[a.bone];
  return [w[12], w[13], w[14]];
}

// Vertex positions and normals of `region` under the given skinning matrices.
export function skinRegion(m3, region, mats) {
  const positions = [], normals = [];
  for (let i = region.firstVertex; i < region.firstVertex + region.vertexCount; i++) {
    const v = m3.vertices[i], p = [0, 0, 0], n = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const w = v.weights[k];
      if (!w) continue;
      const M = mats[m3.boneLookup[region.firstBoneLookup + v.lookup[k]]];
      const [x, y, z] = v.position, [nx, ny, nz] = v.normal;
      for (let r = 0; r < 3; r++) {
        p[r] += w * (M[r] * x + M[4 + r] * y + M[8 + r] * z + M[12 + r]);
        n[r] += w * (M[r] * nx + M[4 + r] * ny + M[8 + r] * nz);
      }
    }
    const len = Math.hypot(...n) || 1;
    positions.push(p); normals.push(n.map(c => c / len));
  }
  return { positions, normals };
}
