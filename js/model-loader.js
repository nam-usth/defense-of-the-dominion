// ─── MODEL LOADER ─────────────────────────────────────────────────────────────
const ModelLoader = (() => {
  const _cache = {};   // key → THREE.Group (cloneable template)
  const _pending = {}; // key → Promise

  const _objLoader  = new THREE.OBJLoader();
  const _mtlLoader  = (typeof THREE !== 'undefined' && THREE.MTLLoader)  ? new THREE.MTLLoader()  : null;
  const _ddsLoader  = (typeof THREE !== 'undefined' && THREE.DDSLoader)  ? new THREE.DDSLoader()  : null;
  const _gltfLoader = (typeof THREE !== 'undefined' && THREE.GLTFLoader) ? new THREE.GLTFLoader() : null;
  const _texLoader  = new THREE.TextureLoader();

  // Load a single texture, using DDSLoader for .dds files, TextureLoader otherwise
  function _loadTex(path) {
    const isDds = /\.dds$/i.test(path);
    const loader = (isDds && _ddsLoader) ? _ddsLoader : _texLoader;
    return new Promise((res, rej) => loader.load(path, tex => {
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
    }, null, rej));
  }

  // Apply diffuse + emissive textures to every mesh in obj. Returns a Promise.
  function _applyTextures(obj, texDef) {
    const loads = [];
    if (texDef.diffuse)  loads.push(_loadTex(texDef.diffuse) .then(t=>({k:'map',t}))         .catch(()=>null));
    if (texDef.emissive) loads.push(_loadTex(texDef.emissive).then(t=>({k:'emissiveMap',t})).catch(()=>null));
    return Promise.all(loads).then(results => {
      const tex = {};
      results.forEach(r => { if (r) tex[r.k] = r.t; });
      obj.traverse(ch => {
        if (!ch.isMesh) return;
        // Moderate metalness: with no environment map a highly metallic surface
        // has nothing to reflect and renders black.
        const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.3 });
        if (tex.map)         { mat.map = tex.map; }
        if (tex.emissiveMap) { mat.emissiveMap = tex.emissiveMap; mat.emissive.setScalar(0.85); }
        ch.material = mat;
        ch.castShadow = true; ch.receiveShadow = true;
      });
    });
  }

  function load(key) {
    if (_cache[key]) return Promise.resolve(_cache[key]);
    if (_pending[key]) return _pending[key];

    const def = ASSETS[key];
    if (!def) return Promise.reject(new Error('Unknown asset: ' + key));

    _pending[key] = new Promise((resolve, reject) => {
      // Normalize any loaded root group: center pivot, apply scale/rotation/yFloor
      const _normalizeGroup = (root, shadows) => {
        const bbox = new THREE.Box3().setFromObject(root);
        const center = bbox.getCenter(new THREE.Vector3());
        const size   = bbox.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        root.position.sub(center);

        const wrapper = new THREE.Group();
        wrapper.add(root);
        wrapper.scale.setScalar(def.scale / maxDim);
        wrapper.rotation.y = def.rotY ?? 0;
        const yFloor = (size.y / maxDim) * def.scale * 0.5;
        wrapper.position.y = (def.yOff ?? 0) + yFloor;

        if (shadows) {
          wrapper.traverse(ch => { if (ch.isMesh) { ch.castShadow = true; ch.receiveShadow = true; } });
        }
        return wrapper;
      };

      const tryObj = (materials) => {
        if (materials) _objLoader.setMaterials(materials);
        _objLoader.load(
          def.obj,
          (obj) => {
            const wrapper = _normalizeGroup(obj, false);
            const finish = () => { _cache[key] = wrapper; resolve(wrapper); };
            if (def.tex) {
              _applyTextures(obj, def.tex).catch(() => {}).then(finish);
            } else {
              finish();
            }
          },
          null,
          reject
        );
      };

      // Try GLB first if defined, fall back to OBJ on failure
      if (def.glb && _gltfLoader) {
        _gltfLoader.load(
          def.glb,
          (gltf) => {
            const wrapper = _normalizeGroup(gltf.scene, true);
            if (gltf.animations && gltf.animations.length) {
              wrapper.userData.animations = gltf.animations;
            }
            _cache[key] = wrapper;
            resolve(wrapper);
          },
          null,
          () => {
            // GLB failed — fall through to OBJ pipeline
            if (def.mtl && _mtlLoader) {
              _mtlLoader.load(def.mtl, mat => { try { mat.preload(); tryObj(mat); } catch(e) { tryObj(null); } }, null, () => tryObj(null));
            } else {
              tryObj(null);
            }
          }
        );
      } else if (def.mtl && _mtlLoader) {
        _mtlLoader.load(
          def.mtl,
          mat => { try { mat.preload(); tryObj(mat); } catch(e) { tryObj(null); } },
          null,
          () => tryObj(null)
        );
      } else {
        tryObj(null);
      }
    });

    return _pending[key];
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

  // Preload all defined assets in background; never throws
  function preloadAll() {
    Object.keys(ASSETS).forEach(key => load(key).catch(() => {}));
  }

  return { load, clone, preloadAll, isReady: (key) => !!_cache[key] };
})();
