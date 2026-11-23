import { loadStructure } from '../io/load';
import { coordinateFingerprint, Structure } from '../model/structure';
import { allStyles, getStyle } from '../art/registry';
import { CameraState, MAX_LIGHTS, MolartRenderer, RENDERER_VERSION } from '../renderer/renderer';

const SAMPLES = [
  { id: '1TIM', label: '1TIM — triosephosphate isomerase (TIM barrel, 2 chains)' },
  { id: '3CHY', label: '3CHY — CheY (compact α/β)' },
  { id: '1UBQ', label: '1UBQ — ubiquitin (small α/β)' },
  { id: '4HHB', label: '4HHB — haemoglobin (4 chains, all-α)' },
  { id: '1BNA', label: '1BNA — B-DNA dodecamer (double helix)' },
  { id: '1EHZ', label: '1EHZ — tRNA-Phe (RNA)' },
  { id: '1AAY', label: '1AAY — Zif268 zinc fingers on DNA' },
];

interface Settings {
  style: string;
  seed: number;
  deform: number;
  /** artistic deformation per style (each style's slider is opt-in on its own) */
  deforms?: Record<string, number>;
  exportSize: number;
  /** User-chosen colours per style id (two sRGB hex strings), for styles that offer a colour choice. */
  colors?: Record<string, [string, string]>;
  /** Per-structure chain styles: structure id → (chain id → style id). Chains not listed use the main style. */
  chainStyles?: Record<string, Record<string, string>>;
  /** per structure: chains whose mode differs from the main one (chain id → art mode on/off) */
  chainArt?: Record<string, Record<string, boolean>>;
  /** Cartoon: draw faces, heads and arms. */
  faces?: boolean;
  /** art mode: styles may leave the true ribbon behind (opt-in) */
  artMode?: boolean;
  /** ASCII Fold: share of the picture drawn as text (0..1). */
  asciiAmount?: number;
  /** the sun's lights: where each stands on the pad (x right, y up, unit disc) and its colour (hex); the first is the key light */
  lights?: PadLight[];
  /** whether the sun is on */
  sun?: boolean;
  /** before the pad: one light as degrees turned from upper left (read once, then replaced by `lights`) */
  light?: { angle: number; color: string };
}

type RGB = [number, number, number];
const hexToRgb = (hex: string): RGB | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const rgbToHex = (c: readonly number[]) => '#' + c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('');
/** Glass colour presets: [name, colour A (helices / strands), colour B (loops / edges)]. */
const GLASS_PRESETS: [string, string, string][] = [
  ['Rose', '#f25cbd', '#7861f2'],
  ['Aqua', '#5cc8e8', '#4a6cf0'],
  ['Emerald', '#5fd3a0', '#2f9fb0'],
  ['Amber', '#f5b54a', '#ee6a5a'],
  ['Violet', '#a98bf5', '#5b7cf0'],
  ['Smoke', '#a9b4c4', '#6f7f9a'],
];
const SETTINGS_KEY = 'molart.settings.v2';
/** What was being drawn when the page last died (set before a change, cleared once the picture has stood for a few seconds). */
const PENDING_KEY = 'molart.pending.v1';
const camKey = (id: string) => `molart.camera.v1.${id}`;
const store = {
  get<T>(k: string): T | null {
    try {
      const v = localStorage.getItem(k);
      return v ? (JSON.parse(v) as T) : null;
    } catch {
      return null;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  },
};

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
};

export interface PadLight { x: number; y: number; color: string }
/** where a new first, second, ... light stands, and its colour */
const LIGHT_DEFAULTS: PadLight[] = [
  { x: -0.52, y: 0.77, color: '#ffffff' },
  { x: 0.72, y: 0.3, color: '#ffb060' },
  { x: -0.62, y: -0.5, color: '#7fb4ff' },
  { x: 0.3, y: -0.8, color: '#ff8fb0' },
];
/** the pad position of the old one-slider light: upper left, turned by `angle` degrees about the viewing direction */
const angleToPad = (angle: number) => {
  const a = (angle * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a), n = Math.hypot(0.42, 0.62, 0.3);
  return { x: (-0.42 * c - 0.62 * sn) / n, y: (-0.42 * sn + 0.62 * c) / n };
};
const onPad = (x: number, y: number) => {
  const r = Math.hypot(x, y), f = r > 0.95 ? 0.95 / r : 1;
  return { x: Math.round(x * f * 1000) / 1000, y: Math.round(y * f * 1000) / 1000 };
};

export class App {
  r: MolartRenderer;
  structure: Structure | null = null;
  fileName = '';
  /** true while a bundled sample is shown: the top bar then invites the user to bring their own file */
  isSample = false;
  settings: Settings;
  private els: Record<string, HTMLElement> = {};
  private camSaveTimer = 0;
  private safeStartNote = '';
  /** chain the style row applies to; '' = every chain */
  private target = '';
  private pendingTimer = 0;
  /** Note what is about to be drawn; forgotten again once the page has survived it for a few seconds. */
  private guard() {
    store.set(PENDING_KEY, { style: this.settings.style, art: !!this.settings.artMode });
    clearTimeout(this.pendingTimer);
    this.pendingTimer = window.setTimeout(() => store.set(PENDING_KEY, null), 5000);
  }

