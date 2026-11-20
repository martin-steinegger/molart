import { NOISE_GLSL, SURFACE_GLSL } from '../art/glsl';

export const GBUFFER_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec4 aSurf;
in vec4 aInfo;
in vec3 aTangent;
in vec4 aPhys;
in vec2 aRun;
in float aFacet;
in vec4 aFace;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
uniform sampler2D tChainGroup;   // chain index -> layer index (x 255)
uniform float uGroup;            // layer being drawn; negative = draw every chain
out vec4 vSurf;
out vec4 vInfo;
out vec4 vPhys;
out vec2 vRun;
out vec3 vN;
out vec3 vObjN;
out vec3 vObjPos;
out vec3 vT;
out vec3 vViewPos;
flat out vec4 vFace;
flat out float vFacet;
void main(){
  vSurf = aSurf; vInfo = aInfo; vPhys = aPhys; vRun = aRun; vFacet = aFacet; vFace = aFace;
  vN = normalMatrix * normal;
  vObjN = normal;
  vObjPos = position;
  vT = normalMatrix * aTangent;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
  // chains that belong to another layer are moved outside the clip volume (whole triangles share a chain)
  float grp = texelFetch(tChainGroup, ivec2(int(clamp(aInfo.x, 0.0, 1023.0) + 0.5), 0), 0).r * 255.0;
  float hide = step(0.0, uGroup) * step(0.5, abs(grp - uGroup));
  gl_Position = mix(gl_Position, vec4(2.0, 2.0, 2.0, 1.0), hide);
}`;

/** Occluder fragment stage for layers that merely hide what is behind them while another layer is drawn. */
export const DEPTH_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gSurf;
layout(location = 2) out vec4 gNormal;
// Same values as the cleared background, except a tiny negative depth that marks "hidden by another layer".
void main(){ gColor = vec4(0.0); gSurf = vec4(0.0, 0.0, 0.0, -1e-6); gNormal = vec4(0.0); }`;

