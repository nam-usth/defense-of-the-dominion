// ─── RADIAL FOG ──────────────────────────────────────────────────────────────
// three.js measures fog by camera depth, but the camera sits ~23 units from the
// bunker, so the night fog (far = 9) blanked the whole battlefield. Measure fog
// as horizontal distance from the bunker instead — the night "vision radius" the
// day/night constants and the enemy culling already assume. Must run before any
// material compiles. (Sprites have no `transformed`; give them fog:false.)
// The distance is computed per fragment from an interpolated world XZ: a per-
// vertex distance on the 4-vertex ground quad would fog the whole ground evenly.
THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
  varying vec2 vFogXZ;
#endif`;
THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  vec4 _fw = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    _fw = instanceMatrix * _fw;
  #endif
  vFogXZ = ( modelMatrix * _fw ).xz;
#endif`;
THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
  uniform vec3 fogColor;
  varying vec2 vFogXZ;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  float fogDepth = length( vFogXZ );
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * fogDepth * fogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, fogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;