  constructor(root: HTMLElement) {
    const params = new URLSearchParams(location.search);
    this.settings = {
      style: 'normal',
      seed: 7,
      deform: 0,
      exportSize: 2048,
      ...(store.get<Settings>(SETTINGS_KEY) ?? {}),
    };
    // settings from before the light pad: one light given as an angle, on whenever present
    if (this.settings.light && !this.settings.lights) {
      const at = angleToPad(this.settings.light.angle);
      this.settings.lights = [{ ...onPad(at.x, at.y), color: this.settings.light.color }];
      this.settings.sun = true;
    }
    delete this.settings.light;
    // Safe start: if the page died while drawing something last time, do not walk into the same state again.
    const pend = store.get<{ style?: string; art?: boolean }>(PENDING_KEY);
    if (pend && typeof pend.style === 'string') {
      const label = allStyles().find((x) => x.id === pend.style)?.label ?? pend.style;
      this.safeStartNote = `molart did not finish drawing “${label}”${pend.art ? ' in art mode' : ''} last time, so it started in Scientific instead. Please report this style.`;
      this.settings.style = 'normal';
      this.settings.artMode = false;
      store.set(SETTINGS_KEY, this.settings);
    }
    // one-time: versions before the safe start left no marker, so the first start with it begins from the scientific view
    if (!store.get<boolean>('molart.safeStart.v1')) {
      store.set('molart.safeStart.v1', true);
      if (this.settings.style !== 'normal' || this.settings.artMode) {
        this.settings.style = 'normal';
        this.settings.artMode = false;
        store.set(SETTINGS_KEY, this.settings);
      }
    }
    store.set(PENDING_KEY, null);
    window.addEventListener('pagehide', () => store.set(PENDING_KEY, null));   // a normal close is not a crash
    if (params.get('style')) this.settings.style = params.get('style')!;
    if (params.get('seed')) this.settings.seed = parseInt(params.get('seed')!, 10) || 0;
    if (!allStyles().some((s) => s.id === this.settings.style)) this.settings.style = 'normal';
    // sanitise anything restored from storage
    const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    this.settings.seed = Math.round(num(this.settings.seed, 7, 0, 2 ** 31));
    this.settings.deform = num(this.settings.deform, 0, 0, 1);
    if (!this.settings.deforms) this.settings.deforms = this.settings.deform > 0 ? { dali: this.settings.deform } : {};
    this.settings.deform = this.deformFor(this.settings.style);
    this.settings.exportSize = Math.round(num(this.settings.exportSize, 2048, 256, 8192));
    if (!this.settings.colors || typeof this.settings.colors !== 'object') this.settings.colors = {};
    this.settings.faces = this.settings.faces !== false;
    this.settings.asciiAmount = num(this.settings.asciiAmount, 0.5, 0, 1);

    const canvas = h('canvas', { id: 'view', tabindex: '0', 'aria-label': 'Structure view. Drag to rotate, scroll to zoom, right-drag to pan.' }) as HTMLCanvasElement;
    const main = h('main', {}, canvas, h('div', { class: 'drop hidden', id: 'drop' }, 'Drop a .pdb / .cif / .mmcif file'));
    const ui = this.buildPanel();
    main.append(ui.top, this.els.error);
    root.append(main, ui.dock, ui.scrim, ui.drawer);
    this.r = new MolartRenderer(canvas);
    this.r.style = getStyle(this.settings.style);
    this.r.params = { seed: this.settings.seed, deform: this.settings.deform, light: this.lightParam() };
    this.r.controls.addEventListener('change', () => this.scheduleCameraSave());
    this.bindDrop(main);
    this.bindKeys(canvas);
    new ResizeObserver(() => this.r.invalidate()).observe(main);
    this.refreshStyleUI();
    const sample = params.get('sample') ?? (params.has('empty') ? null : '1TIM');
    if (sample) void this.loadSample(sample).then(() => this.safeStartNote && this.showError(this.safeStartNote));
    else if (this.safeStartNote) this.showError(this.safeStartNote);
  }