export const gbufferFrag = (styleGLSL: string, peel = false) => /* glsl */ `
${peel ? '#define PEEL 1' : ''}
precision highp float;
in vec4 vSurf;
in vec4 vInfo;
in vec4 vPhys;
in vec2 vRun;
in vec3 vN;
in vec3 vObjN;
in vec3 vObjPos;
in vec3 vT;
in vec3 vViewPos;
flat in vec4 vFace;
flat in float vFacet;
uniform float uSeed;
uniform vec3 uObjKey;
uniform vec3 uFrameX;
uniform vec3 uFrameY;
uniform vec3 uFrameC;
uniform vec3 uColA;   // user-selectable style colours (sRGB); used by styles that offer a colour choice
uniform vec3 uColB;
// sun: cast shadows from the key light (a depth picture taken from the light), off unless the user turns the sun on
uniform sampler2D tShadow;
uniform mat4 uShadowMat;    // object space -> light clip space
uniform float uShadowOn;
uniform float uShadowTexel; // one shadow-map texel in uv
uniform float uSunAmt;      // how much of the sun's light and shade this material takes (glass: little, its light is in the reflections)
#ifdef PEEL
uniform sampler2D tPrev;
uniform vec2 uRes;
#endif
layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gSurf;
layout(location = 2) out vec4 gNormal;
${NOISE_GLSL}
${SURFACE_GLSL}
float gCreaseId = -1.0;   // a style may set this in shadeSurface: crease lines then follow its own planes, not mesh facets
${styleGLSL}
void main(){
#ifdef PEEL
  float d0 = texture(tPrev, gl_FragCoord.xy / uRes).w;
  if (d0 > 0.0 && -vViewPos.z <= d0 + 0.08) discard;
#endif
  Surface s;
  s.t = vSurf.x; s.around = vSurf.y; s.across = vSurf.z; s.ss = floor(vSurf.w + 0.5);
  s.chain = vInfo.x; s.res = vInfo.y; s.faceY = vInfo.z; s.arrow = vInfo.w;
  s.facet = floor(vFacet + 0.5); s.phys = vPhys; s.face = vFace; s.run = vec2(vRun.x, floor(vRun.y + 0.5));
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  s.n = n;
  s.v = normalize(-vViewPos);
  vec3 t = vT - n * dot(vT, n);
  s.tangent = length(t) > 1e-5 ? normalize(t) : vec3(1.0, 0.0, 0.0);
  s.bin = normalize(cross(n, s.tangent));
  s.seed = uSeed;
  s.on = normalize(vObjN) * (gl_FrontFacing ? 1.0 : -1.0);
  s.objKey = normalize(uObjKey);
  // canvas coordinates: object position projected on the protein's principal plane (Å), anchored to the protein
  s.canvas = vec2(dot(vObjPos - uFrameC, uFrameX), dot(vObjPos - uFrameC, uFrameY));
  vec3 c = shadeSurface(s);
  // coloured key light: faces turned to the light take its colour, faces turned away keep their own
  {
    // sunlight: what the sun reaches takes its colour; what it does not reach falls into a cool, darker shade
    vec3 on = normalize(vObjN) * (gl_FrontFacing ? 1.0 : -1.0);
    vec4 sc = uShadowMat * vec4(vObjPos + on * 0.35, 1.0);
    vec3 sp = sc.xyz / sc.w * 0.5 + 0.5;
    float ang = hash12(gl_FragCoord.xy) * 6.2831853, ca = cos(ang), sa = sin(ang);
    float lit = 0.0;
    for (int i = 0; i < 8; i++) {
      float fi = float(i) + 0.5;
      float rr = sqrt(fi / 8.0) * 2.0, th = fi * 2.3999632;
      vec2 o = vec2(cos(th), sin(th)) * rr;
      o = vec2(o.x * ca - o.y * sa, o.x * sa + o.y * ca) * uShadowTexel;
      lit += step(sp.z - 0.0012, texture(tShadow, sp.xy + o).r);
    }
    lit /= 8.0;
    float facing = sstep(-0.1, 0.55, dot(n, normalize(uKey)));
    float direct = lit * facing;
    vec3 shade = vec3(0.34, 0.38, 0.56);
    c *= mix(vec3(1.0), mix(shade, uSun * 1.12, direct), uShadowOn * uSunAmt);
  }
  gColor = vec4(max(c, vec3(0.0)), 1.0 + s.ss);
  gSurf = vec4(s.t, s.across, s.faceY, -vViewPos.z);
  gNormal = vec4(n, mod(mix(s.facet, gCreaseId, step(0.0, gCreaseId)), 2048.0)); // half-float safe id for crease detection
}`;

export const FULLSCREEN_VERT = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * Composite: wash colour + contour ink. Contours are found by searching the G-buffer for
 * silhouette / occlusion / fold discontinuities; their width, breaks and wobble are driven by
 * the *occluding surface's residue parameter*, so marks are anchored to the protein.
 */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tSurf;
uniform sampler2D tNormal;
uniform vec2 uTexel;
uniform float uPx;           // device pixels per reference pixel
uniform float uSeed;
uniform vec3 uInk;
uniform vec3 uInk2;
uniform float uWidth;
uniform float uWidthVar;
uniform float uBreaks;
uniform float uDouble;
uniform float uWobble;
uniform float uCrease;
uniform float uCreaseAll;   // 1 = draw a crease wherever the id changes, even between coplanar pieces
uniform vec2 uMisreg;
uniform float uPooling;
uniform float uOpacity;
uniform float uSoft;
uniform float uFreq;
uniform float uFast;
uniform bool uTransparent;
uniform float uDissolve;
uniform float uDissolveW;
uniform sampler2D tPeelColor;
uniform sampler2D tPeelSurf;
uniform float uTrans;
uniform sampler2D tPeelNormal;
uniform sampler2D tPeel2Color;
uniform sampler2D tPeel2Surf;
uniform sampler2D tPeel2Normal;
uniform float uWaxSoft;      // translucent body: radius (reference px) over which the lobe behind is blurred; 0 = sharp
uniform float uWaxBehind;    // translucent body: opacity of the lobe seen through the front one
uniform float uWaxFrost;     // translucent body: radius (reference px) over which shading is softened; 0 = off
uniform float uWaxCore;      // translucent body: 1 = what lies behind a lobe is the body's own dense interior, not a drawn layer
uniform float uWaxLayers;    // translucent body: strength of the outlines seen through the front layer
uniform vec2 uWax;           // translucent body: (absorption per Å, fade of thin parts towards paper); x = 0 disables
uniform float uGlass;        // 1 = resolve the layers as tinted glass
uniform float uGlassDensity;
uniform float uGlassRefr;
uniform float uGlassThick;   // nominal thickness (Å) of a piece whose back face is unknown
uniform vec2 uRig;           // the studio lights turn with the user's light: (cos, sin) of its angle
uniform vec3 uRigCol;        // colour of the studio lights (linear rgb)
out vec4 outColor;
${NOISE_GLSL}

