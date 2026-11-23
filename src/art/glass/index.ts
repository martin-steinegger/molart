import { ArtStyle, baseInk } from '../types';

/**
 * Glass — the ribbons as tinted, polished glass.
 * Thick rounded bars for strands and helices, round rods for loops. The G-buffer stores each surface's
 * tint (the colour light keeps after one ångström of glass); the composite pass then looks through three
 * depth layers (front face, back face of the same piece, whatever lies behind): colour deepens with the
 * measured glass thickness, the pieces behind show through slightly refracted, and the surface carries
 * sharp highlights and a bright grazing rim. Everything is derived from the ribbon geometry.
 */
export const glassStyle: ArtStyle = {
  id: 'glass',
  label: 'Glass',
  technique: 'Tinted glass: rectangular bars with dark cut ends and thin rods; colour deepens with glass thickness and shifts with viewing angle; refracted see-through layers, bevel lines and sharp highlights. Strand direction is not marked.',
  mesh: 'smooth',
  ribbon: { helixWidth: 2.7, helixThickness: 0.85, strandWidth: 3.0, strandThickness: 0.85, coilRadius: 0.28, flatness: 9, profileSegments: 28, blockEnds: true },
  glass: { colors: [[0.95, 0.36, 0.74], [0.47, 0.38, 0.95]], density: 0.62, refraction: 17 },
  art: {
    note: 'glass cane: each helix is one thick solid rod as wide as the helix itself, cut clean at both ends; strands and loops stay as they are.',
    ribbon: { smooth: { helix: 8 }, helixWidth: 4.6, helixThickness: 4.6, helixFlatness: 2 },
  },
  surfaceGLSL: /* glsl */ `
vec3 shadeSurface(Surface s){
  // Tint = colour light keeps per ångström of glass. Bars take colour A and shift towards B where the
  // surface turns away from the viewer (dichroic glass) and on their narrow side faces; loops run B with
  // slow drifts of A along the chain.
  float body = sstep(0.5, 1.5, s.ss + 0.5);                 // 0 loop, 1 helix / strand
  float top = sstep(0.45, 0.8, abs(s.faceY));               // 1 on the broad faces
  float facing = clamp(dot(s.n, s.v), 0.0, 1.0);
  vec3 a = lin(uColA), b = lin(uColB);
  float turn = pow(1.0 - facing, 1.4);
  vec3 bar = mix(a, b, clamp(turn * 0.3 + (1.0 - top) * 0.25, 0.0, 1.0));   // the second colour mostly comes with depth (composite pass)
  // polished bevel: a bright line along the long edges of the broad faces, a darker seam just inside it
  float e = abs(s.across);
  float edge = top * sstep(0.84, 0.93, e);
  float seam = top * sstep(0.66, 0.76, e) * (1.0 - sstep(0.78, 0.86, e));
  bar = mix(bar, vec3(1.0), edge * 0.6) * (1.0 - seam * 0.12);
  vec3 loop = mix(b, a, 0.25 + 0.6 * sstep(0.3, 0.7, vnoise1(s.t * 0.21 + s.seed)));
  loop = loop * loop * mix(loop, vec3(1.0), 0.3);            // thin rods need denser glass to hold their colour
  vec3 t = mix(loop, bar, body);
  // cut ends of the bars: dense, dark glass
  float cut = step(0.5, s.arrow);
  return mix(t, a * a * 0.12, cut);
}`,
  ink: { ...baseInk, color: [0.36, 0.06, 0.36], color2: [0.24, 0.1, 0.5], width: 0.6, opacity: 0.55, softness: 0.4 },
};
