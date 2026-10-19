// ─── MODEL LOADER ─────────────────────────────────────────────────────────────
const ModelLoader = (() => {
  const _cache = {};   // key → THREE.Group (cloneable template)
  const _pending = {}; // key → Promise
  const _settled = new Set();   // keys whose load finished, loaded or failed
  const _waiters = {};          // key → [resolve] for ready()
  const _filesDone = new Set(); // asset files fetched (or failed), for progress()
  const _track = (path, p) => { p.then(() => _filesDone.add(path), () => _filesDone.add(path)); return p; };

  const _objLoader  = new THREE.OBJLoader();
  const _mtlLoader  = (typeof THREE !== 'undefined' && THREE.MTLLoader)  ? new THREE.MTLLoader()  : null;
  const _ddsLoader  = (typeof THREE !== 'undefined' && THREE.DDSLoader)  ? new THREE.DDSLoader()  : null;
  const _gltfLoader = (typeof THREE !== 'undefined' && THREE.GLTFLoader) ? new THREE.GLTFLoader() : null;
  const _texLoader  = new THREE.TextureLoader();

  // Load a single texture, using DDSLoader for .dds files, TextureLoader otherwise
  function _loadTex(path) {
    const isDds = /\.dds$/i.test(path);
    const loader = (isDds && _ddsLoader) ? _ddsLoader : _texLoader;
    return _track(path, new Promise((res, rej) => loader.load(path, tex => {
      if (isDds) {
        // DDS stores rows top-to-bottom, and compressed data can't be flipped on
        // upload (flipY is ignored), so the image lands upside down for the
        // OpenGL-style UVs Blender writes to the OBJ. Flip V in the texture
        // transform instead: v' = 1 - v. (Verified against the UV layout: the
        // upgrade plates' octagon/ammo-belt islands only line up this way.)
        tex.flipY = false;
        tex.repeat.y = -1; tex.offset.y = 1;
      }
      res(tex);
    }, null, rej)));
  }

  // ── SC2 material conventions ──────────────────────────────────────────────
  // Team colour: SC2 diffuse maps carry a mask in alpha (opaque = bare steel,
  // lower alpha = painted panel) that is tinted with the player colour.
  // Normal maps are DXT5nm: X in alpha, Y in green, Z rebuilt in the shader.
  // Both live in one onBeforeCompile; Material.clone() drops it, so call
  // teamColor() again on a cloned material.
  const _teamCol = new WeakMap();   // material → THREE.Color uniform
  const _NORMAL_DXT5NM = THREE.ShaderChunk.normal_fragment_maps.replace(
    'vec3 mapN = texture2D( normalMap, vUv ).xyz * 2.0 - 1.0;',
    `vec4 nTex = texture2D( normalMap, vUv );
    vec3 mapN = vec3( nTex.a * 2.0 - 1.0, nTex.g * 2.0 - 1.0, 0.0 );
    mapN.z = sqrt( max( 0.0, 1.0 - dot( mapN.xy, mapN.xy ) ) );`);
  function _sc2Shader(mat) {
    mat.onBeforeCompile = shader => {
      const tc = _teamCol.get(mat);
      if (tc) {
        shader.uniforms.teamColor = { value: tc };
        shader.fragmentShader = 'uniform vec3 teamColor;\n' + shader.fragmentShader.replace(
          '#include <map_fragment>',
          `#ifdef USE_MAP
            vec4 texelColor = texture2D( map, vUv );
            texelColor = mapTexelToLinear( texelColor );
            float tcMask = smoothstep( 0.98, 0.55, texelColor.a );
            // tint scaled by the panel's luminance: keeps its detail, never clips to white
            vec3 tcCol = teamColor * ( 0.3 + 1.2 * dot( texelColor.rgb, vec3( 0.299, 0.587, 0.114 ) ) );
            diffuseColor.rgb *= mix( texelColor.rgb, tcCol, tcMask );
          #endif`);
      }
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', _NORMAL_DXT5NM);
    };
    mat.customProgramCacheKey = () => 'sc2' + (_teamCol.has(mat) ? '-tc' : '');
    mat.needsUpdate = true;
  }
  // Tint the team-colour panels of mat with hex; returns the colour uniform
  // so the tint can be changed later (e.g. the bunker's upgrade frame).
  function teamColor(mat, hex) {
    const tc = new THREE.Color(hex);
    _teamCol.set(mat, tc);
    _sc2Shader(mat);
    return tc;
  }

  // Build one material per texture set (diffuse / emissive / normal).
  function _makeMaterial(texDef) {
    const slots = [['diffuse', 'map'], ['emissive', 'emissiveMap'], ['normal', 'normalMap']].filter(([k]) => texDef[k]);
    return Promise.all(slots.map(([k, slot]) => _loadTex(texDef[k]).then(t => [slot, t]).catch(() => null))).then(results => {
      // Moderate metalness: with no environment map a highly metallic surface
      // has nothing to reflect and renders black.
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.3 });
      for (const r of results) if (r) mat[r[0]] = r[1];
      if (mat.emissiveMap) mat.emissive.setScalar(0.85);
      // SC2 normal maps are mostly DirectX-style (green = down), which suits the
      // flipped DDS sampling as is; OpenGL-style ones set normalY: -1
      if (texDef.normalY) mat.normalScale.y = texDef.normalY;
      _sc2Shader(mat);
      return mat;
    });
  }

  // Texture every mesh of obj: def.tex for all, def.meshTex[name] overrides
  // per mesh (e.g. the bunker's upgrade frame has its own maps). Returns a Promise.
  function _applyTextures(obj, def) {
    const sets = { '': def.tex, ...(def.meshTex || {}) };
    const mats = {};
    return Promise.all(Object.entries(sets).map(([name, t]) => _makeMaterial(t).then(m => { mats[name] = m; }))).then(() => {
      if (def.teamColor != null) Object.values(mats).forEach(m => teamColor(m, def.teamColor));
      obj.traverse(ch => {
        if (!ch.isMesh) return;
        ch.material = mats[ch.name] || mats[''];
        ch.castShadow = true; ch.receiveShadow = true;
      });
    });
  }

  // ── GLB models ────────────────────────────────────────────────────────────
  // def.glb: tools/m3-to-glb.mjs output. Its "region_N" nodes are the bind
  // pose (the meshes the OBJ has), its "Walk_k" / "Attack_k" nodes the baked
  // frames (see _loadAnims). Skins share one parsed file and its geometry;
  // each key gets its own meshes, so its own materials.
  const _glbCache = {};    // path → Promise<gltf>
  const _glbWarned = {};   // path → true once its failure was reported
  function _loadGlb(path) {
    if (!_gltfLoader) return Promise.reject(new Error('THREE.GLTFLoader is not loaded'));
    return _glbCache[path] || (_glbCache[path] = _track(path, new Promise((res, rej) => _gltfLoader.load(path, res, null, rej))));
  }
  // A GLB node's geometry in model coordinates, float32. m3-to-glb packs it with
  // KHR_mesh_quantization — positions int16 inside the node's box (its
  // translation + scale), normals int8 — so it is expanded once per node (skins
  // share it): the game swaps frame geometries and bakes them into instance
  // pools without the node's transform. Float GLBs pass through unchanged.
  const _floatGeo = new WeakMap();   // glTF mesh node → geometry
  const _NORM = { Int8Array: 127, Uint8Array: 255, Int16Array: 32767, Uint16Array: 65535 };
  const _arrayOf = a => (a.isInterleavedBufferAttribute ? a.data.array : a.array);
  function _nodeGeometry(node) {
    if (_floatGeo.has(node)) return _floatGeo.get(node);
    const src = node.geometry, packed = n => src.attributes[n] && !(_arrayOf(src.attributes[n]) instanceof Float32Array);
    let geo = src;
    if (packed('position') || packed('normal')) {
      geo = new THREE.BufferGeometry();
      geo.setIndex(src.index);
      for (const [name, a] of Object.entries(src.attributes)) {
        if (!['position', 'normal'].includes(name) || !packed(name)) { geo.setAttribute(name, a); continue; }
        const k = a.normalized ? 1 / _NORM[_arrayOf(a).constructor.name] : 1, out = new Float32Array(a.count * 3);
        for (let i = 0; i < a.count; i++) {
          let x = a.getX(i) * k, y = a.getY(i) * k, z = a.getZ(i) * k;
          if (a.normalized) { x = Math.max(-1, x); y = Math.max(-1, y); z = Math.max(-1, z); }
          if (name === 'position') { x = x * node.scale.x + node.position.x; y = y * node.scale.y + node.position.y; z = z * node.scale.z + node.position.z; }
          else { const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l; }
          out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z;
        }
        geo.setAttribute(name, new THREE.BufferAttribute(out, 3));
      }
    }
    _floatGeo.set(node, geo);
    return geo;
  }
  // The bind pose of a parsed GLB as OBJLoader would return it: a Group of
  // meshes named "region_N", each with OBJLoader's default material
  function _glbModel(gltf, path) {
    const root = new THREE.Group();
    for (const node of gltf.scene.children) {
      if (!node.isMesh || !/^region_\d+$/.test(node.name)) continue;
      const mesh = new THREE.Mesh(_nodeGeometry(node), new THREE.MeshLambertMaterial({ color: 0x888888 }));
      mesh.name = node.name;
      root.add(mesh);
    }
    if (!root.children.length) throw new Error(`no "region_N" meshes in ${path}`);
    return root;
  }

  function load(key) {
    if (_cache[key]) return Promise.resolve(_cache[key]);
    if (_pending[key]) return _pending[key];

    const def = ASSETS[key];
    if (!def) return Promise.reject(new Error('Unknown asset: ' + key));

    _pending[key] = new Promise((resolve, reject) => {
      // Normalize any loaded root group: center pivot, apply scale/rotation/yFloor
      // scale: size of the largest dimension in world units; unitScale: world
      // units per model unit (keeps SC2 models in proportion to each other)
      const _normalizeGroup = (root) => {
        const bbox = new THREE.Box3().setFromObject(root);
        const center = bbox.getCenter(new THREE.Vector3());
        const size   = bbox.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        root.position.sub(center);

        const wrapper = new THREE.Group();
        wrapper.add(root);
        const k = def.unitScale ?? def.scale / maxDim;
        wrapper.scale.setScalar(k);
        wrapper.rotation.y = def.rotY ?? 0;
        const yFloor = size.y * k * 0.5;
        wrapper.position.y = (def.yOff ?? 0) + yFloor;
        return wrapper;
      };

      // Bind pose (a Group of meshes) → normalised, textured template; ready
      // once its baked animations (if any) have loaded too
      const finish = (root, gltf) => {
        const wrapper = _normalizeGroup(root);
        return (def.tex ? _applyTextures(root, def).catch(() => {}) : Promise.resolve())
          .then(() => _loadAnims(key, def, wrapper, gltf))
          .then(() => {
            _cache[key] = wrapper; _settled.add(key); resolve(wrapper);
            (_waiters[key] || []).forEach(f => f(wrapper)); delete _waiters[key];
          });
      };

      const tryObj = (materials) => {
        if (materials) _objLoader.setMaterials(materials);
        _objLoader.load(def.obj, obj => { _filesDone.add(def.obj); finish(obj, null).catch(reject); }, null, err => { _filesDone.add(def.obj); reject(err); });
      };
      const objPipeline = () => {
        if (def.mtl && _mtlLoader) {
          _mtlLoader.load(
            def.mtl,
            mat => { _filesDone.add(def.mtl); try { mat.preload(); tryObj(mat); } catch(e) { tryObj(null); } },
            null,
            () => { _filesDone.add(def.mtl); tryObj(null); }
          );
        } else {
          tryObj(null);
        }
      };

      // GLB first if defined (tools/m3-to-glb.mjs): the same model as the OBJ
      // files in one binary file. If it fails, the OBJ files are used instead.
      if (def.glb) {
        _loadGlb(def.glb)
          .then(gltf => [_glbModel(gltf, def.glb), gltf])
          .then(([root, gltf]) => finish(root, gltf), err => {
            if (!_glbWarned[def.glb]) { _glbWarned[def.glb] = true; console.warn(`"${def.glb}" failed to load${def.obj ? ' — using the OBJ files instead' : ''}.`, err); }
            if (def.obj) objPipeline(); else reject(err);
          })
          .catch(reject);
      } else {
        objPipeline();
      }
    });

    _pending[key].catch(() => _settled.add(key));
    return _pending[key];
  }
  // Resolves with key's template once it has loaded, without starting the load
  // (preloadAll decides when); never rejects — a failed model keeps its fallback
  function ready(key) {
    return _cache[key] ? Promise.resolve(_cache[key]) : new Promise(res => (_waiters[key] = _waiters[key] || []).push(res));
  }

  // Returns a clone of the cached template, or null if not ready.
  // Note: geometry AND materials are shared with the template (no per-instance
  // clone). Call-sites that recolor materials must clone them explicitly
  // (buildScene does this for the bunker). This avoids leaking one material
  // set per spawned enemy.
  function clone(key, fallbackFn) {
    if (_cache[key]) return _cache[key].clone();
    // Not loaded yet — use procedural fallback
    return fallbackFn ? fallbackFn() : null;
  }

  // Load every asset in the background, one priority stage at a time (then the
  // rest): on a slow connection the bunker and the first waves' units arrive
  // first instead of ~40 files sharing the bandwidth. A stage that has not
  // finished after STAGE_WAIT ms (a hung request, a cut-off file that the
  // loader never settles) lets the next one start anyway. Never throws.
  const STAGE_WAIT = 30000;
  async function preloadAll(stages = []) {
    const seen = new Set();
    for (const keys of [...stages, Object.keys(ASSETS)]) {
      const todo = keys.filter(k => ASSETS[k] && !seen.has(k));
      todo.forEach(k => seen.add(k));
      const stage = Promise.all(todo.map(k => load(k).catch(err => console.warn(`"${k}" failed to load — drawn with simple shapes instead.`, err))));
      await Promise.race([stage, new Promise(res => setTimeout(res, STAGE_WAIT))]);
    }
  }
  // Loading progress: asset files done out of every file ASSETS lists (each path
  // once). A model that failed counts as done, files it never requested included.
  function progress() {
    const files = new Set(), done = new Set(_filesDone);
    for (const [key, def] of Object.entries(ASSETS)) {
      const own = [];
      if (def.glb) own.push(def.glb);
      else own.push(def.obj, _mtlLoader && def.mtl, ...ANIMS.map(a => def[a]));
      for (const t of [def.tex, ...Object.values(def.meshTex || {})]) if (t) ['diffuse', 'emissive', 'normal'].forEach(m => own.push(t[m]));
      const failed = _settled.has(key) && !_cache[key];
      for (const f of own) if (f) { files.add(f); if (failed) done.add(f); }
    }
    let n = 0;
    files.forEach(f => { if (done.has(f)) n++; });
    return { done: n, total: files.size };
  }

  // A standalone texture (decals, ...), loaded once: Promise<THREE.Texture>
  const _texCache = {};
  function texture(path) {
    return _texCache[path] || (_texCache[path] = _loadTex(path));
  }

  // ── Baked animations ──────────────────────────────────────────────────────
  // def.walk / def.attack: an OBJ of baked frames "<Anim>_0" … "<Anim>_N"
  // (tools/m3-to-obj.mjs --anim). A GLB model carries them as "Walk_k" /
  // "Attack_k" nodes (tools/m3-to-glb.mjs --anims), used instead when present.
  // Each frame becomes a template placed exactly like the model (same
  // normalisation) and wearing its material. Skins share one parsed file.
  const ANIMS = ['walk', 'attack'];
  const _frames = {};     // key → { walk: [THREE.Group], attack: [...] }
  const _objCache = {};   // path → Promise<THREE.Group>
  function _loadAnims(key, def, wrapper, gltf) {
    const root = wrapper.children[0];
    let mat = null;
    wrapper.traverse(ch => { if (ch.isMesh && !mat) mat = ch.material; });
    const template = geometry => {
      const t = new THREE.Group();
      t.position.copy(wrapper.position); t.rotation.copy(wrapper.rotation); t.scale.copy(wrapper.scale);
      const inner = new THREE.Group();
      inner.position.copy(root.position);
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.castShadow = mesh.receiveShadow = true;
      inner.add(mesh); t.add(inner);
      return t;
    };
    const frameNo = m => +m.name.match(/_(\d+)$/)[1];
    const inOrder = (meshes, geometry = m => m.geometry) => meshes.sort((a, b) => frameNo(a) - frameNo(b)).map(m => template(geometry(m)));
    _frames[key] = {};
    return Promise.all(ANIMS.map(anim => {
      const nodes = gltf ? gltf.scene.children.filter(c => c.isMesh && new RegExp(`^${anim}_[0-9]+$`, 'i').test(c.name)) : [];
      if (nodes.length) { _frames[key][anim] = inOrder(nodes, _nodeGeometry); return null; }
      if (!def[anim]) return null;
      const parsed = _objCache[def[anim]] || (_objCache[def[anim]] = _track(def[anim], new Promise((res, rej) => _objLoader.load(def[anim], res, null, rej))));
      return parsed.then(obj => { _frames[key][anim] = inOrder(obj.children.filter(c => c.isMesh && /_\d+$/.test(c.name))); })
        .catch(err => console.warn(`"${anim}" animation of "${key}" failed to load — it plays without it.`, err));
    }));
  }
  // Frame templates of key's animation (shared — clone before adding to the scene), or null
  const animFrames = (key, anim) => (_frames[key]?.[anim]?.length ? _frames[key][anim] : null);

  return { load, ready, clone, preloadAll, progress, teamColor, texture, animFrames,
           isReady: (key) => !!_cache[key], isSettled: (key) => _settled.has(key) };
})();
