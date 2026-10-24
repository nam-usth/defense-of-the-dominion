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
  uniform vec4 glowPos[ 8 ]; uniform vec4 glowCol[ 8 ]; uniform int glowCount;   // small lights (GLOW_LIGHTS)
#endif`;
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  float fogDepth = length( vFogXZ );
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * fogDepth * fogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, fogDepth );
  #endif
  // the small lights light what they fall on (soft, by horizontal distance) and lift the night
  // around them: full near, none at their reach
  vec3 glowLight = vec3( 0.0 );
  float glowLift = 0.0;
  for ( int i = 0; i < 8; i ++ ) {
    if ( i >= glowCount ) break;
    float gd = length( vFogXZ - glowPos[ i ].xz ), gr = glowPos[ i ].w;
    glowLight += glowCol[ i ].rgb * pow( clamp( 1.0 - gd / gr, 0.0, 1.0 ), 2.0 );
    glowLift = max( glowLift, glowCol[ i ].a * ( 1.0 - smoothstep( 0.35 * gr, gr, gd ) ) );
  }
  gl_FragColor.rgb += diffuseColor.rgb * glowLight;
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor * ( 1.0 - glowLift ) );
#endif`;
// Small lights that also lift the night fog around them (a Marauder grenade in flight, its burst),
// up to 8: xyz + reach, rgb + how much of the night they lift. game.js fills them every frame.
// Every material gets these shared uniforms through onBeforeCompile (wrapped, so a material's own
// hook — the SC2 materials' — still runs); uniforms its program lacks are ignored.
const GLOW_LIGHTS = { glowPos: { value: new Float32Array(32) }, glowCol: { value: new Float32Array(32) }, glowCount: { value: 0 } };
(() => {
  const inject = shader => Object.assign(shader.uniforms, GLOW_LIGHTS);
  Object.defineProperty(THREE.Material.prototype, 'onBeforeCompile', {
    configurable: true,
    get() { return this._ownBeforeCompile || inject; },
    set(fn) { this._ownBeforeCompile = function (shader, renderer) { fn.call(this, shader, renderer); inject(shader); }; },
  });
})();
