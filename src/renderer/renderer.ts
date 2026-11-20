import * as THREE from 'three';
import { cubistMesh } from '../geometry/cubist';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import type { Structure } from '../model/structure';
import { buildRibbon, flatten, MeshData, scaleRibbonWidths } from '../geometry/ribbon';
import { meltMesh } from '../geometry/dali';
import { splatterMesh } from '../geometry/splatter';
import { faceAnchors } from '../geometry/faces';
import { buildSurface } from '../geometry/surface';
import { principalFrame, ViewFrame } from '../geometry/frame';
import type { ArtStyle } from '../art/types';
import { buildGlyphAtlas, GLYPH_ASPECT, GLYPH_RANGE } from '../art/asciifold/glyphs';
import { ASCII_FRAG, COMPOSITE_FRAG, DEPTH_FRAG, DOWNSAMPLE_FRAG, FULLSCREEN_VERT, GBUFFER_VERT, gbufferFrag } from './shaders';

export const RENDERER_VERSION = '0.1.0';

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
}

export interface RenderParams {
  seed: number;
  /** Artistic deformation amount (only used by deformable styles). 0 = scientific geometry. */
  deform: number;
  /** Optional override of a style's two selectable colours (sRGB 0..1); null = the style's defaults. */
  colors?: [[number, number, number], [number, number, number]] | null;
  /** Character styles (Cartoon): false draws the plain ribbons without faces, heads and arms. Default true. */
  faces?: boolean;
  /** art mode: styles that define one draw simplified / reshaped forms instead of the true ribbon (display only) */
  art?: boolean;
  /**
   * Art mode, part way (0 = the true ribbon, 1 = the art form): the drawn mesh is blended vertex by vertex.
   * Ribbon styles only; surface styles ignore it.
   */
  artBlend?: number;
  /** Text styles (ASCII Fold): share of the picture drawn as text, 0 (all ribbon) .. 1 (all text); null = the style's default blend. */
  ascii?: number | null;
  /** Sun: a low key light that casts shadows, turned by `angle` degrees about the viewing direction from upper left, with an sRGB colour. null = off (each style's own even light). */
  light?: { angle: number; color: [number, number, number] } | null;
}