  // ---------- UI ----------
  private buildPanel(): { top: HTMLElement; dock: HTMLElement; drawer: HTMLElement; scrim: HTMLElement } {
    const els = this.els;
    const file = h('input', { type: 'file', accept: '.pdb,.ent,.cif,.mmcif', class: 'hidden', id: 'file' }) as HTMLInputElement;
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (f) await this.loadText(await f.text(), f.name).catch(() => undefined); // error already shown in the panel
      file.value = '';
    });
    const sampleSel = h('select', { 'aria-label': 'Sample structure' }, h('option', { value: '' }, 'Sample structures…'), ...SAMPLES.map((s) => h('option', { value: s.id }, s.label))) as HTMLSelectElement;
    sampleSel.addEventListener('change', () => sampleSel.value && void this.loadSample(sampleSel.value));
    const pdbId = h('input', { placeholder: 'PDB ID', size: '6', maxlength: '4', 'aria-label': 'PDB ID to fetch' }) as HTMLInputElement;
    const fetchBtn = h('button', {}, 'Fetch');
    fetchBtn.addEventListener('click', () => void this.fetchPdb(pdbId.value));
    pdbId.addEventListener('keydown', (e) => e.key === 'Enter' && void this.fetchPdb(pdbId.value));

    const styleBtns = h('div', { class: 'styles', role: 'group', 'aria-label': 'Artistic style' });
    allStyles().forEach((s, i) => {
      const b = h('button', { 'data-style': s.id, 'aria-pressed': 'false', title: i < 10 ? `${s.label} (key ${i === 9 ? 0 : i + 1})` : s.label }, s.label);
      b.addEventListener('click', () => this.chooseStyle(s.id));
      styleBtns.append(b);
    });
    // a mouse wheel moves along the row of styles
    styleBtns.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      styleBtns.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
    const technique = h('p', { class: 'technique' });
    const seed = h('input', { type: 'number', value: String(this.settings.seed), min: '0', step: '1', style: 'width:80px', 'aria-label': 'Seed' }) as HTMLInputElement;
    seed.addEventListener('change', () => this.setSeed(parseInt(seed.value, 10) || 0));
    const deform = h('input', { id: 'deformRange', type: 'range', min: '0', max: '1', step: '0.05', value: String(this.settings.deform), 'aria-label': 'Artistic deformation amount' }) as HTMLInputElement;
    deform.addEventListener('change', () => this.setDeform(parseFloat(deform.value)));
    const deformBox = h('section', { class: 'ctl hidden' }, h('label', { id: 'deformTitle', for: 'deformRange' }, 'Melt'), deform);
    const deformWarn = h('span', { class: 'warn hidden', id: 'deformWarn', title: 'Artistic deformation: the drawn mesh is reshaped. Not a physical conformation; atomic coordinates are unchanged.' }, 'Shape altered for art');

    // colour choice (styles with selectable colours, e.g. Glass)
    const mkColor = (label: string) => h('input', { type: 'color', 'aria-label': label, title: label }) as HTMLInputElement;
    const colA = mkColor('Colour of helices and strands'), colB = mkColor('Colour of loops and edges');
    const onPick = () => this.setColors(colA.value, colB.value);
    colA.addEventListener('input', onPick);
    colB.addEventListener('input', onPick);
    const presets = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Colour presets' });
    for (const [name, a, b] of GLASS_PRESETS) {
      const sw = h('button', { class: 'swatch', title: name, 'aria-label': `${name} glass`, 'data-a': a, 'data-b': b });
      sw.style.background = `linear-gradient(135deg, ${a} 0 55%, ${b} 55% 100%)`;
      sw.addEventListener('click', () => this.setColors(a, b));
      presets.append(sw);
    }
    const colReset = h('button', { class: 'quiet' }, 'Reset');
    colReset.addEventListener('click', () => this.setColors(null));
    const colorBox = h('section', { class: 'ctl hidden' }, presets, colA, colB, colReset);
    els.colorBox = colorBox;
    // style options: Cartoon faces on/off, ASCII Fold text share
    const faces = h('input', { type: 'checkbox', id: 'facesToggle' }) as HTMLInputElement;
    faces.checked = this.settings.faces !== false;
    faces.addEventListener('change', () => this.setFaces(faces.checked));
    const facesBox = h('section', { class: 'ctl hidden' }, h('label', { class: 'check' }, faces, ' Faces and arms'));
    const ascii = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(this.settings.asciiAmount ?? 0.5), 'aria-label': 'Share of the picture drawn as text' }) as HTMLInputElement;
    const asciiOut = h('span', { class: 'note' }, '');
    ascii.addEventListener('input', () => this.setAsciiAmount(parseFloat(ascii.value)));
    const asciiBox = h('section', { class: 'ctl hidden' }, h('label', {}, 'Text'), ascii, asciiOut);
    const art = h('input', { type: 'checkbox', id: 'artToggle', class: 'hidden', tabindex: '-1', 'aria-hidden': 'true' }) as HTMLInputElement;
    art.checked = !!this.settings.artMode;
    art.addEventListener('change', () => this.setArtMode(art.checked));
    // Science | Art: one two-way switch (the hidden checkbox mirrors it)
    const modeSci = h('button', { id: 'modeScience', 'aria-pressed': 'true', title: 'Every style draws the true ribbon' }, 'Science');
    const modeArt = h('button', { id: 'modeArt', 'aria-pressed': 'false', title: 'Styles go beyond the true ribbon' }, 'Art');
    modeSci.addEventListener('click', () => this.chooseMode(false));
    modeArt.addEventListener('click', () => this.chooseMode(true));
    const artBox = h('div', { class: 'mode', role: 'group', 'aria-label': 'Mode' }, modeSci, modeArt, art);
    const artWarn = h('span', { class: 'warn hidden', id: 'artWarn', title: 'Art mode: shapes are an interpretation and no longer follow the true backbone. Atomic coordinates are unchanged.' }, 'Shape altered for art');
    Object.assign(els, { facesBox, faces, asciiBox, ascii, asciiOut, artBox, art, modeSci, modeArt });
    // per-chain styles (shown for structures with more than one chain)
    // what the style row applies to: everything, or one chain (shown for structures with more than one chain)
    els.chainBox = h('div', { class: 'mode targets hidden', role: 'group', 'aria-label': 'Apply the style to' });
    els.colA = colA;
    els.colB = colB;
    els.presets = presets;

    const size = h('select', { 'aria-label': 'Export size' }, ...[1024, 2048, 3072, 4096].map((n) => h('option', { value: String(n) }, `${n} × ${n}`))) as HTMLSelectElement;
    size.value = String(this.settings.exportSize);
    size.addEventListener('change', () => {
      this.settings.exportSize = parseInt(size.value, 10);
      this.saveSettings();
    });
    const exportBtn = h('button', { class: 'primary' }, 'Export');
    exportBtn.addEventListener('click', () => void this.downloadPNG());
    const galleryBtn = h('button', {}, 'Same-view gallery');
    galleryBtn.addEventListener('click', () => void this.showGallery());
    const resetBtn = h('button', {}, 'Reset view');
    resetBtn.addEventListener('click', () => this.r.resetCamera());
    const camBtn = h('button', {}, 'Copy camera');
    camBtn.addEventListener('click', () => {
      const json = JSON.stringify(this.r.getCameraState());
      (navigator.clipboard ? navigator.clipboard.writeText(json) : Promise.reject(new Error('no clipboard')))
        .then(() => (camBtn.textContent = 'Copied'))
        .catch(() => {
          camBtn.textContent = 'Copy blocked';
          this.showError(`Camera: ${json}`);
        });
      setTimeout(() => (camBtn.textContent = 'Copy camera'), 1200);
    });

    els.styleBtns = styleBtns;
    els.technique = technique;
    els.deformBox = deformBox;
    els.deform = deform;
    els.seed = seed;
    els.info = h('div', { class: 'info' }, 'No structure loaded.');
    els.error = h('div', { class: 'error' });
    els.sampleSel = sampleSel;

    // light: a pad with one dot per light (the protein seen from the camera: centre = light from the viewer, rim = grazing light)
    const lightPad = h('div', { id: 'lightPad', class: 'pad', role: 'group', 'aria-label': 'Where the lights stand' });
    const lightColor = h('input', { id: 'lightColor', type: 'color', value: '#ffffff', 'aria-label': 'Colour of the selected light', title: 'Colour of the selected light' }) as HTMLInputElement;
    const lightOn = h('button', { id: 'sunBtn', 'aria-pressed': 'false', title: 'Sunlight with cast shadows' }, 'Sun');
    const lightAdd = h('button', { id: 'lightAdd', title: 'Add a light', 'aria-label': 'Add a light' }, '+');
    const lightDel = h('button', { id: 'lightDel', title: 'Remove the selected light', 'aria-label': 'Remove the selected light' }, '−');
    const padXY = (e: PointerEvent) => {
      const b = lightPad.getBoundingClientRect(), R = b.width / 2;
      return onPad((e.clientX - b.left - R) / R, -(e.clientY - b.top - R) / R);
    };
    const moveSel = (x: number, y: number) => {
      const ls = this.padLights().map((l) => ({ ...l }));
      ls[this.lightSel] = { ...ls[this.lightSel], ...onPad(x, y) };
      this.setLights(ls);
    };
    let dragging = false;
    lightPad.addEventListener('pointerdown', (e) => {
      const dot = (e.target as HTMLElement).closest('.dot') as HTMLElement | null;
      if (dot) this.lightSel = Number(dot.dataset.i);
      const p = padXY(e);
      if (!dot) moveSel(p.x, p.y);
      else this.setLights(this.padLights());
      dragging = true;
      lightPad.setPointerCapture(e.pointerId);
      e.preventDefault();
      (lightPad.children[this.lightSel] as HTMLElement | undefined)?.focus();
    });
    lightPad.addEventListener('pointermove', (e) => { if (dragging) { const p = padXY(e); moveSel(p.x, p.y); } });
    const endDrag = () => { dragging = false; };
    lightPad.addEventListener('pointerup', endDrag);
    lightPad.addEventListener('pointercancel', endDrag);
    lightPad.addEventListener('keydown', (e) => {
      const dot = (e.target as HTMLElement).closest('.dot') as HTMLElement | null;
      if (!dot) return;
      this.lightSel = Number(dot.dataset.i);
      const l = this.padLights()[this.lightSel], d = e.shiftKey ? 0.15 : 0.05;
      const step: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] };
      if (step[e.key]) { moveSel(l.x + step[e.key][0], l.y + step[e.key][1]); e.preventDefault(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { this.removeLight(); e.preventDefault(); }
      else return;
      (lightPad.children[this.lightSel] as HTMLElement | undefined)?.focus();
    });
    lightColor.addEventListener('input', () => {
      const ls = this.padLights().map((l) => ({ ...l }));
      ls[this.lightSel].color = lightColor.value;
      this.setLights(ls);
    });
    lightOn.addEventListener('click', () => this.setLights(this.settings.sun ? null : this.padLights()));
    lightAdd.addEventListener('click', () => this.addLight());
    lightDel.addEventListener('click', () => this.removeLight());
    els.lightOn = lightOn;
    els.lightPad = lightPad;
    els.lightAdd = lightAdd;
    els.lightDel = lightDel;
    els.lightColor = lightColor;
    this.els = els;
    this.syncLightUI();
    els.name = h('span', { class: 'name' });
    // a quiet invitation beside the sample's name; it goes away once the user's own structure is shown
    const touch = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
    els.hint = h('button', { class: 'quiet hint hidden', id: 'ownHint', title: 'Open a .pdb, .cif or .mmcif file. It stays in your browser.' }, touch ? 'or open your own file' : 'or drop your own file');
    els.hint.addEventListener('click', () => file.click());
    const openBtn = h('button', {}, 'Open file…');
    openBtn.addEventListener('click', () => file.click());
    const moreBtn = h('button', { id: 'moreBtn', class: 'round', 'aria-label': 'More', 'aria-expanded': 'false', title: 'More' }, '···');
    const closeBtn = h('button', { class: 'round', 'aria-label': 'Close' }, '×');
    const scrim = h('div', { class: 'scrim hidden' });
    const drawer = h(
      'aside',
      { class: 'drawer', 'aria-label': 'More', inert: '' },
      h('header', {}, h('h1', {}, 'molart'), closeBtn),
      h('section', {}, h('h2', {}, 'Structure'), h('div', { class: 'row' }, openBtn, file, sampleSel), h('div', { class: 'row' }, pdbId, fetchBtn)),
      h('section', {}, h('h2', {}, 'Picture'), h('div', { class: 'row' }, h('label', {}, 'Seed ', seed), size), h('div', { class: 'row' }, resetBtn, camBtn, galleryBtn)),
      h('section', {}, h('h2', {}, 'Light'), h('div', { class: 'row light' }, lightPad, h('div', { class: 'lightside' }, lightOn, h('div', { class: 'row' }, lightAdd, lightDel, lightColor)))),
      h('section', {}, h('h2', {}, 'Style'), technique),
      h('section', {}, h('h2', {}, 'About'), els.info, h('p', { class: 'technique' }, 'Drag to rotate, scroll to zoom, right-drag to pan. R resets the view; keys 1–9 and 0 switch styles.')),
    );
    const setDrawer = (open: boolean) => {
      drawer.classList.toggle('open', open);
      drawer.toggleAttribute('inert', !open);
      scrim.classList.toggle('hidden', !open);
      // on a phone the panel is a sheet under the picture: the page makes room so the structure stays in view
      drawer.parentElement?.classList.toggle('sheet-open', open);
      moreBtn.setAttribute('aria-expanded', String(open));
    };
    moreBtn.addEventListener('click', () => setDrawer(!drawer.classList.contains('open')));
    closeBtn.addEventListener('click', () => setDrawer(false));
    scrim.addEventListener('click', () => setDrawer(false));
    window.addEventListener('keydown', (e) => e.key === 'Escape' && setDrawer(false));
    const top = h('div', { class: 'top' }, h('div', { class: 'brand' }, h('h1', {}, 'molart'), els.name, els.hint), h('div', { class: 'row' }, moreBtn, exportBtn));
    const dock = h(
      'footer',
      { class: 'dock' },
      h('div', { class: 'context' }, deformBox, colorBox, facesBox, asciiBox),
      styleBtns,
      // bottom row: Science | Art, what the style applies to, and a short label while the picture is an interpretation
      h('div', { class: 'bar' }, artBox, els.chainBox, artWarn, deformWarn),
    );
    return { top, dock, drawer, scrim };
  }

  private refreshStyleUI() {
    const st = getStyle(this.settings.style);
    // the row shows the style of what is selected: one chain, or everything (nothing is marked while chains differ)
    const assigned = this.chainAssign();
    const shownStyle = this.target ? assigned[this.target] ?? st.id : Object.keys(assigned).length ? '' : st.id;
    const row = this.els.styleBtns;
    row.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.style === shownStyle;
      b.setAttribute('aria-pressed', String(on));
      // keep the chosen style in view inside its own row (never scrolls the page)
      if (on && row.clientWidth > 0) row.scrollLeft = Math.max(0, b.offsetLeft - row.offsetLeft - (row.clientWidth - b.offsetWidth) / 2);
    });
    this.els.deformBox.classList.toggle('hidden', !st.deformable);
    const dt = document.getElementById('deformTitle');
    if (dt) dt.textContent = st.deformLabel ?? 'Melt';
    this.els.deform.title = st.deformHint ?? 'Artistic deformation (opt-in)';
    (this.els.deform as HTMLInputElement).value = String(this.settings.deform);
    document.getElementById('deformWarn')?.classList.toggle('hidden', !(st.deformable && this.settings.deform > 0));
    const used = [st, ...Object.values(this.chainAssign()).map((id) => getStyle(id))];
    this.els.facesBox.classList.toggle('hidden', !used.some((x) => x.faces));
    // the mode of what is selected (one chain, or everything; null while chains differ), and whether anything on screen is an interpretation
    const modes = this.chainArtAssign();
    const mainArt = !!this.settings.artMode;
    const shownArt: boolean | null = this.target ? modes[this.target] ?? mainArt : Object.keys(modes).length ? null : mainArt;
    const chainIds = this.structure ? [...new Set(this.structure.chains.map((c) => c.id))] : [];
    const anyArt = chainIds.length
      ? chainIds.some((c) => (modes[c] ?? mainArt) && !!getStyle(assigned[c] ?? st.id).art)
      : mainArt && !!st.art;
    // one quiet line: what the selected style does (or, in art mode, how it reads the structure)
    const cap = getStyle(shownStyle || st.id);
    this.els.technique.textContent = shownArt && cap.art ? cap.art.note : cap.technique;
    this.els.technique.title = this.els.technique.textContent;
    this.els.modeSci.setAttribute('aria-pressed', String(shownArt === false));
    this.els.modeArt.setAttribute('aria-pressed', String(shownArt === true));
    const hasArt = shownStyle ? !!cap.art : used.some((x) => x.art);
    this.els.modeArt.classList.toggle('none', !hasArt);
    this.els.modeArt.title = hasArt ? 'Styles go beyond the true ribbon' : 'This style has no art form yet; it draws the true ribbon in both modes';
    document.getElementById('artWarn')?.classList.toggle('hidden', !anyArt);
    (this.els.faces as HTMLInputElement).checked = this.settings.faces !== false;
    this.els.asciiBox.classList.toggle('hidden', !used.some((x) => x.ascii));
    const amt = this.settings.asciiAmount ?? 0.5;
    (this.els.ascii as HTMLInputElement).value = String(amt);
    this.els.asciiOut.textContent = amt <= 0 ? 'ribbon only' : amt >= 1 ? 'text only' : `${Math.round(amt * 100)}% towards text`;
    const gs = this.glassStyleInUse();
    const def = gs?.glass?.colors;
    this.els.colorBox.classList.toggle('hidden', !def);
    if (def && gs) {
      const cur = this.colorsFor(gs.id) ?? [rgbToHex(def[0]), rgbToHex(def[1])];
      (this.els.colA as HTMLInputElement).value = cur[0];
      (this.els.colB as HTMLInputElement).value = cur[1];
      this.els.presets.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.a === cur[0] && b.dataset.b === cur[1])));
    }
  }

  /** Valid saved chain styles for the loaded structure (chain id → style id). */
  chainAssign(): Record<string, string> {
    const s = this.structure;
    const saved = s ? this.settings.chainStyles?.[s.id] : null;
    const out: Record<string, string> = {};
    if (!s || !saved || typeof saved !== 'object') return out;
    const known = new Set(allStyles().map((x) => x.id));
    for (const c of s.chains) {
      const id = saved[c.id];
      if (typeof id === 'string' && known.has(id) && id !== this.settings.style) out[c.id] = id;
    }
    return out;
  }
  /** Chains of the loaded structure whose mode differs from the main one (chain id → art mode on/off). */
  chainArtAssign(): Record<string, boolean> {
    const s = this.structure;
    const saved = s ? this.settings.chainArt?.[s.id] : null;
    const out: Record<string, boolean> = {};
    if (!s || !saved || typeof saved !== 'object') return out;
    for (const c of s.chains) if (typeof saved[c.id] === 'boolean' && saved[c.id] !== !!this.settings.artMode) out[c.id] = saved[c.id];
    return out;
  }
  /** Give chains their own mode (chain id → on/off, null = follow the main mode); null clears every chain. */
  setChainArt(assign: Record<string, boolean | null> | null) {
    const s = this.structure;
    if (!s) return;
    const all = { ...(this.settings.chainArt ?? {}) };
    if (!assign) delete all[s.id];
    else {
      const cur: Record<string, boolean> = { ...(all[s.id] ?? {}) };
      for (const [c, on] of Object.entries(assign)) {
        if (typeof on === 'boolean') cur[c] = on;
        else delete cur[c];
      }
      all[s.id] = cur;
    }
    this.settings.chainArt = all;
    this.guard();
    this.r.setChainArt(this.chainArtAssign());
    this.refreshStyleUI();
    this.saveSettings();
  }
  /** The one way to pick the mode in the interface: like a style, it goes to whatever is selected ("All" or one chain). */
  chooseMode(on: boolean) {
    if (this.target && this.structure) return this.setChainArt({ [this.target]: on });
    if (this.structure && Object.keys(this.chainArtAssign()).length) this.setChainArt(null);   // "All" means all
    this.setArtMode(on);
  }
  /** The style whose colours the Colour section edits: the main style, or a chain's style, if it is glass. */
  private glassStyleInUse() {
    const main = getStyle(this.settings.style);
    if (main.glass) return main;
    for (const id of Object.values(this.chainAssign())) if (getStyle(id).glass) return getStyle(id);
    return null;
  }
  private activeColors(): [RGB, RGB] | null {
    const gs = this.glassStyleInUse();
    return gs ? this.colorParam(gs.id) : null;
  }
  private applyChainStyles() {
    const a = this.chainAssign();
    this.r.setChainStyles(Object.fromEntries(Object.entries(a).map(([c, id]) => [c, getStyle(id)])));
    this.r.setChainArt(this.chainArtAssign());
    this.r.setParams({ colors: this.activeColors() });
  }
  /** Assign styles to chains (chain id → style id); null clears every assignment. Unknown ids are ignored. */
  setChainStyles(assign: Record<string, string | null> | null) {
    const s = this.structure;
    if (!s) return;
    const all = { ...(this.settings.chainStyles ?? {}) };
    if (!assign) delete all[s.id];
    else {
      const cur: Record<string, string> = { ...(all[s.id] ?? {}) };
      for (const [c, id] of Object.entries(assign)) {
        if (id) cur[c] = getStyle(id).id;
        else delete cur[c];
      }
      all[s.id] = cur;
    }
    this.settings.chainStyles = all;
    this.applyChainStyles();
    this.refreshChainUI();
    this.refreshStyleUI();
    this.saveSettings();
  }
  private refreshChainUI() {
    const s = this.structure, box = this.els.chainBox;
    box.innerHTML = '';
    const ids = s ? [...new Set(s.chains.map((c) => c.id))] : [];
    if (!ids.includes(this.target)) this.target = '';
    box.classList.toggle('hidden', ids.length < 2);
    if (!s || ids.length < 2) return;
    const a = this.chainAssign();
    const chip = (id: string, text: string, title: string) => {
      const b = h('button', { 'data-chain': id, 'aria-pressed': String(this.target === id), title }, text);
      b.addEventListener('click', () => {
        this.target = id;
        this.refreshChainUI();
        this.refreshStyleUI();
      });
      box.append(b);
    };
    chip('', 'All', 'The style applies to every chain');
    for (const id of ids) chip(id, id || '_', `Chain ${id || '_'}: ${getStyle(a[id] ?? this.settings.style).label}. The style applies to this chain only`);
  }

  /** The one way to pick a style in the interface: it goes to whatever is selected, every chain ("All") or a single chain. */
  chooseStyle(id: string) {
    if (this.target && this.structure) return this.setChainStyles({ [this.target]: id === this.settings.style ? null : id });
    if (this.structure && Object.keys(this.chainAssign()).length) this.setChainStyles(null);   // "All" means all
    this.setStyle(id);
  }

  /** Saved, valid colour choice for a style, as hex strings. */
  private colorsFor(id: string): [string, string] | null {
    const c = this.settings.colors?.[id];
    return Array.isArray(c) && c.length === 2 && hexToRgb(String(c[0])) && hexToRgb(String(c[1])) ? [rgbToHex(hexToRgb(c[0])!), rgbToHex(hexToRgb(c[1])!)] : null;
  }
  private colorParam(id: string): [RGB, RGB] | null {
    const c = this.colorsFor(id);
    return c ? [hexToRgb(c[0])!, hexToRgb(c[1])!] : null;
  }

  /** Choose the two colours of the current style (hex strings), or null to restore its defaults. */
  setColors(a: string | null, b?: string) {
    const st = this.glassStyleInUse();
    if (!st) return;
    const colors = { ...(this.settings.colors ?? {}) };
    if (a && b && hexToRgb(a) && hexToRgb(b)) colors[st.id] = [a, b];
    else delete colors[st.id];
    this.settings.colors = colors;
    this.r.setParams({ colors: this.activeColors() });
    this.refreshStyleUI();
    this.saveSettings();
  }

  private refreshInfo() {
    const s = this.structure;
    if (!s) return;
    const counts = { H: 0, E: 0, C: 0 };
    s.residues.forEach((r) => counts[r.ss]++);
    const ssLabel = { file: 'from file records', 'computed-dssp': 'computed (DSSP-like)', 'computed-ca': 'computed from CA only (approximate)', none: 'none (no protein)' }[s.ssSource];
    const nNuc = s.residues.filter((r) => r.kind === 'nucleic').length;
    this.els.info.innerHTML = '';
    this.els.name.textContent = s.id;
    const line = (k: string, v: string) => this.els.info.append(h('div', {}, h('b', {}, k + ': '), v));
    line('Structure', `${s.id}${this.fileName ? ` (${this.fileName})` : ''}`);
    if (s.title) line('Title', s.title);
    line('Chains', s.chains.map((c) => `${c.id || '_'} (${c.residueEnd - c.residueStart})`).join(', '));
    if (nNuc < s.residues.length) line('Residues', `${s.residues.length - nNuc} · helix ${counts.H} · strand ${counts.E} · coil ${counts.C - nNuc}`);
    if (nNuc) line('Nucleotides', `${nNuc}`);
    line('Secondary structure', ssLabel);
    line('Coordinates', `${s.coords.length / 3} atoms · fingerprint ${coordinateFingerprint(s)}`);
    line('Renderer', `v${RENDERER_VERSION}`);
    for (const n of s.notes) this.els.info.append(h('div', { class: 'warn' }, n));
  }

  // ---------- actions ----------
  async loadSample(id: string) {
    const res = await fetch(`samples/${id}.cif`);
    if (!res.ok) return this.showError(`Sample ${id} not found.`);
    await this.loadText(await res.text(), `${id}.cif`);
    this.isSample = true;
    this.els.hint.classList.remove('hidden');
  }

  async fetchPdb(raw: string) {
    const id = raw.trim().toUpperCase();
    if (!/^[0-9][A-Z0-9]{3}$/.test(id)) return this.showError('Enter a 4-character PDB ID, e.g. 1TIM.');
    try {
      const res = await fetch(`https://files.rcsb.org/download/${id}.cif`);
      if (!res.ok) throw new Error(`RCSB returned ${res.status}`);
      await this.loadText(await res.text(), `${id}.cif (RCSB PDB)`);
    } catch (e) {
      this.showError(`Could not fetch ${id} from RCSB PDB (${(e as Error).message}). If this page cannot reach other sites, download ${id}.cif from rcsb.org and open it with “Open file…”.`);
    }
  }

  async loadText(text: string, name: string) {
    try {
      const s = loadStructure(text, name.replace(/ \(.*\)$/, ''));
      this.structure = s;
      this.fileName = name;
      this.isSample = false;
      this.els.hint.classList.add('hidden');
      this.guard();
      this.showError('');
      this.r.setStructure(s);
      const cam = store.get<CameraState>(camKey(s.id));
      if (cam && MolartRenderer.validCamera(cam)) this.r.setCameraState(cam);
      else if (cam) store.set(camKey(s.id), null);   // drop a corrupted saved view
      this.r.setStyle(getStyle(this.settings.style), { seed: this.settings.seed, deform: this.settings.deform, colors: this.colorParam(this.settings.style), faces: this.settings.faces !== false, ascii: this.settings.asciiAmount ?? 0.5, art: !!this.settings.artMode });
      this.applyChainStyles();
      this.refreshChainUI();
      this.refreshStyleUI();
      this.refreshInfo();
      document.title = `molart — ${s.id}`;
    } catch (e) {
      this.showError((e as Error).message);
      throw e;
    }
  }

  private deformFor(id: string): number {
    const v = this.settings.deforms?.[id] ?? 0;
    return getStyle(id).deformable ? Math.max(0, Math.min(1, v)) : 0;
  }

  setStyle(id: string) {
    const st = getStyle(id);
    this.settings.style = st.id;
    this.guard();
    this.settings.deform = this.deformFor(st.id);
    this.r.setStyle(st, { colors: this.colorParam(st.id), deform: this.settings.deform });
    this.applyChainStyles();
    this.refreshChainUI();
    this.refreshStyleUI();
    this.saveSettings();
  }

  /** Science (false, default): every style draws the true ribbon. Art (true): styles that define one draw simplified or reshaped forms. */
  setArtMode(on: boolean) {
    this.settings.artMode = !!on;
    this.guard();
    (this.els.art as HTMLInputElement).checked = this.settings.artMode;
    this.r.setParams({ art: this.settings.artMode });
    this.r.setChainArt(this.chainArtAssign());
    this.refreshStyleUI();
    this.saveSettings();
  }

  /** Cartoon: draw the faces, heads and arms (true) or the plain ribbons (false). */
  setFaces(on: boolean) {
    this.settings.faces = !!on;
    this.r.setParams({ faces: this.settings.faces });
    this.refreshStyleUI();
    this.saveSettings();
  }

  /** ASCII Fold: share of the picture drawn as text, 0 (ribbon only) .. 1 (text only). */
  setAsciiAmount(v: number) {
    this.settings.asciiAmount = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5));
    this.r.setParams({ ascii: this.settings.asciiAmount });
    this.refreshStyleUI();
    this.saveSettings();
  }

  /** which light on the pad the colour and the keyboard act on */
  private lightSel = 0;

  /** the lights on the pad (there is always at least one, also while the sun is off) */
  private padLights(): PadLight[] {
    const ls = this.settings.lights;
    return ls && ls.length ? ls : [{ ...LIGHT_DEFAULTS[0] }];
  }

  private lightParam() {
    if (!this.settings.sun) return null;
    const out = this.padLights().map((l) => ({ x: l.x, y: l.y, color: hexToRgb(l.color) ?? ([1, 1, 1] as [number, number, number]) }));
    return out.length ? out : null;
  }

  /** draw the pad from the settings: one dot per light, the selected one marked */
  private syncLightUI() {
    const pad = this.els.lightPad, ls = this.padLights();
    this.lightSel = Math.max(0, Math.min(ls.length - 1, this.lightSel));
    while (pad.children.length > ls.length) pad.lastElementChild!.remove();
    while (pad.children.length < ls.length) pad.append(h('button', { class: 'dot', type: 'button' }));
    ls.forEach((l, i) => {
      const d = pad.children[i] as HTMLElement;
      d.dataset.i = String(i);
      d.style.left = `${50 + l.x * 50}%`;
      d.style.top = `${50 - l.y * 50}%`;
      d.style.background = l.color;
      d.setAttribute('aria-pressed', String(i === this.lightSel));
      d.setAttribute('aria-label', `Light ${i + 1}${i === 0 ? ' (key light)' : ''}: drag or use the arrow keys`);
      d.title = `Light ${i + 1}${i === 0 ? ' (key light)' : ''}`;
    });
    pad.classList.toggle('off', !this.settings.sun);
    (this.els.lightColor as HTMLInputElement).value = ls[this.lightSel].color;
    this.els.lightOn.setAttribute('aria-pressed', String(!!this.settings.sun));
    (this.els.lightAdd as HTMLButtonElement).disabled = ls.length >= MAX_LIGHTS;
    (this.els.lightDel as HTMLButtonElement).disabled = ls.length <= 1;
  }

  /**
   * Sun: up to four lights, each at (x, y) on the unit disc seen from the camera (x right, y up; centre = light from the
   * viewer, rim = grazing light) with a hex colour. The first is the key light. null turns the sun off and keeps the lights.
   */
  setLights(lights: PadLight[] | null) {
    if (lights === null) this.settings.sun = false;
    else {
      this.settings.lights = lights.slice(0, MAX_LIGHTS).map((l) => ({ ...onPad(l.x, l.y), color: hexToRgb(l.color) ? l.color : '#ffffff' }));
      this.settings.sun = this.settings.lights.length > 0;
    }
    this.syncLightUI();
    this.r.setParams({ light: this.lightParam() });
    this.saveSettings();
  }

  /** add a light at the next free default place (and turn the sun on) */
  addLight() {
    const ls = this.padLights();
    if (ls.length >= MAX_LIGHTS) return;
    const far = (d: PadLight) => Math.min(...ls.map((l) => Math.hypot(l.x - d.x, l.y - d.y)));
    const next = LIGHT_DEFAULTS.slice().sort((a, b) => far(b) - far(a))[0];
    this.lightSel = ls.length;
    // a colour no light has yet, so the new one shows at once
    const color = LIGHT_DEFAULTS.map((d) => d.color).find((c) => !ls.some((l) => l.color.toLowerCase() === c)) ?? next.color;
    this.setLights([...ls, { x: next.x, y: next.y, color }]);
  }

  /** remove the selected light (the last one stays) */
  removeLight() {
    const ls = this.padLights();
    if (ls.length <= 1) return;
    const i = this.lightSel;
    this.lightSel = Math.max(0, i - 1);
    this.setLights(ls.filter((_, j) => j !== i));
  }

  /** One light the old way: degrees turned from upper left, and a hex colour; null turns the sun off. Other lights are kept. */
  setLight(angle: number | null, color = '#ffffff') {
    if (angle === null) return this.setLights(null);
    const ls = this.padLights().map((l) => ({ ...l }));
    ls[0] = { ...angleToPad(angle), color };
    this.setLights(ls);
  }

  setSeed(seed: number) {
    this.settings.seed = seed;
    (this.els.seed as HTMLInputElement).value = String(seed);
    this.r.setParams({ seed });
    this.saveSettings();
  }

  setDeform(v: number, everyStyle = false) {
    const amount = Math.max(0, Math.min(1, v));
    const d = (this.settings.deforms ??= {});
    if (everyStyle) for (const st of allStyles()) if (st.deformable) d[st.id] = amount;
    d[this.settings.style] = amount;
    this.settings.deform = this.deformFor(this.settings.style);
    this.r.setParams({ deform: this.settings.deform });
    this.refreshStyleUI();
    this.saveSettings();
  }

  /** Export: show the PNG in a dialog (works where downloads are blocked) with a download link. */
  async downloadPNG() {
    if (!this.structure) return;
    const n = this.settings.exportSize;
    const blob = await this.r.exportPNG(n, n);
    const name = `${this.structure.id}-${this.settings.style}-seed${this.settings.seed}-${n}.png`;
    this.showImageDialog(blob, name, `${name} · ${n} × ${n} px · opaque white background`, `Exported ${this.settings.style} rendering of ${this.structure.id}`);
  }

  private showImageDialog(blob: Blob, name: string, title: string, alt: string) {
    const url = URL.createObjectURL(blob);
    const close = h('button', {}, 'Close');
    const dl = h('a', { href: url, download: name }, 'Download');
    dl.className = 'primary';
    dl.setAttribute('style', 'font-size:13px;padding:6px 12px;border-radius:8px;background:var(--ink);color:var(--on-ink);text-decoration:none');
    const box = h(
      'div',
      { class: 'exportbox', role: 'dialog', 'aria-label': title },
      h('header', {}, h('h2', {}, title), h('div', { class: 'row' }, dl, close)),
      h('p', {}, 'If the download button does nothing here, right-click the image (or long-press on a phone) and save it. The saved file is the full-resolution PNG.'),
      h('div', { class: 'frame' }, h('img', { src: url, alt })),
    );
    const done = () => {
      box.remove();
      URL.revokeObjectURL(url);
      document.removeEventListener('keydown', esc, true);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done();
      }
    };
    close.addEventListener('click', done);
    document.addEventListener('keydown', esc, true);
    document.body.append(box);
    close.focus();
  }

  /** Aspect ratio of the gallery tiles: the viewer's own shape, so every tile shows exactly the current view. */
  private tileAspect() {
    const v = document.getElementById('view') as HTMLElement;
    const a = v.clientWidth / Math.max(1, v.clientHeight);
    return Math.min(2, Math.max(0.75, a || 1));
  }

  /** Render every style at the current camera into tiles (PNG blobs). `onTile` fires as each finishes. */
  async renderGallery(
    width = 640,
    ids = allStyles().map((s) => s.id),
    onTile?: (i: number, t: { id: string; label: string; blob: Blob }) => void,
    cancelled: () => boolean = () => false,
  ): Promise<{ id: string; label: string; blob: Blob }[]> {
    const current = this.settings.style;
    const height = Math.round(width / this.tileAspect());
    const out: { id: string; label: string; blob: Blob }[] = [];
    try {
      this.r.setChainStyles(null);   // each tile shows one style on every chain, in the main mode
      this.r.setChainArt(null);
      for (let i = 0; i < ids.length && !cancelled(); i++) {
        const st = getStyle(ids[i]);
        this.r.setStyle(st, { colors: this.colorParam(st.id), deform: this.deformFor(st.id) });
        const blob = await this.r.exportPNG(width, height);
        const t = { id: ids[i], label: st.label + (this.settings.artMode && st.art ? ' · art mode' : '') + (st.deformable && this.deformFor(st.id) > 0 ? ` · ${st.deformLabel ? 'viewpoints shifted' : 'melted'}` : ''), blob };
        out.push(t);
        onTile?.(i, t);
        await new Promise((r) => requestAnimationFrame(() => r(null)));   // keep the page responsive between tiles
      }
    } finally {
      this.r.setStyle(getStyle(current), { colors: this.colorParam(current), deform: this.deformFor(current) });
      this.applyChainStyles();
    }
    return out;
  }

  /** Compose rendered tiles into one labelled overview sheet on white. */
  private async composeSheet(tiles: { label: string; blob: Blob }[]): Promise<Blob> {
    const imgs = await Promise.all(tiles.map((t) => createImageBitmap(t.blob)));
    const tw = imgs[0].width, th = imgs[0].height;
    // near-landscape sheet with as few empty slots as possible (16 tiles -> 4 x 4)
    let cols = 1, bestScore = Infinity;
    for (let k = 2; k <= 8; k++) {
      const r = Math.ceil(tiles.length / k);
      const score = Math.abs(Math.log((k * tw) / (r * th * 1.12) / 1.35)) + 0.35 * ((r * k - tiles.length) / k);
      if (score < bestScore) { bestScore = score; cols = k; }
    }
    const rows = Math.ceil(tiles.length / cols);
    const pad = Math.round(tw * 0.04), cap = Math.round(tw * 0.075), head = Math.round(tw * 0.12);
    const c = document.createElement('canvas');
    c.width = cols * tw + (cols + 1) * pad;
    c.height = head + rows * (th + cap) + rows * pad;
    const ctx = c.getContext('2d', { alpha: false })!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    const font = 'system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillStyle = '#2b2622';
    ctx.font = `600 ${Math.round(cap * 0.62)}px ${font}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(`${this.structure!.id} · ${tiles.length} styles · identical camera · seed ${this.settings.seed}`, pad, head * 0.55);
    ctx.font = `${Math.round(cap * 0.5)}px ${font}`;
    imgs.forEach((im, i) => {
      const x = pad + (i % cols) * (tw + pad), y = head + Math.floor(i / cols) * (th + cap + pad);
      ctx.drawImage(im, x, y);
      ctx.fillStyle = '#6f655d';
      ctx.fillText(tiles[i].label, x + 4, y + th + cap * 0.5);
      im.close();
    });
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
  }

  async showGallery() {
    if (!this.structure || document.querySelector('.gallery')) return;
    const styles = allStyles();
    const aspect = this.tileAspect();
    let closed = false;
    const urls: string[] = [];
    const tiles: { label: string; blob: Blob }[] = [];

    const close = h('button', {}, 'Close');
    const save = h('button', { disabled: '' }, 'Save overview PNG');
    const status = h('span', { class: 'status' }, `Rendering 0 / ${styles.length}…`);
    const figs = styles.map((st) => {
      const fig = h('figure', { 'data-style': st.id, title: `Switch to ${st.label}` }, h('div', { class: 'tile' }), h('figcaption', {}, st.label));
      fig.addEventListener('click', () => {
        if (!fig.querySelector('img')) return;
        this.setStyle(st.id);
        done();
      });
      return fig;
    });
    const grid = h('div', { class: 'grid' }, ...figs);
    grid.style.setProperty('--tile-aspect', String(aspect));
    const overlay = h(
      'div',
      { class: 'gallery', role: 'dialog', 'aria-label': 'Same-view gallery' },
      h('header', {}, h('h2', {}, `${this.structure.id} · seed ${this.settings.seed} · identical camera`), h('div', { class: 'row' }, status, save, close)),
      grid,
    );

    // choose the column count that makes the tiles largest while all of them fit on screen
    const layout = () => {
      const W = grid.clientWidth, H = grid.clientHeight, gap = 12, capH = 26, n = figs.length;
      let best = { cols: 1, w: 0 }, bestEmpty = 0;
      for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows - capH) * aspect);
        const empty = (rows * cols - n) / cols;   // prefer full last rows when tile sizes are close
        if (w * (1 - 0.12 * empty) > best.w * (1 - 0.12 * bestEmpty)) { best = { cols, w }; bestEmpty = empty; }
      }
      if (best.w < 150) best.cols = Math.max(1, Math.floor((W + gap) / (180 + gap)));   // small screens: scroll instead
      grid.style.gridTemplateColumns = `repeat(${best.cols}, minmax(0, 1fr))`;
      grid.style.maxWidth = best.w >= 150 ? `${Math.ceil(best.cols * best.w + gap * (best.cols - 1))}px` : '';
    };
    const ro = new ResizeObserver(layout);

    const done = () => {
      closed = true;
      ro.disconnect();
      overlay.remove();
      urls.forEach((u) => URL.revokeObjectURL(u));
      document.removeEventListener('keydown', esc, true);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.exportbox')) done();
    };
    close.addEventListener('click', done);
    document.addEventListener('keydown', esc, true);
    save.addEventListener('click', async () => {
      save.setAttribute('disabled', '');
      try {
        const sheet = await this.composeSheet(tiles);
        const name = `${this.structure!.id}-gallery-seed${this.settings.seed}.png`;
        this.showImageDialog(sheet, name, `${name} · all styles, identical camera`, `Overview of all styles for ${this.structure!.id}`);
      } finally {
        save.removeAttribute('disabled');
      }
    });
    document.body.append(overlay);
    ro.observe(grid);
    layout();
    close.focus();

    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await this.renderGallery(
      Math.round(Math.min(900, Math.max(480, (grid.clientWidth / 3) * Math.min(2, devicePixelRatio || 1)))),
      styles.map((s) => s.id),
      (i, t) => {
        const url = URL.createObjectURL(t.blob);
        urls.push(url);
        tiles.push(t);
        const tile = figs[i].querySelector('.tile')!;
        tile.replaceChildren(h('img', { src: url, alt: `${t.label} rendering of ${this.structure!.id}` }));
        figs[i].querySelector('figcaption')!.textContent = t.label;
        status.textContent = i + 1 < styles.length ? `Rendering ${i + 1} / ${styles.length}…` : `${styles.length} styles · click one to use it`;
      },
      () => closed,
    );
    if (!closed) save.removeAttribute('disabled');
  }

  private showError(msg: string) {
    this.els.error.textContent = msg;
  }

  private saveSettings() {
    store.set(SETTINGS_KEY, this.settings);
  }

  private scheduleCameraSave() {
    clearTimeout(this.camSaveTimer);
    this.camSaveTimer = window.setTimeout(() => {
      const c = this.r.getCameraState();
      if (this.structure && MolartRenderer.validCamera(c)) store.set(camKey(this.structure.id), c);
    }, 300);
  }

  private bindDrop(main: HTMLElement) {
    const drop = document.getElementById('drop')!;
    main.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.remove('hidden');
    });
    main.addEventListener('dragleave', () => drop.classList.add('hidden'));
    main.addEventListener('drop', async (e) => {
      e.preventDefault();
      drop.classList.add('hidden');
      const f = e.dataTransfer?.files?.[0];
      if (f) await this.loadText(await f.text(), f.name).catch(() => undefined);
    });
  }

  private bindKeys(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
      const styles = allStyles();
      const n = e.key === '0' ? 10 : parseInt(e.key, 10);
      if (n >= 1 && n <= Math.min(10, styles.length)) return this.chooseStyle(styles[n - 1].id);
      if (e.key === 'r' || e.key === 'R') return this.r.resetCamera();
      const cam = this.r.camera, target = this.r.controls.target;
      const rot = (axis: 'x' | 'y', ang: number) => {
        const offset = cam.position.clone().sub(target);
        const ax = axis === 'y' ? cam.up.clone().normalize() : cam.up.clone().cross(offset).normalize();
        offset.applyAxisAngle(ax, ang);
        if (axis === 'x') cam.up.applyAxisAngle(ax, ang);
        cam.position.copy(target).add(offset);
        cam.lookAt(target);
        this.r.invalidate();
        this.scheduleCameraSave();
      };
      const step = 0.08;
      if (e.key === 'ArrowLeft') rot('y', -step);
      else if (e.key === 'ArrowRight') rot('y', step);
      else if (e.key === 'ArrowUp') rot('x', -step);
      else if (e.key === 'ArrowDown') rot('x', step);
      else if (e.key === '+' || e.key === '=' || e.key === '-') {
        const f = e.key === '-' ? 1.1 : 1 / 1.1;
        cam.position.copy(target).add(cam.position.clone().sub(target).multiplyScalar(f));
        this.r.invalidate();
        this.scheduleCameraSave();
      } else return;
      e.preventDefault();
    });
    canvas.addEventListener('pointerdown', () => canvas.focus());
  }
}
