import './ui/style.css';
import { App } from './ui/app';
import { allStyles, getStyle } from './art/registry';
import { coordinateFingerprint } from './model/structure';
import type { CameraState } from './renderer/renderer';
import { RENDERER_VERSION } from './renderer/renderer';

const app = new App(document.getElementById('app')!);

const blobToBase64 = async (b: Blob) => {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Automation API (used by the CLI and browser tests). */
const api = {
  version: RENDERER_VERSION,
  styles: () => allStyles().map((s) => ({ id: s.id, label: s.label, deformable: !!s.deformable, technique: s.technique })),
  loadText: async (text: string, name: string) => {
    await app.loadText(text, name);
    return api.info();
  },
  setStyle: (id: string) => app.setStyle(getStyle(id).id),
  setSeed: (seed: number) => app.setSeed(seed),
  setLight: (angle: number | null, color?: string) => app.setLight(angle, color),
  /** Sun with up to four lights: each {x, y, color} stands at (x, y) on the unit disc seen from the camera (x right, y up); null = off. */
  setLights: (lights: { x: number; y: number; color: string }[] | null) => app.setLights(lights),
  // scripted use: one explicit amount for every deformable style (the UI keeps one slider per style)
  setDeform: (v: number) => app.setDeform(v, true),
  /** Two sRGB hex colours for styles with a colour choice (Glass); null restores the defaults. */
  setColors: (a: string | null, b?: string) => app.setColors(a, b),
  /** Per-chain styles: { chainId: styleId | null }; null clears all. Chains not listed keep the main style. */
  setChainStyles: (m: Record<string, string | null> | null) => app.setChainStyles(m),
  getChainStyles: () => app.r.getChainStyles(),
  /** Cartoon: faces, heads and arms on or off. */
  setFaces: (on: boolean) => app.setFaces(on),
  setArtMode: (on: boolean) => app.setArtMode(on),
  /** Art mode part way, 0..1 (styles whose art form keeps the mesh layout, e.g. Glass); null = fully on. */
  setArtBlend: (t: number | null) => app.r.setParams({ artBlend: t ?? undefined }),
  setChainArt: (assign: Record<string, boolean | null> | null) => app.setChainArt(assign),
  /** ASCII Fold: share of the picture drawn as text, 0..1. */
  setAsciiAmount: (v: number) => app.setAsciiAmount(v),
  getCamera: () => app.r.getCameraState(),
  setCamera: (c: CameraState) => app.r.setCameraState(c),
  resetCamera: () => app.r.resetCamera(),
  setInkOverride: (o: Record<string, unknown>) => {
    app.r.inkOverride = o;
    app.r.invalidate();
  },
  setQuality: (q: Record<string, number>) => Object.assign(app.r.quality, q),
  benchmark: (frames: number, mode: 'fast' | 'full') => app.r.benchmark(frames, mode),
  frameChains: (ids: string[]) => app.r.frameChains(ids),
  fingerprint: () => (app.structure ? coordinateFingerprint(app.structure) : null),
  /** bytes of mesh data currently cached (diagnostics) */
  geometryCacheBytes: () => app.r.geometryCacheBytes(),
  info: () => {
    const s = app.structure;
    if (!s) return null;
    return {
      id: s.id,
      chains: s.chains.map((c) => c.id),
      residues: s.residues.length,
      atoms: s.coords.length / 3,
      ssSource: s.ssSource,
      caOnly: s.caOnly,
      notes: [...s.notes],
      fingerprint: coordinateFingerprint(s),
    };
  },
  exportPNGBase64: async (w: number, h: number) => blobToBase64(await app.r.exportPNG(w, h)),
  /** Returns raw RGBA statistics for verification (corner pixels, alpha range). */
  exportStats: (w: number, h: number) => {
    const px = app.r.renderPixels(w, h);
    const at = (x: number, y: number) => Array.from(px.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));
    let minA = 255, nonWhite = 0;
    for (let i = 0; i < px.length; i += 4) {
      minA = Math.min(minA, px[i + 3]);
      if (px[i] < 250 || px[i + 1] < 250 || px[i + 2] < 250) nonWhite++;
    }
    let hsh = 2166136261;
    for (let i = 0; i < px.length; i += 7) hsh = Math.imul(hsh ^ px[i], 16777619);
    return { corners: [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)], minAlpha: minA, nonWhiteFraction: nonWhite / (w * h), hash: (hsh >>> 0).toString(16) };
  },
  ready: () => !!app.structure,
};
(window as unknown as { molart: typeof api }).molart = api;