/** Deterministic 32-bit hash of a string → float seed in [0, 1000). */
export function seedFor(structureId: string, seed: number): number {
  let h = 2166136261 ^ seed;
  for (const ch of `${structureId}:${seed}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 100000) / 100;
}

function toGeometry(m: MeshData & { facet?: Float32Array; face?: Float32Array }): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setAttribute('aSurf', new THREE.BufferAttribute(m.surf, 4));
  g.setAttribute('aInfo', new THREE.BufferAttribute(m.info, 4));
  g.setAttribute('aTangent', new THREE.BufferAttribute(m.tangents, 3));
  g.setAttribute('aPhys', new THREE.BufferAttribute(m.phys, 4));
  // piece information (art mode); vertices added later by a deformation carry none
  const run = new Float32Array(m.vertexCount * 2);
  if (m.run) run.set(m.run.subarray(0, Math.min(m.run.length, run.length)));
  g.setAttribute('aRun', new THREE.BufferAttribute(run, 2));
  g.setAttribute('aFacet', new THREE.BufferAttribute(m.facet ?? new Float32Array(m.vertexCount), 1));
  g.setAttribute('aFace', new THREE.BufferAttribute(m.face ?? new Float32Array(m.vertexCount * 4), 4));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeBoundingSphere();
  return g;
}

export class MolartRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(22, 1, 1, 5000);
  readonly controls: TrackballControls;
  private scene = new THREE.Scene();
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private compositeMat: THREE.RawShaderMaterial;
  private downMat: THREE.RawShaderMaterial;
  private asciiMat: THREE.RawShaderMaterial;
  /** One layer per distinct style in use (a single layer unless chains carry their own styles). */
  private layers: { style: ArtStyle; chains: number[]; mesh: THREE.Mesh; front: THREE.RawShaderMaterial; depth: THREE.RawShaderMaterial }[] = [];
  /** Per-chain style overrides (chain index → style); chains without an entry use the main style. */
  private chainStyles = new Map<number, ArtStyle>();
  /** Chains whose mode (science / art) differs from the main one. */
  private chainArt = new Map<number, boolean>();
  /** chain index → layer index, read by the vertex shader to draw only a layer's own chains */
  private chainTex = new THREE.DataTexture(new Uint8Array(1024), 1024, 1, THREE.RedFormat, THREE.UnsignedByteType);
  private geomCache = new Map<string, THREE.BufferGeometry>();
  private matCache = new Map<string, THREE.RawShaderMaterial>();
  /** sun (cast shadows): uniforms shared by every surface material, a depth picture from the light, its camera */
  private sunU = { tShadow: { value: null as THREE.Texture | null }, uShadowMat: { value: new THREE.Matrix4() }, uShadowOn: { value: 0 }, uShadowTexel: { value: 1 / 2048 } };
  private sunDir = new THREE.Vector3(-0.42, 0.62, 0.66).normalize();   // towards the light, view space
  private sunCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private sunTarget: THREE.WebGLRenderTarget | null = null;
  private gbuf: THREE.WebGLRenderTarget | null = null;
  private peelCache = new Map<string, THREE.RawShaderMaterial>();
  private dummyTex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  private comp: THREE.WebGLRenderTarget | null = null;
  structure: Structure | null = null;
  frame: ViewFrame | null = null;
  style: ArtStyle | null = null;
  params: RenderParams = { seed: 1, deform: 0 };
  /** Debug/tuning: partial ink parameter override applied on top of the style. */
  inkOverride: Partial<import('../art/types').InkParams> = {};
  private dirty = true;
  private lastMove = -1e9;
  private interacting = false;
  private lastGoodCamera: CameraState | null = null;
  private fastOut: THREE.WebGLRenderTarget | null = null;
  private needsRefine = false;
  /** Canvas pixel budgets (device pixels) for interactive frames. */
  quality = { fastPixels: 1.4e6, fullPixels: 4.5e6, maxSupersampledPixels: 9e6 };
  private raf = 0;
  onAfterRender: (() => void) | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.autoClear = false;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.compositeMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tColor: { value: null },
        tSurf: { value: null },
        tNormal: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uPx: { value: 1 },
        uSeed: { value: 0 },
        uInk: { value: new THREE.Vector3() },
        uInk2: { value: new THREE.Vector3() },
        uWidth: { value: 1 },
        uWidthVar: { value: 0 },
        uBreaks: { value: 0 },
        uDouble: { value: 0 },
        uWobble: { value: 0 },
        uCrease: { value: 0 },
        uCreaseAll: { value: 0 },
        uMisreg: { value: new THREE.Vector2() },
        uPooling: { value: 0 },
        uOpacity: { value: 1 },
        uSoft: { value: 0.6 },
        uFreq: { value: 1 },
        uFast: { value: 0 },
        uTransparent: { value: false },
        uDissolve: { value: 0 },
        uDissolveW: { value: 0 },
        tPeelColor: { value: null },
        tPeelSurf: { value: null },
        uTrans: { value: 0 },
        tPeelNormal: { value: null },
        tPeel2Color: { value: null },
        tPeel2Surf: { value: null },
        tPeel2Normal: { value: null },
        uGlass: { value: 0 },
        uRig: { value: new THREE.Vector2(1, 0) },
        uRigCol: { value: new THREE.Vector3(1, 1, 1) },
        uWax: { value: new THREE.Vector2() },
        uWaxLayers: { value: 0 },
        uWaxCore: { value: 0 },
        uWaxFrost: { value: 0 },
        uWaxBehind: { value: 0.82 },
        uWaxSoft: { value: 0 },
        uGlassDensity: { value: 0 },
        uGlassRefr: { value: 0 },
        uGlassThick: { value: 0.8 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.downMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: DOWNSAMPLE_FRAG,
      uniforms: { tSrc: { value: null }, uSrcTexel: { value: new THREE.Vector2() } },
      depthTest: false,
      depthWrite: false,
    });
    const atlas = buildGlyphAtlas();
    const glyphTex = new THREE.DataTexture(atlas.data, atlas.width, atlas.height, THREE.RedFormat, THREE.UnsignedByteType);
    glyphTex.minFilter = glyphTex.magFilter = THREE.LinearFilter;
    glyphTex.needsUpdate = true;
    this.asciiMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: ASCII_FRAG,
      uniforms: {
        tSrc: { value: null }, uSrcTexel: { value: new THREE.Vector2() }, tSurf: { value: null },
        tGlyph: { value: glyphTex }, uGlyphN: { value: atlas.count }, uGlyphRange: { value: GLYPH_RANGE },
        uCell: { value: new THREE.Vector2() }, uPxCell: { value: 0 }, uBlend: { value: new THREE.Vector2() },
        uTransparent: { value: false },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.controls = new TrackballControls(this.camera, canvas);
    this.controls.rotateSpeed = 3.0;
    this.controls.zoomSpeed = 1.0;
    this.controls.panSpeed = 0.6;
    this.controls.staticMoving = true;
    this.controls.addEventListener('start', () => { this.interacting = true; this.lastMove = performance.now(); });
    this.controls.addEventListener('end', () => { this.interacting = false; this.lastMove = performance.now(); });
    this.controls.addEventListener('change', () => { this.lastMove = performance.now(); this.invalidate(); });
    // The browser may drop and restore the WebGL context (GPU reset, tab backgrounded, memory pressure).
    // three.js rebuilds programs and buffers lazily; forget our render targets and draw again.
    canvas.addEventListener('webglcontextrestored', () => {
      this.targetSets.clear();
      this.gbuf = this.comp = this.fastOut = null;
      this.needsRefine = true;
      this.invalidate();
    });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => { this.controls.handleResize(); this.invalidate(); }).observe(canvas);
    }
    // adaptive quality: fast frames while the view changes, one sharp frame once it settles
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.controls.update();
      // never let a degenerate camera (NaN after a zero-length drag, eye on target) stick
      const cs = this.getCameraState();
      if (MolartRenderer.validCamera(cs)) this.lastGoodCamera = cs;
      else if (this.lastGoodCamera) this.setCameraState(this.lastGoodCamera);
      else this.resetCamera();
      const now = performance.now();
      const moving = this.interacting || now - this.lastMove < 180;
      if (this.dirty) {
        this.dirty = false;
        this.renderToCanvas(moving ? 'fast' : 'full');
        this.needsRefine = moving;
      } else if (this.needsRefine && !moving) {
        this.needsRefine = false;
        this.renderToCanvas('full');
      }
    };
    loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.renderer.dispose();
  }

  invalidate() {
    this.dirty = true;
  }

  setStructure(s: Structure) {
    for (const g of this.geomCache.values()) g.dispose();
    this.geomCache.clear();
    this.structure = s;
    this.chainStyles.clear();
    this.chainArt.clear();
    this.frame = principalFrame(s);
    this.resetCamera();
    this.updateMesh();
  }

  setStyle(style: ArtStyle, params?: Partial<RenderParams>) {
    this.style = style;
    if (params) this.params = { ...this.params, ...params };
    this.updateMesh();
  }

  setParams(params: Partial<RenderParams>) {
    this.params = { ...this.params, ...params };
    this.updateMesh();
  }

  /** Frame a subset of chains (or all when empty) along their principal axes. */
  frameChains(chainIds: string[]) {
    if (!this.structure) return;
    this.resetCamera(principalFrame(this.structure, chainIds));
  }

  /** Default camera: look down the third principal axis, longest extent horizontal. */
  resetCamera(frame?: ViewFrame) {
    const f = frame ?? this.frame;
    if (!f) return;
    const [, ay, az] = f.axes;
    // fit inside the central square of the view, so a square export of the same camera is framed the same way
    const aspect = Math.min(1, this.canvasAspect());
    const fovY = THREE.MathUtils.degToRad(this.camera.fov);
    const needY = f.extent[1] * 1.08, needX = f.extent[0] * 1.08;
    const halfY = Math.max(needY, needX / aspect);
    const dist = halfY / Math.tan(fovY / 2) + f.extent[2] * 0.35;
    this.setCameraState({
      position: [f.centre[0] + az[0] * dist, f.centre[1] + az[1] * dist, f.centre[2] + az[2] * dist],
      target: f.centre,
      up: ay,
      fov: this.camera.fov,
    });
  }

  getCameraState(): CameraState {
    const p = this.camera.position, t = this.controls.target, u = this.camera.up;
    const r = (x: number) => Math.round(x * 1e4) / 1e4;
    return { position: [r(p.x), r(p.y), r(p.z)], target: [r(t.x), r(t.y), r(t.z)], up: [r(u.x), r(u.y), r(u.z)], fov: this.camera.fov };
  }

  /** True when a camera state is usable: finite numbers, eye away from target, `up` not along the view axis. */
  static validCamera(c: CameraState | null | undefined): boolean {
    if (!c || !Array.isArray(c.position) || !Array.isArray(c.target) || !Array.isArray(c.up)) return false;
    const nums = [...c.position, ...c.target, ...c.up, c.fov];
    if (nums.length !== 10 || !nums.every((x) => typeof x === 'number' && Number.isFinite(x))) return false;
    const d = new THREE.Vector3(...c.position).sub(new THREE.Vector3(...c.target));
    const len = d.length(), up = new THREE.Vector3(...c.up);
    if (len < 1e-2 || len > 1e5 || up.length() < 1e-6 || c.fov < 1 || c.fov > 170) return false;
    return d.normalize().cross(up.normalize()).length() > 1e-3;
  }

  setCameraState(c: CameraState) {
    if (!MolartRenderer.validCamera(c)) {
      console.warn('molart: ignoring invalid camera state', c);
      this.resetCamera();
      return;
    }
    this.camera.position.set(...c.position);
    this.camera.up.set(...c.up).normalize();
    this.controls.target.set(...c.target);
    this.camera.fov = c.fov;
    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  private canvasAspect() {
    const w = this.canvas.clientWidth || this.canvas.width, h = this.canvas.clientHeight || this.canvas.height;
    return w / Math.max(1, h);
  }

  private geometryFor(style: ArtStyle, art = !!this.params.art): THREE.BufferGeometry {
    const s = this.structure!;
    const artDeform = art && style.art?.deform ? style.art.deform : 0;
    const deform = style.deformable ? Math.round(Math.max(this.params.deform, artDeform) * 100) / 100 : 0;
    const withFaces = !!style.faces && this.params.faces !== false;
    const artOn = art && !!style.art;
    const fit = artOn && style.art!.fit ? Math.max(0.5, Math.min(1, Math.pow(150 / s.residues.length, style.art!.fit))) : 1;
    const ribbon = artOn ? { ...scaleRibbonWidths({ ...style.ribbon, ...style.art!.ribbon }, fit), runs: true, faceDir: this.frame!.axes[2] as [number, number, number], frame: this.frame!.axes } : style.ribbon;
    const key = `${style.mesh}|${withFaces ? 'f' : ''}|${artOn ? 'art' + (style.art!.stretch ?? 1) : ''}|${JSON.stringify(ribbon ?? {})}|${JSON.stringify(style.surface ?? {})}|${deform}|${style.deformable || style.mesh === 'splatter' ? this.params.seed : 0}`;
    let g = this.geomCache.get(key);
    if (g) {
      this.geomCache.delete(key);   // mark as most recently used
      this.geomCache.set(key, g);
    }
    if (!g) {
      let m: MeshData & { facet?: Float32Array; face?: Float32Array } = style.mesh === 'surface' ? buildSurface(s, style.surface) : buildRibbon(s, ribbon);
      if (style.faces && !withFaces) {
        // no characters, but the shader still needs each element's kind and colour pick
        m.face = faceAnchors(m, s, this.frame!.axes[2], this.frame!.axes[1], new Map(), []).attr;
      }
      if (style.faces && withFaces) {
        // pick a spot for each face on the plain ribbon, swell the ribbon into a head there, then anchor the face on it
        const vd = this.frame!.axes[2], vu = this.frame!.axes[1];
        const first = faceAnchors(m, s, vd, vu);
        const fw = style.faces;
        const arms = fw.arms ? first.arms : [];
        const fist = fw.fist ?? 3.4;
        m = buildRibbon(s, {
          ...ribbon,
          bulges: [
            ...first.sites.map((f) => ({ t: f.t, widen: f.helix ? fw.helixHead : fw.strandHead, span: fw.span })),
            // arms: the whole loop thins to a round hose, then swells into a fist at its middle
            ...arms.map((a) => ({ t: a.mid, span: (a.last - a.first) / 2 + 0.75, flat: true, to: { w: 1.05, h: 1.05, p: 2 } })),
            ...arms.map((a) => ({ t: a.mid, span: 1.1, to: { w: fist, h: fist * 0.9, p: 2.3 } })),
          ],
        });
        m.face = faceAnchors(m, s, vd, vu, new Map(first.sites.map((f) => [f.element, f.t])), arms, fist / 2).attr;
      }
      if (artOn && style.art!.stretch && style.art!.stretch !== 1) {
        // elongate the drawn form (display mesh only): it keeps its height and is drawn in towards the protein's
        // up axis, so it gets taller in proportion without leaving the frame
        const up = this.frame!.axes[1], c0 = this.frame!.centre, st = style.art!.stretch;
        const P = new Float32Array(m.positions), C = new Float32Array(m.centers), N = new Float32Array(m.normals);
        for (let i = 0; i < m.vertexCount; i++) {
          for (const A of [P, C]) {
            const rx = A[3 * i] - c0[0], ry = A[3 * i + 1] - c0[1], rz = A[3 * i + 2] - c0[2];
            const d = rx * up[0] + ry * up[1] + rz * up[2];
            A[3 * i] = c0[0] + d * up[0] + (rx - d * up[0]) / st;
            A[3 * i + 1] = c0[1] + d * up[1] + (ry - d * up[1]) / st;
            A[3 * i + 2] = c0[2] + d * up[2] + (rz - d * up[2]) / st;
          }
          const dn = N[3 * i] * up[0] + N[3 * i + 1] * up[1] + N[3 * i + 2] * up[2];
          const nx = st * N[3 * i] - (st - 1) * dn * up[0], ny = st * N[3 * i + 1] - (st - 1) * dn * up[1], nz = st * N[3 * i + 2] - (st - 1) * dn * up[2];
          const nl = Math.hypot(nx, ny, nz) || 1;
          N[3 * i] = nx / nl; N[3 * i + 1] = ny / nl; N[3 * i + 2] = nz / nl;
        }
        m = { ...m, positions: P, centers: C, normals: N };
      }
      if (style.mesh === 'faceted' && style.deformable && deform > 0) m = cubistMesh(m, { amount: deform, seed: this.params.seed });
      if (style.mesh === 'faceted') m = flatten(m);
      if (style.mesh === 'splatter') m = splatterMesh(m, { ...(style.splatter ?? {}), seed: this.params.seed });
      if (style.mesh === 'melted' && deform > 0) {
        const up = this.frame!.axes[1];
        m = meltMesh(m, { amount: deform, gravity: [-up[0], -up[1], -up[2]], seed: this.params.seed });
      }
      g = toGeometry(m);
      this.geomCache.set(key, g);
      this.trimGeometryCache(g);
    }
    return g;
  }

  /** Bytes held by one cached geometry (its typed arrays; the GPU holds a copy of the same size). */
  private static geometryBytes(g: THREE.BufferGeometry) {
    let n = g.index ? g.index.array.byteLength : 0;
    for (const a of Object.values(g.attributes)) n += (a as THREE.BufferAttribute).array.byteLength;
    return n;
  }
  /** Total bytes of the cached geometries (for tests and diagnostics). */
  geometryCacheBytes() {
    let n = 0;
    for (const g of this.geomCache.values()) n += MolartRenderer.geometryBytes(g);
    return n;
  }
  /**
   * Keep the geometry cache small: every style and mode has its own mesh (tens of MB each on a large protein), so
   * an unbounded cache exhausts memory when one clicks through all of them. Least recently used meshes that are
   * not on screen are freed; they are rebuilt on demand.
   */
  private trimGeometryCache(keep: THREE.BufferGeometry) {
    const BUDGET = 192 * 1024 * 1024, MAX = 6;
    const inUse = new Set<THREE.BufferGeometry>([keep, ...this.layers.map((l) => l.mesh.geometry)]);
    let total = this.geometryCacheBytes();
    for (const [k, g] of [...this.geomCache]) {
      if (total <= BUDGET && this.geomCache.size <= MAX) break;
      if (inUse.has(g)) continue;
      total -= MolartRenderer.geometryBytes(g);
      g.dispose();
      this.geomCache.delete(k);
    }
  }

  private blended: THREE.BufferGeometry[] = [];
  /**
   * The art-form mesh blended towards the true ribbon (display only). Every vertex of the art mesh knows where it
   * sits on the chain (residue position t, angle around the profile), so its starting point is looked up on the
   * true ribbon at the same place; the two meshes need not have the same layout.
   */
  private blendFor(style: ArtStyle, t: number): THREE.BufferGeometry | null {
    const a = this.geometryFor(style, false), b = this.geometryFor(style, true);
    const sa = a.getAttribute('aSurf')?.array as Float32Array | undefined, ia = a.getAttribute('aInfo')?.array as Float32Array | undefined;
    if (!sa || !ia || style.mesh === 'surface') return null;
    // rings of the true ribbon: chain -> sorted positions along the chain -> vertices sorted by angle
    const rings = new Map<number, Map<number, number[]>>();
    const na = a.getAttribute('position').count;
    for (let i = 0; i < na; i++) {
      if (sa[4 * i + 3] > 2.5) continue;   // marks around the ribbon (splatter) are not part of it
      const c = ia[4 * i], k = Math.round(sa[4 * i] * 1000);
      let m = rings.get(c);
      if (!m) rings.set(c, (m = new Map()));
      const r = m.get(k);
      if (r) r.push(i);
      else m.set(k, [i]);
    }
    const keys = new Map<number, number[]>();
    for (const [c, m] of rings) {
      keys.set(c, [...m.keys()].sort((x, y) => x - y));
      for (const r of m.values()) r.sort((x, y) => sa[4 * x + 1] - sa[4 * y + 1]);
    }
    const g = b.clone();
    const sb = g.getAttribute('aSurf').array as Float32Array, ib = g.getAttribute('aInfo').array as Float32Array;
    const names = ['position', 'normal', 'aTangent'];
    const src = names.map((n) => a.getAttribute(n).array as Float32Array), dst = names.map((n) => g.getAttribute(n).array as Float32Array);
    const tmp = [new Float32Array(3), new Float32Array(3)];
    // value of attribute q on ring r at angle u (0..1, cyclic), written to out
    const sample = (r: number[], u: number, q: Float32Array, out: Float32Array) => {
      let hi = r.findIndex((v) => sa[4 * v + 1] > u);
      const i1 = hi < 0 ? r[0] : r[hi], i0 = hi <= 0 ? r[r.length - 1] : r[hi - 1];
      let u0 = sa[4 * i0 + 1], u1 = sa[4 * i1 + 1];
      if (hi <= 0) { if (hi < 0) u1 += 1; else u0 -= 1; }
      const f = u1 > u0 ? Math.min(1, Math.max(0, (u - u0) / (u1 - u0))) : 0;
      for (let d = 0; d < 3; d++) out[d] = q[3 * i0 + d] + (q[3 * i1 + d] - q[3 * i0 + d]) * f;
    };
    const nb = g.getAttribute('position').count;
    for (let i = 0; i < nb; i++) {
      const ks = keys.get(ib[4 * i]), m = rings.get(ib[4 * i]);
      if (!ks || !m || !ks.length) continue;
      const k = sb[4 * i] * 1000, u = sb[4 * i + 1] - Math.floor(sb[4 * i + 1]);
      let lo = 0, hi = ks.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ks[mid] <= k) lo = mid; else hi = mid; }
      const f = ks[hi] > ks[lo] ? Math.min(1, Math.max(0, (k - ks[lo]) / (ks[hi] - ks[lo]))) : 0;
      const marks = sb[4 * i + 3] > 2.5;   // splatter marks start on the ribbon and fly out
      for (let q = 0; q < names.length; q++) {
        if (marks && q > 0) continue;
        sample(m.get(ks[lo])!, u, src[q], tmp[0]);
        sample(m.get(ks[hi])!, u, src[q], tmp[1]);
        for (let d = 0; d < 3; d++) {
          const from = tmp[0][d] + (tmp[1][d] - tmp[0][d]) * f;
          dst[q][3 * i + d] = from + (dst[q][3 * i + d] - from) * t;
        }
      }
    }
    this.blended.push(g);
    return g;
  }

  private materialFor(style: ArtStyle, variant = ''): THREE.RawShaderMaterial {
    // one material per layer: the same style can be on screen twice (one chain in science mode, one in art mode)
    let m = this.matCache.get(style.id + variant);
    if (!m) {
      m = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: GBUFFER_VERT,
        fragmentShader: gbufferFrag(style.surfaceGLSL),
        uniforms: { tChainGroup: { value: this.chainTex }, uGroup: { value: -1 }, uSeed: { value: 0 }, uColA: { value: new THREE.Vector3(1, 1, 1) }, uColB: { value: new THREE.Vector3(1, 1, 1) }, uObjKey: { value: new THREE.Vector3(0, 1, 0) }, uKey: { value: new THREE.Vector3(-0.42, 0.62, 0.66) }, uSun: { value: new THREE.Vector3(1, 1, 1) }, uSunAmt: { value: style.glass ? 0.3 : 1 }, ...this.sunU, uFrameX: { value: new THREE.Vector3(1, 0, 0) }, uFrameY: { value: new THREE.Vector3(0, 1, 0) }, uFrameC: { value: new THREE.Vector3() } },
        side: THREE.DoubleSide,
      });
      this.matCache.set(style.id + variant, m);
    }
    return m;
  }

  private peelMaterialFor(style: ArtStyle, front: THREE.RawShaderMaterial): THREE.RawShaderMaterial {
    let m = this.peelCache.get(style.id);
    if (!m) {
      m = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: GBUFFER_VERT,
        fragmentShader: gbufferFrag(style.surfaceGLSL, true),
        uniforms: { tChainGroup: { value: this.chainTex }, uGroup: { value: -1 }, uSeed: { value: 0 }, uColA: { value: new THREE.Vector3(1, 1, 1) }, uColB: { value: new THREE.Vector3(1, 1, 1) }, uObjKey: { value: new THREE.Vector3() }, uKey: { value: new THREE.Vector3(-0.42, 0.62, 0.66) }, uSun: { value: new THREE.Vector3(1, 1, 1) }, uSunAmt: { value: style.glass ? 0.3 : 1 }, ...this.sunU, uFrameX: { value: new THREE.Vector3() }, uFrameY: { value: new THREE.Vector3() }, uFrameC: { value: new THREE.Vector3() }, tPrev: { value: null }, uRes: { value: new THREE.Vector2() } },
        side: THREE.DoubleSide,
      });
      this.peelCache.set(style.id, m);
    }
    m.uniforms.uSeed.value = front.uniforms.uSeed.value;
    m.uniforms.uGroup.value = front.uniforms.uGroup.value;
    m.uniforms.uColA.value.copy(front.uniforms.uColA.value);
    m.uniforms.uColB.value.copy(front.uniforms.uColB.value);
    m.uniforms.uObjKey.value.copy(front.uniforms.uObjKey.value);
    m.uniforms.uKey.value.copy(front.uniforms.uKey.value);
    m.uniforms.uSun.value.copy(front.uniforms.uSun.value);
    for (const k of ['uFrameX', 'uFrameY', 'uFrameC']) m.uniforms[k].value.copy(front.uniforms[k].value);
    return m;
  }

  /** The two selectable colours in effect (user override or the default of the glass style in use). */
  styleColors(): [[number, number, number], [number, number, number]] | null {
    const def = this.groups().find((g) => g.style.glass)?.style.glass?.colors;
    if (!def) return null;
    return this.params.colors ?? def;
  }

  /**
   * Give chains their own styles (chain id → style); null or an empty map returns every chain to the main style.
   * Only the drawing changes: every chain keeps its coordinates and its place in the one shared scene.
   */
  setChainStyles(assign: Record<string, ArtStyle> | null) {
    this.chainStyles.clear();
    if (assign && this.structure) for (const c of this.structure.chains) if (assign[c.id]) this.chainStyles.set(c.index, assign[c.id]);
    this.updateMesh();
  }

  /**
   * Give chains their own mode (chain id → art mode on/off); null returns every chain to the main mode.
   * Display only, like art mode itself.
   */
  setChainArt(assign: Record<string, boolean> | null) {
    this.chainArt.clear();
    if (assign && this.structure) for (const c of this.structure.chains) if (typeof assign[c.id] === 'boolean') this.chainArt.set(c.index, assign[c.id]);
    this.updateMesh();
  }

  /** Chain ids that currently carry their own style. */
  getChainStyles(): Record<string, string> {
    const out: Record<string, string> = {};
    if (this.structure) for (const c of this.structure.chains) { const st = this.chainStyles.get(c.index); if (st) out[c.id] = st.id; }
    return out;
  }

  /** Distinct styles in use and the chains each one draws; the main style comes first when it is used. */
  private groups(): { style: ArtStyle; art: boolean; chains: number[] }[] {
    if (!this.structure || !this.style) return [];
    const main = !!this.params.art;
    const by = new Map<string, { style: ArtStyle; art: boolean; chains: number[] }>();
    for (const c of this.structure.chains) {
      const st = this.chainStyles.get(c.index) ?? this.style;
      const art = (this.chainArt.get(c.index) ?? main) && !!st.art;   // a style without an art form draws the same in both modes
      const key = `${st.id}|${art}`;
      if (!by.has(key)) by.set(key, { style: st, art, chains: [] });
      by.get(key)!.chains.push(c.index);
    }
    const out = [...by.values()];
    out.sort((x, y) => Number(y.style === this.style) - Number(x.style === this.style));
    return out.length ? out : [{ style: this.style, art: main && !!this.style.art, chains: [] }];
  }

  private updateMesh() {
    if (!this.structure || !this.style) return;
    for (const l of this.layers) { this.scene.remove(l.mesh); l.depth.dispose(); }
    this.layers = [];
    for (const g of this.blended) g.dispose();
    this.blended = [];
    const blend = this.params.artBlend;
    const groups = this.groups();
    const multi = groups.length > 1;
    const tex = this.chainTex.image.data as Uint8Array;
    tex.fill(255);
    const cols = this.styleColors();
    // key light expressed in model space at the default view: "painted-on" lighting for styles that want it
    const [ax, ay, az] = this.frame!.axes;
    // the key light may be turned about the viewing direction and given a colour (display only)
    const la = ((this.params.light?.angle ?? 0) * Math.PI) / 180, lc = Math.cos(la), ls = Math.sin(la);
    // with the sun on the light stands lower, so that shadows fall across the picture
    const kz = this.params.light ? 0.3 : 0.66;
    const k = [-0.42 * lc - 0.62 * ls, -0.42 * ls + 0.62 * lc, kz];
    this.sunDir.set(k[0], k[1], k[2]).normalize();
    const sun = (this.params.light?.color ?? [1, 1, 1]).map((v) => Math.pow(v, 2.2));
    groups.forEach((g, gi) => {
      for (const c of g.chains) if (c < tex.length) tex[c] = gi;
      const geom = (g.art && blend !== undefined && blend < 1 ? this.blendFor(g.style, Math.max(0, blend)) : null) ?? this.geometryFor(g.style, g.art);
      const mat = this.materialFor(g.style, groups.some((o) => o !== g && o.style === g.style) && g.art ? '|art' : '');
      mat.uniforms.uGroup.value = multi ? gi : -1;
      mat.uniforms.uSeed.value = seedFor(this.structure!.id, this.params.seed);
      if (cols && g.style.glass) {
        mat.uniforms.uColA.value.set(...cols[0]);
        mat.uniforms.uColB.value.set(...cols[1]);
      }
      mat.uniforms.uObjKey.value.set(ax[0] * k[0] + ay[0] * k[1] + az[0] * k[2], ax[1] * k[0] + ay[1] * k[1] + az[1] * k[2], ax[2] * k[0] + ay[2] * k[1] + az[2] * k[2]);
      mat.uniforms.uKey.value.set(k[0], k[1], k[2]);
      mat.uniforms.uSun.value.set(sun[0], sun[1], sun[2]);
      mat.uniforms.uFrameX.value.set(ax[0], ax[1], ax[2]);
      mat.uniforms.uFrameY.value.set(ay[0], ay[1], ay[2]);
      mat.uniforms.uFrameC.value.set(...this.frame!.centre);
      // occluder twin: lets this layer hide what lies behind it while another layer is being drawn
      const depth = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: GBUFFER_VERT,
        fragmentShader: DEPTH_FRAG,
        uniforms: { tChainGroup: { value: this.chainTex }, uGroup: { value: gi } },
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.layers.push({ style: g.style, chains: g.chains, mesh, front: mat, depth });
    });
    this.chainTex.needsUpdate = true;
    this.invalidate();
  }

  /**
   * Render targets are cached per size (interactive fast size, interactive sharp size, exports), so switching
   * between fast and sharp frames never reallocates GPU buffers.
   */
  private targetSets = new Map<string, { gbuf: THREE.WebGLRenderTarget; comp: THREE.WebGLRenderTarget; peel: THREE.WebGLRenderTarget | null; peel2?: THREE.WebGLRenderTarget | null; accum?: THREE.WebGLRenderTarget | null }>();
  private ensureTargets(w: number, h: number) {
    const key = `${w}x${h}`;
    let set = this.targetSets.get(key);
    if (!set) {
      const gbuf = new THREE.WebGLRenderTarget(w, h, { count: 3, type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
      gbuf.textures[0].type = THREE.HalfFloatType;
      gbuf.textures[0].minFilter = THREE.LinearFilter;
      gbuf.textures[0].magFilter = THREE.LinearFilter;
      gbuf.textures[2].type = THREE.HalfFloatType;
      const comp = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
      set = { gbuf, comp, peel: null };
      this.targetSets.set(key, set);
      // keep at most three sizes alive (fast, sharp, last export)
      for (const [k, v] of this.targetSets) {
        if (this.targetSets.size <= 3) break;
        if (k === key) continue;
        v.gbuf.dispose(); v.comp.dispose(); v.peel?.dispose(); v.peel2?.dispose(); v.accum?.dispose();
        this.targetSets.delete(k);
      }
    } else {
      this.targetSets.delete(key);   // mark as most recently used
      this.targetSets.set(key, set);
    }
    this.gbuf = set.gbuf;
    this.comp = set.comp;
    return set;
  }

  private releaseTargets(w: number, h: number) {
    const key = `${w}x${h}`, set = this.targetSets.get(key);
    if (!set) return;
    set.gbuf.dispose(); set.comp.dispose(); set.peel?.dispose(); set.peel2?.dispose(); set.accum?.dispose();
    this.targetSets.delete(key);
    this.gbuf = this.comp = null;
  }

  /** Full pipeline at (w,h) output pixels with supersampling factor ss; result into `target` (null = canvas). */
  private renderPipeline(w: number, h: number, ss: number, target: THREE.WebGLRenderTarget | null, aspectFit?: number, transparent = false) {
    if (!this.style || !this.layers.length) return;
    const gw = w * ss, gh = h * ss;
    const set = this.ensureTargets(gw, gh);
    const cam = this.camera;
    const savedFov = cam.fov, savedAspect = cam.aspect;
    cam.aspect = w / h;
    // Keep horizontal coverage when the output is narrower than the interactive view.
    if (aspectFit && cam.aspect < aspectFit) {
      const t = Math.tan(THREE.MathUtils.degToRad(savedFov) / 2) * (aspectFit / cam.aspect);
      cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(t));
    }
    cam.updateProjectionMatrix();
    const r = this.renderer;
    const multi = this.layers.length > 1;
    this.compositeMat.uniforms.uTransparent.value = transparent;
    this.asciiMat.uniforms.uTransparent.value = transparent;
    const mul = (m: THREE.RawShaderMaterial, on: boolean) => {
      // Multiply the white-matted colours and the fractions of background transmitted by the layers.
      m.blending = on ? THREE.CustomBlending : THREE.NormalBlending;
      m.blendSrc = on ? THREE.DstColorFactor : THREE.SrcAlphaFactor;
      m.blendDst = on ? THREE.ZeroFactor : THREE.OneMinusSrcAlphaFactor;
      m.blendSrcAlpha = on ? THREE.DstAlphaFactor : null;
    };
    if (multi) {
      if (!set.accum) set.accum = new THREE.WebGLRenderTarget(gw, gh, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
      r.setRenderTarget(set.accum);
      r.setClearColor(0xffffff, 1);
      r.clear(true, false, false);
    }
    // sun: a depth picture of the whole protein from the light, read by every surface shader for cast shadows
    this.sunU.uShadowOn.value = 0;
    if (this.params.light) {
      if (!this.sunTarget) {
        this.sunTarget = new THREE.WebGLRenderTarget(2048, 2048, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
        this.sunTarget.depthTexture = new THREE.DepthTexture(2048, 2048, THREE.UnsignedIntType);
      }
      const centre = new THREE.Vector3(...this.frame!.centre);
      let radius = 1;
      for (const l of this.layers) {
        const g = l.mesh.geometry;
        if (!g.boundingSphere) g.computeBoundingSphere();
        radius = Math.max(radius, g.boundingSphere!.center.distanceTo(centre) + g.boundingSphere!.radius);
      }
      cam.updateMatrixWorld();
      const dir = this.sunDir.clone().transformDirection(cam.matrixWorld);
      const sc = this.sunCam;
      sc.left = sc.bottom = -radius; sc.right = sc.top = radius; sc.near = 0.1; sc.far = 4 * radius;
      sc.position.copy(centre).addScaledVector(dir, 2 * radius);
      sc.up.copy(cam.up);
      sc.lookAt(centre);
      sc.updateProjectionMatrix(); sc.updateMatrixWorld();
      this.layers.forEach((l) => { l.mesh.visible = true; l.mesh.material = l.depth; });
      r.setRenderTarget(this.sunTarget);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, true);
      r.render(this.scene, sc);
      this.sunU.tShadow.value = this.sunTarget.depthTexture;
      this.sunU.uShadowMat.value.multiplyMatrices(sc.projectionMatrix, sc.matrixWorldInverse);
      this.sunU.uShadowOn.value = 1;
    }
    // a layer hides what is behind it unless it is see-through
    const occludes = (st: ArtStyle) => !st.glass && !(st.translucency && st.translucency > 0);
    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li], style = layer.style;
      const show = (own: THREE.RawShaderMaterial) => {
        this.layers.forEach((l, k) => {
          l.mesh.visible = k === li || occludes(l.style);
          l.mesh.material = k === li ? own : l.depth;
        });
      };
      show(layer.front);
      r.setRenderTarget(this.gbuf);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, true);
      r.render(this.scene, cam);
      const trans = style.translucency ?? 0;
      const glass = style.glass;
      const wax = style.wax;
      const peels = glass || wax ? 2 : trans > 0 ? 1 : 0;
      if (peels > 0) {
        const mk = () => {
          const t = new THREE.WebGLRenderTarget(gw, gh, { count: 3, type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
          t.textures[1].type = THREE.FloatType;
          return t;
        };
        if (!set.peel) set.peel = mk();
        if (peels > 1 && !set.peel2) set.peel2 = mk();
        const pm = this.peelMaterialFor(style, layer.front);
        pm.uniforms.uRes.value.set(gw, gh);
        show(pm);
        // each peel keeps the nearest surface behind the previous layer
        pm.uniforms.tPrev.value = this.gbuf!.textures[1];
        r.setRenderTarget(set.peel);
        r.clear(true, true, true);
        r.render(this.scene, cam);
        if (peels > 1) {
          pm.uniforms.tPrev.value = set.peel.textures[1];
          r.setRenderTarget(set.peel2!);
          r.clear(true, true, true);
          r.render(this.scene, cam);
        }
      }

      const ink = { ...style.ink, ...(style === this.style ? this.inkOverride : {}) };
      if (glass && this.params.colors) {
        // outline follows the chosen glass colours: a deep version of each
        const deep = (c: number[], k: number): [number, number, number] => {
          const m = Math.min(c[0], c[1], c[2]) * 0.6;   // push saturation, then darken
          return [(c[0] - m) * k, (c[1] - m) * k, (c[2] - m) * k];
        };
        ink.color = deep(this.params.colors[0], 0.5);
        ink.color2 = deep(this.params.colors[1], 0.5);
      }
      const u = this.compositeMat.uniforms;
      u.tColor.value = this.gbuf!.textures[0];
      u.tSurf.value = this.gbuf!.textures[1];
      u.tNormal.value = this.gbuf!.textures[2];
      u.uTrans.value = trans;
      u.tPeelColor.value = peels > 0 ? set.peel!.textures[0] : this.dummyTex;
      u.tPeelSurf.value = peels > 0 ? set.peel!.textures[1] : this.dummyTex;
      u.tPeelNormal.value = peels > 0 ? set.peel!.textures[2] : this.dummyTex;
      u.tPeel2Color.value = peels > 1 ? set.peel2!.textures[0] : this.dummyTex;
      u.tPeel2Surf.value = peels > 1 ? set.peel2!.textures[1] : this.dummyTex;
      u.tPeel2Normal.value = peels > 1 ? set.peel2!.textures[2] : this.dummyTex;
      u.uWax.value.set(wax?.density ?? 0, wax?.clear ?? 0);
      u.uWaxLayers.value = wax?.layers ?? 0;
      u.uWaxCore.value = wax?.core ? 1 : 0;
      u.uWaxFrost.value = wax?.frost ?? 0;
      u.uWaxBehind.value = wax?.behind ?? 0.82;
      u.uWaxSoft.value = wax?.soft ?? 0;
      u.uGlass.value = glass ? 1 : 0;
      const rigA = ((this.params.light?.angle ?? 0) * Math.PI) / 180, rigC = this.params.light?.color ?? [1, 1, 1];
      u.uRig.value.set(Math.cos(rigA), Math.sin(rigA));
      u.uRigCol.value.set(Math.pow(rigC[0], 2.2), Math.pow(rigC[1], 2.2), Math.pow(rigC[2], 2.2));
      u.uGlassDensity.value = glass?.density ?? 0;
      u.uGlassRefr.value = glass?.refraction ?? 0;
      u.uGlassThick.value = style.ribbon?.strandThickness ?? 0.8;
      u.uTexel.value.set(1 / gw, 1 / gh);
      u.uPx.value = gh / 1000;
      u.uSeed.value = seedFor(this.structure!.id, this.params.seed);
      u.uInk.value.set(...ink.color);
      u.uInk2.value.set(...ink.color2);
      u.uWidth.value = ink.width;
      u.uWidthVar.value = ink.widthVar;
      u.uBreaks.value = ink.breaks;
      u.uDouble.value = ink.double;
      u.uWobble.value = ink.wobble;
      u.uCrease.value = ink.crease;
      u.uCreaseAll.value = ink.creaseAll ? 1 : 0;
      u.uMisreg.value.set(...ink.misregister);
      u.uPooling.value = ink.pooling;
      u.uOpacity.value = ink.opacity;
      u.uSoft.value = ink.softness;
      u.uFreq.value = ink.frequency;
      u.uDissolve.value = ink.dissolve ?? 0;
      u.uDissolveW.value = ink.dissolveWidth ?? 0;
      const ascii = style.ascii;
      this.quad.material = this.compositeMat;
      r.setRenderTarget(ss > 1 || ascii || multi ? this.comp : target);
      r.render(this.quadScene, this.quadCam);
      // With several layers each finished picture is multiplied onto a shared sheet (at the working
      // resolution) and the sheet is filtered down once at the end; a single layer goes straight out.
      const dest = multi ? set.accum! : target;
      if (ascii) {
        // text grid over the finished picture; cell size follows the output height so exports match the view
        const a = this.asciiMat.uniforms;
        const direct = multi || ss === 1;
        a.tSrc.value = this.comp!.texture;
        a.uSrcTexel.value.set(direct ? 0 : 1 / gw, direct ? 0 : 1 / gh);
        a.tSurf.value = this.gbuf!.textures[1];
        a.uCell.value.set((GLYPH_ASPECT * h) / (ascii.rows * w), 1 / ascii.rows);
        a.uPxCell.value = ascii.rows / (multi ? gh : h);
        const amt = this.params.ascii;
        if (typeof amt === 'number' && Number.isFinite(amt)) {
          // the hand-over band (0.55 of the width) slides across the picture: 0 = nothing is text, 1 = everything
          // the band is measured across the protein as it appears in the picture, not across the whole image
          let x0 = 1, x1 = 0;
          const st = this.structure!, v = new THREE.Vector3();
          for (const res of st.residues) {
            if (res.ca < 0) continue;
            v.set(st.coords[3 * res.ca], st.coords[3 * res.ca + 1], st.coords[3 * res.ca + 2]);
            const x = v.project(cam).x * 0.5 + 0.5;
            x0 = Math.min(x0, x); x1 = Math.max(x1, x);
          }
          x0 = Math.max(0, x0); x1 = Math.min(1, x1);
          if (!(x1 > x0)) { x0 = 0; x1 = 1; }
          const from = -0.55 + Math.min(1, Math.max(0, amt)) * 1.55;
          a.uBlend.value.set(x0 + from * (x1 - x0), x0 + (from + 0.55) * (x1 - x0));
        } else a.uBlend.value.set(...ascii.blend);
        mul(this.asciiMat, multi);
        this.quad.material = this.asciiMat;
        r.setRenderTarget(dest);
        r.render(this.quadScene, this.quadCam);
      } else if (multi) {
        this.downMat.uniforms.tSrc.value = this.comp!.texture;
        this.downMat.uniforms.uSrcTexel.value.set(0, 0);
        mul(this.downMat, true);
        this.quad.material = this.downMat;
        r.setRenderTarget(dest);
        r.render(this.quadScene, this.quadCam);
        mul(this.downMat, false);
      } else if (ss > 1) {
        this.downMat.uniforms.tSrc.value = this.comp!.texture;
        this.downMat.uniforms.uSrcTexel.value.set(1 / gw, 1 / gh);
        this.quad.material = this.downMat;
        r.setRenderTarget(target);
        r.render(this.quadScene, this.quadCam);
      }
    }
    if (multi) {
      this.downMat.uniforms.tSrc.value = set.accum!.texture;
      this.downMat.uniforms.uSrcTexel.value.set(ss > 1 ? 1 / gw : 0, ss > 1 ? 1 / gh : 0);
      this.quad.material = this.downMat;
      r.setRenderTarget(target);
      r.render(this.quadScene, this.quadCam);
    }
    for (const l of this.layers) { l.mesh.visible = true; l.mesh.material = l.front; }
    cam.fov = savedFov;
    cam.aspect = savedAspect;
    cam.updateProjectionMatrix();
    r.setRenderTarget(null);
  }

  renderToCanvas(mode: 'fast' | 'full' = 'full') {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, this.canvas.clientWidth), ch = Math.max(1, this.canvas.clientHeight);
    // The canvas keeps one backing size (capped by a pixel budget); it is never resized between fast and
    // sharp frames — fast frames render smaller offscreen and are scaled up onto it.
    const scale = Math.min(dpr, Math.sqrt(this.quality.fullPixels / (cw * ch)));
    const w = Math.max(1, Math.round(cw * scale));
    const h = Math.max(1, Math.round(ch * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.controls.handleResize();
    }
    const fs = Math.min(1, Math.sqrt(this.quality.fastPixels / (w * h)));
    if (mode === 'fast' && fs < 0.95) {
      const fw = Math.max(1, Math.round(w * fs)), fh = Math.max(1, Math.round(h * fs));
      if (!this.fastOut || this.fastOut.width !== fw || this.fastOut.height !== fh) {
        this.fastOut?.dispose();
        this.fastOut = new THREE.WebGLRenderTarget(fw, fh, { type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
      }
      this.compositeMat.uniforms.uFast.value = 1;
      this.renderPipeline(fw, fh, 1, this.fastOut);
      this.compositeMat.uniforms.uFast.value = 0;
      // bilinear upscale onto the canvas
      this.downMat.uniforms.tSrc.value = this.fastOut.texture;
      this.downMat.uniforms.uSrcTexel.value.set(0, 0);
      this.quad.material = this.downMat;
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.quadScene, this.quadCam);
    } else {
      const ss = mode === 'fast' || w * h * 4 > this.quality.maxSupersampledPixels ? 1 : 2;
      this.compositeMat.uniforms.uFast.value = mode === 'fast' ? 1 : 0;
      this.renderPipeline(w, h, ss, null);
      this.compositeMat.uniforms.uFast.value = 0;
    }
    this.onAfterRender?.();
  }

  /** Average milliseconds per interactive frame (GPU-synchronised), for diagnostics. */
  benchmark(frames = 20, mode: 'fast' | 'full' = 'fast'): number {
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    this.renderToCanvas(mode);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      this.camera.position.applyAxisAngle(this.camera.up, 0.01);
      this.camera.lookAt(this.controls.target);
      this.renderToCanvas(mode);
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return (performance.now() - t0) / frames;
  }

  /** Render offscreen at an exact pixel size and return straight RGBA pixels (top row first). */
  renderPixels(width: number, height: number, transparent = false): Uint8ClampedArray {
    const max = this.renderer.capabilities.maxTextureSize;
    if (width > max || height > max) throw new Error(`Requested ${width}×${height} exceeds GPU texture limit ${max}.`);
    const ss = width * 2 <= max && height * 2 <= max && width * height <= 4.2e6 ? 2 : 1;
    const out = new THREE.WebGLRenderTarget(width, height, { type: THREE.UnsignedByteType, depthBuffer: false });
    // an export shows the central square of a wide window (where the default view frames the protein), not its empty sides
    const aspect = Math.min(1, this.canvasAspect());
    this.renderPipeline(width, height, ss, out, aspect, transparent);
    const buf = new Uint8Array(width * height * 4);
    this.renderer.readRenderTargetPixels(out, 0, 0, width, height, buf);
    out.dispose();
    // flip vertically
    const px = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const src = (height - 1 - y) * width * 4;
      px.set(buf.subarray(src, src + width * 4), y * width * 4);
    }
    if (transparent) {
      // The RGB on white is the premultiplied foreground plus the transmitted white.
      for (let i = 0; i < px.length; i += 4) {
        const transmitted = px[i + 3];
        const alpha = 255 - transmitted;
        const scale = alpha ? 255 / alpha : 0;
        px[i] = (px[i] - transmitted) * scale;
        px[i + 1] = (px[i + 1] - transmitted) * scale;
        px[i + 2] = (px[i + 2] - transmitted) * scale;
        px[i + 3] = alpha;
      }
    } else {
      for (let i = 3; i < px.length; i += 4) px[i] = 255;
    }
    // release large supersampled buffers after big exports
    if (width * height > 4.2e6) this.releaseTargets(width * ss, height * ss);
    this.invalidate();
    return px;
  }

  async exportPNG(width: number, height: number, transparent = false): Promise<Blob> {
    const px = this.renderPixels(width, height, transparent);
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d', { alpha: transparent })!;
    ctx.putImageData(new ImageData(px as unknown as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
  }
}