// a view-space direction as the studio sees it: the lights are fixed in the studio, the studio turns with the light
vec3 rig(vec3 v){ return vec3(v.x * uRig.x + v.y * uRig.y, -v.x * uRig.y + v.y * uRig.x, v.z); }
// highlights of a polished surface under the studio rig (view-space normal, viewer along +z)
float glassSpec(vec3 n){
  n = rig(n);
  vec3 h1 = normalize(normalize(vec3(-0.45, 0.65, 0.62)) + vec3(0.0, 0.0, 1.0));
  vec3 h2 = normalize(normalize(vec3(0.62, 0.12, 0.6)) + vec3(0.0, 0.0, 1.0));
  float a = max(dot(n, h1), 0.0), b = max(dot(n, h2), 0.0);
  return pow(a, 240.0) * 1.1 + pow(a, 26.0) * 0.14 + pow(b, 110.0) * 0.4;
}
// colour of light after crossing a glass piece seen through its surface with normal n
vec3 glassBody(vec3 tint, vec3 n, float thick){
  float nz = clamp(abs(n.z), 0.0, 1.0);
  float rim = pow(1.0 - nz, 3.0);
  return pow(max(tint, vec3(1e-3)), vec3(thick * uGlassDensity + rim * 1.6));
}

float widthAt(float t){ return uWidth * (1.0 + uWidthVar * (vnoise1(t * uFreq * 1.7 + uSeed) * 2.0 - 1.0)); }
float brokenAt(float t){ return uBreaks > 0.0 ? step(vnoise1(t * uFreq * 2.3 + 41.0 + uSeed * 1.3), uBreaks) : 0.0; }
float wobbleAt(float t){ return uWobble * vnoise1(t * uFreq * 3.1 + 7.0 + uSeed); }

