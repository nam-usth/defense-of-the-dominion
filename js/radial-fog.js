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
  // a read at a set mip (GLSL ES 1 has none in a fragment shader: there, a bias, near enough)
  #if __VERSION__ >= 300
    #define NOISE_LOD( t, u, l ) textureLod( t, u, l )
  #else
    #define NOISE_LOD( t, u, l ) texture2D( t, u, l )
  #endif
  uniform sampler2D cloudTex; uniform vec2 shadeDrift, cloudDrift; uniform float cloudAmt, cloudOn, fogNight; uniform vec3 skyZen, skyHor, fogGround;
  // Cloud shadows drifting over the field: the sun dims in soft irregular patches, two reads of the noise at rotated
  // scales (one read's lattice shows as a regular pattern of bands; these have no period in common), deeper under a
  // clear sky's scattered clouds than where the overcast has already dimmed it. The drift wraps at 480, a whole
  // number of both tiles
  float cloudShade( vec2 xz ) {
    if ( cloudOn < 0.5 ) return 1.0;
    float n = 0.55 * NOISE_LOD( cloudTex, mat2( 0.825, 0.565, -0.565, 0.825 ) * xz / 240.0 + shadeDrift / 240.0, 1.5 ).r
            + 0.45 * NOISE_LOD( cloudTex, mat2( -0.320, 0.947, -0.947, -0.320 ) * xz / 160.0 + shadeDrift.yx / 160.0, 1.5 ).g;
    return 1.0 - mix( 0.24, 0.14, cloudAmt ) * smoothstep( 0.47, 0.66, n );
  }
  #ifdef STANDARD
  // What a polished surface mirrors, for want of an environment map: the sky above, the field below, on a fresnel
  // edge that a rough surface shows less of
  vec3 envSpec( vec3 N, vec3 V, vec3 f0, float rough ) {
    vec3 R = inverseTransformDirection( reflect( -V, N ), viewMatrix );
    vec3 sky = R.y >= 0.0 ? mix( skyHor, skyZen, sqrt( R.y ) ) : mix( skyHor, vec3( 0.16, 0.2, 0.1 ) * dot( skyHor, vec3( 0.299, 0.587, 0.114 ) ), min( 1.0, -3.0 * R.y ) );
    return ( f0 + ( max( vec3( 1.0 - rough ), f0 ) - f0 ) * pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 5.0 ) ) * sky;
  }
  #endif
#endif`;
// the sun (lit first: it casts the shadow) dims under the clouds
{
  const c = THREE.ShaderChunk.lights_fragment_begin, at = c.indexOf('RE_Direct', c.indexOf('directionalLightShadows[ i ]'));
  if (at < 0) console.error('radial-fog: the sun loop was not found: no cloud shadows');
  else THREE.ShaderChunk.lights_fragment_begin = c.slice(0, at) + `#ifdef USE_FOG
		if ( UNROLLED_LOOP_INDEX == 0 ) directLight.color *= cloudShade( vFogXZ );
		#endif
		` + c.slice(at);
}
// The ambient by which way a surface faces: the sky over it, the field's dim green bounce under it
{
  const HEMI = 'mix( vec3( 0.6, 0.65, 0.52 ), vec3( 1.05, 1.05, 1.1 ), 0.5 + 0.5 * inverseTransformDirection( N_, viewMatrix ).y )';
  const f = 'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );';
  if (!THREE.ShaderChunk.lights_fragment_begin.includes(f)) console.error('radial-fog: the ambient was not found');
  THREE.ShaderChunk.lights_fragment_begin = THREE.ShaderChunk.lights_fragment_begin.replace(f, f + ' irradiance *= ' + HEMI.replace('N_', 'geometry.normal') + ';');
  THREE.ShaderChunk.lights_lambert_vertex = THREE.ShaderChunk.lights_lambert_vertex
    .replace('vIndirectFront += getAmbientLightIrradiance( ambientLightColor );', 'vIndirectFront += getAmbientLightIrradiance( ambientLightColor ) * ' + HEMI.replace('N_', 'geometry.normal') + ';')
    .replace('vIndirectBack += getAmbientLightIrradiance( ambientLightColor );', 'vIndirectBack += getAmbientLightIrradiance( ambientLightColor ) * ' + HEMI.replace('N_', 'backGeometry.normal') + ';');
}
// and a polished surface mirrors the sky
THREE.ShaderChunk.lights_fragment_end += `
#if defined( STANDARD ) && defined( USE_FOG )
	reflectedLight.indirectSpecular += envSpec( geometry.normal, geometry.viewDir, material.specularColor, material.specularRoughness );
#endif
`;
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
  // at night the fogged field is not black: it fades to its own moonlit value (FOG_TARGET: the ground, the grass
  // and the boulders work out their own), and everything else to the mean of the ground's, where a unit blends in
  #ifndef FOG_TARGET
    #define FOG_TARGET mix( fogColor, fogGround, fogNight )
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, FOG_TARGET, fogFactor * ( 1.0 - glowLift ) );
#endif`;
// Small lights that also lift the night fog around them (a Marauder grenade in flight, its burst),
// up to 8: xyz + reach, rgb + how much of the night they lift. game.js fills them every frame.
// Every material gets these shared uniforms through onBeforeCompile (wrapped, so a material's own
// hook — the SC2 materials' — still runs); uniforms its program lacks are ignored.
const GLOW_LIGHTS = { glowPos: { value: new Float32Array(32) }, glowCol: { value: new Float32Array(32) }, glowCount: { value: 0 },
  // and what the lit materials read of the sky: the noise and drift of the cloud shadows (cloudOn: HIGH), the cloud
  // cover, the sky a polished surface mirrors, and how the night's fog fades what is not the ground
  cloudTex: { value: null }, shadeDrift: { value: new THREE.Vector2() }, cloudDrift: { value: new THREE.Vector2() }, cloudAmt: { value: 0 }, cloudOn: { value: 1 },
  skyZen: { value: new THREE.Color(0.36, 0.5, 0.68) }, skyHor: { value: new THREE.Color(0.62, 0.7, 0.77) }, fogNight: { value: 0 }, fogGround: { value: new THREE.Color(0, 0, 0) } };
(() => {
  const inject = shader => Object.assign(shader.uniforms, GLOW_LIGHTS);
  Object.defineProperty(THREE.Material.prototype, 'onBeforeCompile', {
    configurable: true,
    get() { return this._ownBeforeCompile || inject; },
    set(fn) { this._ownBeforeCompile = function (shader, renderer) { fn.call(this, shader, renderer); inject(shader); }; },
  });
})();
