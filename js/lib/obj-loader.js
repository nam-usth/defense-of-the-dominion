// Minimal OBJ parser exposed as THREE.OBJLoader (three.js r128 API shape).
// Used instead of three's examples/js OBJLoader: it keeps the file's UVs as
// written (OpenGL-style, v up) and ignores MTL materials — textures are
// applied by ModelLoader. Loaded before the game scripts.
THREE.OBJLoader = function(manager) {
  this.manager = manager || THREE.DefaultLoadingManager;
};
THREE.OBJLoader.prototype = {
  constructor: THREE.OBJLoader,
  setMaterials: function(mtl) { this._mtl = mtl; return this; },
  load: function(url, onLoad, onProgress, onError) {
    const loader = new THREE.FileLoader(this.manager);
    loader.load(url, text => {
      try { onLoad(this.parse(text)); }
      catch(e) { if(onError) onError(e); else console.error(e); }
    }, onProgress, onError);
  },
  parse: function(text) {
    const lines = text.split('\n');
    const verts = [], normals = [], uvs = [];
    const positions = [], norms = [], uvsOut = [];
    const object = new THREE.Group();
    let currentName = '', currentGeo = null, currentMat = new THREE.MeshLambertMaterial({color:0x888888});

    function finishMesh() {
      if (!currentGeo || positions.length === 0) return;
      currentGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions.splice(0), 3));
      if (uvsOut.length)  currentGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvsOut.splice(0), 2));
      if (norms.length)   currentGeo.setAttribute('normal', new THREE.Float32BufferAttribute(norms.splice(0), 3));
      currentGeo.computeVertexNormals();
      const mesh = new THREE.Mesh(currentGeo, currentMat.clone());
      mesh.name = currentName;
      object.add(mesh);
    }

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line[0] === '#') continue;
      const parts = line.split(/\s+/);
      const cmd = parts[0];
      if (cmd === 'v')  { verts.push(+parts[1], +parts[2], +parts[3]); }
      else if (cmd === 'vn') { normals.push(+parts[1], +parts[2], +parts[3]); }
      else if (cmd === 'vt') { uvs.push(+parts[1], +parts[2]); } // OpenGL-style (v up); DDS maps flip V in _loadTex
      else if (cmd === 'o' || cmd === 'g') {
        finishMesh();
        currentName = parts.slice(1).join(' ');
        currentGeo = new THREE.BufferGeometry();
        norms.length = 0; uvsOut.length = 0;
      }
      else if (cmd === 'usemtl') { /* skip — use default grey */ }
      else if (cmd === 'f') {
        if (!currentGeo) { currentGeo = new THREE.BufferGeometry(); }
        const faceVerts = parts.slice(1).map(p => {
          const idx = p.split('/').map(x => x ? +x : 0);
          return { v: idx[0], vt: idx[1], vn: idx[2] };
        });
        // Triangulate (fan)
        for (let i = 1; i < faceVerts.length - 1; i++) {
          [faceVerts[0], faceVerts[i], faceVerts[i+1]].forEach(fi => {
            const vi = (fi.v > 0 ? fi.v - 1 : verts.length/3 + fi.v) * 3;
            positions.push(verts[vi], verts[vi+1], verts[vi+2]);
            if (fi.vt && uvs.length) {
              const ti = (fi.vt > 0 ? fi.vt - 1 : uvs.length/2 + fi.vt) * 2;
              uvsOut.push(uvs[ti], uvs[ti+1]);
            }
            if (fi.vn) {
              const ni = (fi.vn > 0 ? fi.vn - 1 : normals.length/3 + fi.vn) * 3;
              norms.push(normals[ni], normals[ni+1], normals[ni+2]);
            }
          });
        }
      }
    }
    finishMesh();
    return object;
  }
};