void main(){
  vec4 s0 = texture(tSurf, vUv);
  vec4 n0 = texture(tNormal, vUv);
  bool bg0 = s0.w <= 0.0;
  vec3 paper = vec3(1.0);
  float transmission = bg0 ? 1.0 : 0.0;

  // --- wash colour with optional misregistration ---
  vec2 mo = uMisreg * uPx * uTexel;
  vec4 cMis = texture(tColor, vUv + mo);
  vec4 c0 = texture(tColor, vUv);
  vec3 col;
  if (bg0) {
    col = paper;
  } else {
    col = cMis.a > 0.5 ? cMis.rgb : mix(c0.rgb, paper, 0.97); // paper gap where the wash missed
  }

  // translucent ribbons: the next surface behind shows through (one peeled layer)
  if (!bg0 && uTrans > 0.0) {
    vec4 ps = texture(tPeelSurf, vUv);
    if (ps.w > 0.0) col = mix(col, col * texture(tPeelColor, vUv).rgb * 1.15, uTrans);
  }

  // translucent body: each lobe is only as opaque as it is thick along the line of sight; behind it the next
  // lobe shows through, and where nothing lies behind, the paper does
  if (!bg0 && uWax.x > 0.0) {
    vec4 wp = texture(tPeelSurf, vUv);                       // far side of the front lobe
    float has1 = step(1e-4, wp.w);
    float t1 = mix(6.0, clamp(wp.w - s0.w, 0.0, 14.0), has1);
    float a1 = 1.0 - exp(-t1 * uWax.x);
    vec4 w2 = texture(tPeel2Surf, vUv);                      // the next lobe behind
    float has2 = step(1e-4, w2.w) * has1;
    // frosted: the surface scatters what it shows, so shading is softened over a small neighbourhood of the body
    vec3 fsum = col;
    float fn = 1.0;
    vec2 fr = uWaxFrost * uPx * uTexel;
    for (int k = 0; k < 8; k++) {
      float ang = 0.7854 * float(k);
      vec2 q = vUv + vec2(cos(ang), sin(ang)) * fr * (1.0 + 0.6 * mod(float(k), 2.0));
      float on = step(1e-4, texture(tSurf, q).w);
      fsum += texture(tColor, q).rgb * on;
      fn += on;
    }
    col = mix(col, fsum / fn, step(1e-4, uWaxFrost) * 0.85);
    vec3 own = col;
    // what lies behind is seen through scattering material: soft, never a crisp second drawing
    vec3 bsum = texture(tPeel2Color, vUv).rgb;
    float bn = 1.0;
    vec2 br = uWaxSoft * uPx * uTexel;
    for (int k = 0; k < 6; k++) {
      float ang = 1.0472 * float(k) + 0.4;
      vec2 q = vUv + vec2(cos(ang), sin(ang)) * br;
      float on = step(1e-4, texture(tPeel2Surf, q).w);
      bsum += texture(tPeel2Color, q).rgb * on;
      bn += on;
    }
    // scattering also takes the contrast out of what is seen through
    vec3 c2 = mix(mix(bsum / bn, own, 0.5 * step(1e-4, uWaxSoft)), own * vec3(0.86, 0.66, 0.5), uWaxCore);
    vec3 lightThrough = mix(paper, own, 1.0 - uWax.y);       // paper seen through a film of the material
    // the lobe behind is itself translucent: it lets some paper through, more so when the gap to it is wide
    float a2 = mix(uWaxBehind - 0.25 * sstep(2.0, 10.0, w2.w - wp.w), 1.0, uWaxCore);
    // in front of another lobe the thin part glows in a lighter tone of its own colour (light scattered inside);
    // in front of nothing it fades to the paper
    vec3 scatter = mix(lightThrough, mix(own, sqrt(own), 0.85), 0.75);
    vec3 behind = mix(lightThrough, mix(scatter, c2, a2), has2);
    // with a soft body the thin edge of a lobe stays luminous in front of another lobe (it scatters light,
    // it does not turn into a clear film); only towards the paper does it thin out fully
    float keep = 0.82 * step(1e-4, uWaxSoft) * has2;
    float body = mix(a1, 1.0, keep);
    col = mix(behind, own, body);
    // edges of the layers behind read as soft lines inside the body
    vec2 we = 1.4 * uPx * uTexel;
    float wd = max(max(abs(texture(tPeelSurf, vUv + vec2(we.x, 0.0)).w - wp.w), abs(texture(tPeelSurf, vUv - vec2(we.x, 0.0)).w - wp.w)),
                   max(abs(texture(tPeelSurf, vUv + vec2(0.0, we.y)).w - wp.w), abs(texture(tPeelSurf, vUv - vec2(0.0, we.y)).w - wp.w)));
    float lines = has1 * sstep(0.5, 1.6, wd) * (1.0 - 0.5 * a1) * uWaxLayers;
    col = mix(col, own * 0.9, lines);
    if (uTransparent) {
      transmission = uWax.y * mix(1.0, 0.25 * (1.0 - a2), has2) * (1.0 - body) * (1.0 - lines);
    }
  }

  // glass: absorb by measured thickness, refract what lies behind, add highlights and rim
  if (!bg0 && uGlass > 0.5) {
    vec3 n = normalize(n0.xyz + vec3(0.0, 0.0, 1e-4));
    float nz = clamp(n.z, 0.0, 1.0);
    vec4 p1 = texture(tPeelSurf, vUv);
    float has1 = step(1e-4, p1.w);
    float thick = mix(uGlassThick / max(nz, 0.3), clamp(p1.w - s0.w, 0.0, 4.5), has1);
    float dExit = s0.w + thick;
    // what is behind this piece, looked up along the refracted ray
    vec2 ruv = vUv - n.xy * uGlassRefr * uPx * uTexel * (0.4 + 0.3 * thick);
    vec4 b2s = texture(tPeel2Surf, ruv);
    vec4 b0s = texture(tSurf, ruv);
    vec4 d2s = texture(tPeel2Surf, vUv);
    float useB2 = step(dExit + 0.05, b2s.w);
    float useB0 = (1.0 - useB2) * step(dExit + 1.0, b0s.w);
    float useD2 = (1.0 - useB2) * (1.0 - useB0) * step(dExit + 0.05, d2s.w);
    vec3 bt = texture(tPeel2Color, ruv).rgb * useB2 + texture(tColor, ruv).rgb * useB0 + texture(tPeel2Color, vUv).rgb * useD2;
    vec3 bn = texture(tPeel2Normal, ruv).xyz * useB2 + texture(tNormal, ruv).xyz * useB0 + texture(tPeel2Normal, vUv).xyz * useD2;
    float found = clamp(useB2 + useB0 + useD2, 0.0, 1.0);
    bn = normalize(bn + vec3(0.0, 0.0, 1e-4));
    vec3 backTint = glassBody(max(bt, vec3(1e-3)), bn, uGlassThick / max(abs(bn.z), 0.4));
    vec3 frontTint = glassBody(c0.rgb, n, thick);
    float backSpec = glassSpec(bn) * 0.3;
    vec3 back = mix(paper, backTint + vec3(backSpec), found);
    col = back * frontTint;
    // the glass has body: part of the light is scattered in the tinted mass instead of passing through
    float wrap = dot(rig(n), normalize(vec3(-0.45, 0.65, 0.62))) * 0.5 + 0.5;
    vec3 solid = pow(max(c0.rgb, vec3(1e-3)), vec3(1.25)) * (0.66 + 0.4 * wrap);
    col = mix(col, solid, 0.13);
    // the far face of this piece: its own faint highlights, and its edges read as lines inside the glass
    vec3 n1 = normalize(texture(tPeelNormal, vUv).xyz + vec3(0.0, 0.0, 1e-4));
    float farSpec = glassSpec(n1) * 0.25 * has1;
    col += uRigCol * farSpec;
    vec2 e = 1.3 * uPx * uTexel;
    vec2 iuv = vUv - n.xy * uGlassRefr * 0.5 * uPx * uTexel;   // seen through the front face, so shifted
    float pc = texture(tPeelSurf, iuv).w;
    float dd = max(max(abs(texture(tPeelSurf, iuv + vec2(e.x, 0.0)).w - pc), abs(texture(tPeelSurf, iuv - vec2(e.x, 0.0)).w - pc)),
                   max(abs(texture(tPeelSurf, iuv + vec2(0.0, e.y)).w - pc), abs(texture(tPeelSurf, iuv - vec2(0.0, e.y)).w - pc)));
    col *= mix(vec3(1.0), mix(vec3(1.0), c0.rgb, 0.8), has1 * step(1e-4, pc) * sstep(0.45, 1.1, dd));
    // a slow wavy line inside the broad faces: the far edge seen bent through the bar (anchored to the ribbon)
    float isBar = step(1.5, c0.a) * sstep(0.6, 0.85, abs(s0.z));
    float wav = (vnoise1(s0.x * 0.55 + uSeed) - 0.5) * 1.1 + 0.25 * sin(s0.x * 1.3);
    float streak = 1.0 - sstep(0.03, 0.09, abs(s0.y - wav));
    col *= mix(vec3(1.0), mix(vec3(1.0), c0.rgb, 0.4), isBar * streak);
    // cut ends are dense: nearly opaque, in the deep tone of the glass
    float cut = 1.0 - step(0.16, max(c0.r, max(c0.g, c0.b)));
    col = mix(col, c0.rgb * (1.6 + 2.2 * wrap), cut);
    // polished surface. Broad bar faces are treated as very slightly pillowed, so the studio lights
    // reflect as long streaks running along the bar instead of switching a whole flat face on or off.
    vec2 ag = vec2(dFdx(s0.y), dFdy(s0.y));
    float agl = length(ag);
    ag = ag / max(agl, 1e-6) * step(1e-6, agl) * (1.0 - step(0.5, agl));
    vec3 ng = normalize(n + vec3(ag * s0.y * 0.42 * isBar, 0.0));
    float gz = clamp(ng.z, 0.0, 1.0);
    float fres = 0.05 + 0.95 * pow(1.0 - gz, 5.0);
    vec3 rr = rig(2.0 * ng.z * ng - vec3(0.0, 0.0, 1.0));
    // hard-edged soft boxes: a big key window upper left, a thin strip on the right, a low fill bar
    float key = sstep(-0.74, -0.70, rr.x) * (1.0 - sstep(-0.16, -0.12, rr.x)) * sstep(0.16, 0.20, rr.y) * (1.0 - sstep(0.80, 0.84, rr.y));
    float mull = 1.0 - 0.75 * (1.0 - sstep(0.0, 0.025, abs(rr.x + 0.43)));           // the window's glazing bar
    float strip = sstep(0.40, 0.43, rr.x) * (1.0 - sstep(0.52, 0.55, rr.x)) * sstep(-0.7, -0.6, rr.y) * (1.0 - sstep(0.75, 0.85, rr.y));
    float fill = sstep(-0.62, -0.58, rr.y) * (1.0 - sstep(-0.44, -0.40, rr.y)) * (1.0 - sstep(0.5, 0.7, abs(rr.x)));
    float sky = sstep(0.1, 0.9, rr.y);
    // the dark side of the studio reflects too: it deepens the glass between the lights
    col *= 1.0 - 0.22 * (1.0 - sky) * (1.0 - cut);
    float refl = key * mull * 0.80 + strip * 0.55 + fill * 0.22 + sky * 0.10;
    float reflection = clamp(refl * (0.42 + 0.58 * fres) + fres * 0.45, 0.0, 1.0) * (1.0 - 0.85 * cut);
    float frontSpec = glassSpec(ng);
    col = mix(col, vec3(0.985, 0.975, 1.0) * uRigCol, reflection);
    col += uRigCol * frontSpec;
    if (uTransparent) {
      // PNG alpha is scalar, so estimate background transmission from the tinted light's luminance.
      vec3 through = frontTint * mix(paper, backTint, found);
      float spec = clamp(frontSpec + farSpec + backSpec * found, 0.0, 1.0);
      transmission = 0.87 * dot(through, vec3(0.2126, 0.7152, 0.0722));
      transmission *= (1.0 - cut) * (1.0 - reflection) * (1.0 - spec);
    }
  }

  // --- contour search ---
  float maxW = (max(uWidth * (1.0 + uWidthVar) + uWobble + (uDouble > 0.0 ? uWidth * 2.5 : 0.0), uDissolveW) + 1.0) * uPx;
  float steps = clamp(ceil(maxW), 1.0, mix(24.0, 10.0, uFast));
  float ndir = mix(16.0, 8.0, uFast);   // fewer search directions while the view is moving
  float ink = 0.0;
  float inkT = 0.0;
  float poolD = 1e9;
  float soft = max(uSoft * uPx, 0.5);
  for (int d = 0; d < 16; d++) {
    if (float(d) >= ndir) break;
    float a = float(d) * 6.2831853 / ndir;
    vec2 dir = vec2(cos(a), sin(a));
    for (int k = 1; k <= 24; k++) {
      float r = float(k);
      if (r > steps) break;
      vec4 s1 = texture(tSurf, vUv + dir * r * uTexel);
      if (s1.w <= 0.0) { if (!bg0) poolD = min(poolD, r); continue; }
      bool edge = false;
      if (bg0) edge = true;                                         // silhouette against paper
      else if (s1.w < s0.w - max(0.6, 0.02 * s0.w)) edge = true;     // occluded by a nearer part
      else if (abs(s1.x - s0.x) > 2.5 && s1.w < s0.w) edge = true;   // different part of the chain crossing
      if (!edge) continue;
      float tq = s1.x;
      if (brokenAt(tq) > 0.5) continue;
      float w = widthAt(tq) * uPx;
      float off = wobbleAt(tq) * uPx;
      float cov = 1.0 - sstep(w - soft, w + soft, r - off);
      cov *= sstep(off - soft - 0.5, off + 0.5, r);
      if (uDouble > 0.0) {
        float on2 = step(1.0 - uDouble, vnoise1(tq * uFreq * 0.9 + 91.0 + uSeed));
        float o2 = off + w + (0.5 + 1.0 * vnoise1(tq * 2.9 + uSeed)) * uPx;
        float w2 = max(w * 0.6, 0.9 * uPx);
        float c2 = (1.0 - sstep(w2 * 0.5 - soft, w2 * 0.5 + soft, abs(r - (o2 + w2 * 0.5)))) * on2;
        cov = max(cov, c2);
      }
      if (cov > ink) { ink = cov; inkT = tq; }
    }
  }
  // fold contours: top/bottom face flip of a ribbon, or facet creases
  if (!bg0) {
    float fold = 0.0;
    float cw = max(uCrease, 0.0) * uPx;
    float fr = max(1.0, ceil(max(cw, uWidth * 0.6 * uPx)));
    for (int d = 0; d < 8; d++) {
      float a = float(d) * 0.78539816;
      vec2 dir = vec2(cos(a), sin(a));
      for (int k = 1; k <= 8; k++) {
        float r = float(k);
        if (r > fr) break;
        vec4 s1 = texture(tSurf, vUv + dir * r * uTexel);
        if (s1.w <= 0.0) continue;
        vec4 n1 = texture(tNormal, vUv + dir * r * uTexel);
        bool faceFlip = s0.z * s1.z < -0.25 && abs(s0.z) > 0.6 && abs(s1.z) > 0.6 && s1.w < s0.w + 0.3 && abs(s1.x - s0.x) < 1.5;
        bool crease = uCrease > 0.0 && abs(n1.w - n0.w) > 0.5 && (uCreaseAll > 0.5 || dot(n0.xyz, n1.xyz) < 0.985) && n1.w > n0.w && abs(s1.w - s0.w) < 1.2;
        if (faceFlip && s1.z > s0.z) {
          float w = widthAt(s1.x) * 0.75 * uPx;
          fold = max(fold, 1.0 - sstep(w - soft, w + soft, r));
          if (fold > ink) inkT = s1.x;
        }
        if (crease) fold = max(fold, (1.0 - sstep(cw - soft, cw + soft, r)) * 0.85);
      }
    }
    ink = max(ink, fold);
  }
  // watercolour pooling: darker pigment along the wash boundary
  if (!bg0 && uPooling > 0.0 && poolD < 1e8) {
    col *= 1.0 - uPooling * (1.0 - sstep(0.0, steps, poolD));
  }
  // dry / soft edge: the wash breaks up into paper near its silhouette (noise anchored to t, across)
  if (!bg0 && uDissolve > 0.0 && poolD < 1e8) {
    float edge = poolD / max(uDissolveW * uPx, 1.0);
    float nz = fbm2(vec2(s0.x * 2.3, s0.y * 3.1) + uSeed);
    if (edge < uDissolve * (0.25 + 1.5 * nz)) col = mix(col, paper, 0.85);
  }
  vec3 inkCol = mix(lin(uInk), lin(uInk2), vnoise1(inkT * 0.37 + uSeed * 2.0));
  float inkCoverage = clamp(ink * uOpacity, 0.0, 1.0);
  col = mix(col, inkCol, inkCoverage);
  if (bg0 && ink <= 0.0 && cMis.a <= 0.5) col = paper;
  vec3 rgb = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  // Store white-matted RGB and the transmitted fraction of that white. Both can be multiplied
  // across layers and filtered together before we recover straight RGBA for PNG.
  float t = pow(clamp(transmission * (1.0 - inkCoverage), 0.0, 1.0), 1.0 / 2.2);
  outColor = vec4(rgb, uTransparent ? min(t, min(rgb.r, min(rgb.g, rgb.b))) : 1.0);
}`;

export const DOWNSAMPLE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uSrcTexel;
out vec4 outColor;
void main(){
  // Source is 2x (or 1x) the output size. A bilinear tap at the output pixel centre averages the
  // 2x2 source block exactly; four extra half-weight taps give a gentle tent filter.
  vec4 c = texture(tSrc, vUv) * 0.5;
  c += texture(tSrc, vUv + vec2( 1.0,  1.0) * uSrcTexel) * 0.125;
  c += texture(tSrc, vUv + vec2(-1.0,  1.0) * uSrcTexel) * 0.125;
  c += texture(tSrc, vUv + vec2( 1.0, -1.0) * uSrcTexel) * 0.125;
  c += texture(tSrc, vUv + vec2(-1.0, -1.0) * uSrcTexel) * 0.125;
  outColor = c;
}`;


/**
 * ASCII pass: lays a character grid over the finished image. Each cell is either text (a glyph picked
 * from the brightness of the picture under the cell, in the hue found there) or the picture itself; a
 * fixed per-cell dither hands cells from text (left) to picture (right).
 */
export const ASCII_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform sampler2D tSrc;      // finished image (display-encoded)
uniform vec2 uSrcTexel;      // source texel for the tent filter (0 when the source is not supersampled)
uniform sampler2D tSurf;     // G-buffer surface data; w > 0 where the protein is
uniform sampler2D tGlyph;    // glyph distance atlas
uniform float uGlyphN;       // glyphs in the atlas
uniform float uGlyphRange;
uniform vec2 uCell;          // cell size in uv
uniform float uPxCell;       // one output pixel in cell heights
uniform vec2 uBlend;
uniform bool uTransparent;
out vec4 outColor;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void tap(vec2 q, inout vec3 acc, inout float cov){
  float on = step(1e-4, texture(tSurf, q).w);
  acc += texture(tSrc, q).rgb * on;
  cov += on;
}
void main(){
  vec4 pic = texture(tSrc, vUv) * 0.5;
  pic += texture(tSrc, vUv + vec2( 1.0,  1.0) * uSrcTexel) * 0.125;
  pic += texture(tSrc, vUv + vec2(-1.0,  1.0) * uSrcTexel) * 0.125;
  pic += texture(tSrc, vUv + vec2( 1.0, -1.0) * uSrcTexel) * 0.125;
  pic += texture(tSrc, vUv + vec2(-1.0, -1.0) * uSrcTexel) * 0.125;
  vec2 g = vUv / uCell;
  vec2 cell = floor(g);
  vec2 loc = g - cell;
  vec2 cuv = (cell + 0.5) * uCell;
  // text amount: 1 on the left, 0 on the right
  float t = clamp((cuv.x - uBlend.x) / max(uBlend.y - uBlend.x, 1e-4), 0.0, 1.0);
  float f = 1.0 - t * t * (3.0 - 2.0 * t);
  float isText = step(hash12(cell + 17.0), f * 1.04) * step(0.001, f);
  // what the picture shows under this cell: five taps, only those on the protein count
  vec3 acc = vec3(0.0);
  float cov = 0.0;
  tap(cuv, acc, cov);
  tap(cuv + vec2( 0.3,  0.3) * uCell, acc, cov);
  tap(cuv + vec2(-0.3,  0.3) * uCell, acc, cov);
  tap(cuv + vec2( 0.3, -0.3) * uCell, acc, cov);
  tap(cuv + vec2(-0.3, -0.3) * uCell, acc, cov);
  vec3 cc = acc / max(cov, 1.0);
  float lum = dot(cc, vec3(0.299, 0.587, 0.114));
  float v = clamp(0.30 + 1.25 * (0.75 - lum), 0.0, 1.0) * (0.45 + 0.55 * f);
  float idx = clamp(floor(v * uGlyphN + 0.5), 1.0, uGlyphN) - 1.0;
  float val = texture(tGlyph, vec2((idx + clamp(loc.x, 0.02, 0.98)) / uGlyphN, loc.y)).r;
  float sd = (0.5 - val) * 2.0 * uGlyphRange;
  float inkA = clamp(0.5 - sd / max(uPxCell, 1e-5), 0.0, 1.0) * step(0.5, cov);
  inkA *= step(-1e-7, texture(tSurf, vUv).w);   // no text over a chain of another layer that lies in front
  // text takes the hue under the cell at a fixed strength, so it reads on white
  float onC = step(1e-4, texture(tSurf, cuv).w);
  vec3 hc = mix(cc, texture(tSrc, cuv).rgb, onC);   // the cell centre decides the colour where it is covered
  vec3 hue = hc / max(max(hc.r, max(hc.g, hc.b)), 1e-3);
  vec3 tc = hue * hue * 0.84;
  vec3 text = mix(vec3(1.0), tc, inkA);
  outColor = mix(pic, vec4(text, uTransparent ? 1.0 - inkA : 1.0), isText);
}`;
