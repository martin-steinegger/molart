// Browser end-to-end test against the built app (dist/), in headless Chromium.
// usage: npm run build && node tests/e2e/run.mjs
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, serveStatic } from '../../cli/browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (!existsSync(join(ROOT, 'dist/index.html'))) throw new Error('Run "npm run build" first.');
mkdirSync(join(ROOT, 'outputs'), { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serveStatic(join(ROOT, 'dist'));
const { browser, page, errors } = await launch({ width: 1280, height: 860 });
const SLOW = process.env.CI ? 6 : 1;   // hosted CI renders in software on two cores
page.setDefaultTimeout(30000 * SLOW);
const external = [];
page.on('request', (r) => {
  if (!r.url().startsWith(server.url) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url());
});
try {
  await page.goto(`${server.url}?sample=1TIM`);
  await page.waitForFunction(() => window.molart?.ready(), null, { timeout: 60000 * SLOW });
  const info = await page.evaluate(() => window.molart.info());
  check('loads bundled 1TIM sample', info.id === '1TIM' && info.chains.join() === 'A,B' && info.residues === 494, JSON.stringify({ id: info.id, residues: info.residues }));
  const fp0 = info.fingerprint;

  // local file import through the real <input type=file>; must not hit the network
  const before = external.length;
  let reqDuringImport = 0;
  const onReq = () => reqDuringImport++;
  page.on('request', onReq);
  await page.setInputFiles('#file', join(ROOT, 'public/samples/3CHY.pdb'));
  await page.waitForFunction(() => window.molart.info()?.id === '3CHY', null, { timeout: 30000 * SLOW });
  page.off('request', onReq);
  check('local PDB file import (no network requests)', reqDuringImport === 0 && external.length === before, `requests=${reqDuringImport}`);

  // back to 1TIM via mmCIF file
  await page.setInputFiles('#file', join(ROOT, 'public/samples/1TIM.cif'));
  await page.waitForFunction(() => window.molart.info()?.id === '1TIM', null, { timeout: 30000 * SLOW });
  await page.evaluate(() => window.molart.resetCamera());
  const cam0 = await page.evaluate(() => window.molart.getCamera());

  // style switching via keyboard, with rotation and zoom by mouse
  const box = await page.locator('#view').boundingBox();
  const styles = await page.evaluate(() => window.molart.styles().map((s) => s.id));
  for (let i = 0; i < styles.length; i++) {
    await page.locator('#view').click({ position: { x: 20, y: 20 }, force: true });   // focus only: on a slow software renderer the canvas never counts as 'stable'
    if (i < 10) await page.keyboard.press(i === 9 ? '0' : String(i + 1));
    else await page.locator(`[data-style="${styles[i]}"]`).click();
    const pressed = await page.locator(`[data-style="${styles[i]}"]`).getAttribute('aria-pressed');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 25, { steps: 6 });
    await page.mouse.up();
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(150);
    check(`style ${styles[i]}: selectable (${i < 10 ? 'keyboard' : 'click'}), rotate + zoom`, pressed === 'true');
  }
  const camMoved = await page.evaluate(() => window.molart.getCamera());
  check('mouse interaction moved the camera', JSON.stringify(camMoved) !== JSON.stringify(cam0));

  // Dalí opt-in deformation is labelled; coordinates never change
  await page.evaluate(() => window.molart.setStyle('dali'));
  await page.evaluate(() => window.molart.setDeform(0));
  const warnHidden0 = await page.locator('#deformWarn').isHidden();
  await page.evaluate(() => window.molart.setDeform(0.8));
  const warnVisible = await page.locator('#deformWarn').isVisible();
  check('Dalí melt is opt-in and labelled as artistic', warnHidden0 && warnVisible);
  await page.evaluate(() => window.molart.exportStats(256, 256));
  const fp1 = await page.evaluate(() => window.molart.fingerprint());
  check('atomic coordinates bit-identical after all styles + melt', fp1 === fp0, `${fp0} → ${fp1}`);
  await page.evaluate(() => window.molart.setDeform(0));

  // Picasso opt-in shifted viewpoints: off by default, changes the picture, labelled, coordinates untouched
  const pic = await page.evaluate(async () => {
    const m = window.molart;
    m.setStyle('picasso');
    const a = await m.exportPNGBase64(256, 256);
    m.setDeform(0.8);
    const b = await m.exportPNGBase64(256, 256);
    const warn = !document.getElementById('deformWarn').classList.contains('hidden');
    const title = document.getElementById('deformTitle').textContent;
    const fp = m.fingerprint();
    m.setDeform(0);
    const c = await m.exportPNGBase64(256, 256);
    return { changed: a !== b, back: a === c, warn, title, fp };
  });
  check('Picasso shifted viewpoints are opt-in, labelled and reversible', pic.changed && pic.back && pic.warn && /Viewpoints/.test(pic.title), JSON.stringify({ ...pic, fp: undefined }));
  check('atomic coordinates bit-identical after shifted viewpoints', pic.fp === fp0);

  // Art mode: off by default, changes the drawn shapes for styles that define a form, labelled, reversible, coordinates untouched
  const artm = await page.evaluate(async () => {
    const m = window.molart;
    m.setStyle('mondrian');
    const off0 = !document.getElementById('artToggle').checked;
    const a = await m.exportPNGBase64(256, 256);
    m.setArtMode(true);
    const b = await m.exportPNGBase64(256, 256);
    const warn = !document.getElementById('artWarn').classList.contains('hidden');
    m.setStyle('normal');   // no art form: same picture in both modes, no warning
    const k1 = await m.exportPNGBase64(256, 256);
    const warnK = !document.getElementById('artWarn').classList.contains('hidden');
    const fp = m.fingerprint();
    m.setArtMode(false);
    const k0 = await m.exportPNGBase64(256, 256);
    m.setStyle('mondrian');
    const c = await m.exportPNGBase64(256, 256);
    return { off0, changed: a !== b, back: a === c, warn, klimtSame: k0 === k1, warnK, fp };
  });
  check('art mode is opt-in, labelled and reversible', artm.off0 && artm.changed && artm.back && artm.warn, JSON.stringify({ ...artm, fp: undefined }));
  check('art mode leaves styles without an art form unchanged', artm.klimtSame && !artm.warnK);
  check('atomic coordinates bit-identical after art mode', artm.fp === fp0);

  // revert to scientific at unchanged camera
  const camA = await page.evaluate(() => window.molart.getCamera());
  await page.keyboard.press('1');
  const camB = await page.evaluate(() => window.molart.getCamera());
  check('switching back to scientific keeps camera', JSON.stringify(camA) === JSON.stringify(camB));

  // exports: opaque white, correct size
  await page.evaluate((c) => window.molart.setCamera(c), cam0);
  for (const [style, n] of [['normal', 2048], ['schiele', 2048], ['klimt', 4096]]) {
    await page.evaluate((s) => window.molart.setStyle(s), style);
    const t0 = Date.now();
    const st = await page.evaluate((n) => window.molart.exportStats(n, n), n);
    const white = st.corners.every((c) => c.join() === '255,255,255,255');
    check(`export ${style} ${n}×${n}: corners white, alpha 255, protein visible`, white && st.minAlpha === 255 && st.nonWhiteFraction > 0.02, `nonWhite=${st.nonWhiteFraction.toFixed(3)} ${Date.now() - t0}ms`);
  }
  // PNG file itself is opaque (decode the exported PNG in the page)
  const png = await page.evaluate(async () => {
    const b64 = await window.molart.exportPNGBase64(2048, 2048);
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, 1, 1).data;
    return { w: img.width, h: img.height, corner: Array.from(d), bytes: b64.length };
  });
  check('exported PNG decodes at 2048×2048 with opaque white corner', png.w === 2048 && png.h === 2048 && png.corner.join() === '255,255,255,255');

  // every style must actually draw the protein (catches GLSL compile failures, which render blank)
  await page.evaluate((c) => window.molart.setCamera(c), cam0);
  const blank = [];
  for (const id of styles) {
    await page.evaluate((s) => window.molart.setStyle(s), id);
    const st = await page.evaluate(() => window.molart.exportStats(300, 300));
    if (st.nonWhiteFraction < 0.03) blank.push(`${id}=${st.nonWhiteFraction.toFixed(3)}`);
  }
  check('every style draws the protein (no blank renders)', blank.length === 0, blank.join(' '));

  // determinism / seed reproducibility
  await page.evaluate(() => window.molart.setStyle('schiele'));
  await page.evaluate(() => window.molart.setSeed(7));
  const h1 = (await page.evaluate(() => window.molart.exportStats(800, 800))).hash;
  const h2 = (await page.evaluate(() => window.molart.exportStats(800, 800))).hash;
  await page.evaluate(() => window.molart.setSeed(8));
  const h3 = (await page.evaluate(() => window.molart.exportStats(800, 800))).hash;
  await page.evaluate(() => window.molart.setSeed(7));
  const h4 = (await page.evaluate(() => window.molart.exportStats(800, 800))).hash;
  check('same seed + camera reproduces identical pixels', h1 === h2 && h1 === h4, `${h1} ${h2} ${h4}`);
  check('different seed changes the marks', h1 !== h3);

  // colour choice (Glass): changes pixels, is restorable, and never touches coordinates
  await page.evaluate(() => window.molart.setStyle('glass'));
  const g1 = (await page.evaluate(() => window.molart.exportStats(800, 800))).hash;
  await page.evaluate(() => window.molart.setColors('#5cc8e8', '#4a6cf0'));
  const g2 = (await page.evaluate(() => window.molart.exportStats(800, 800))).hash;
  await page.evaluate(() => window.molart.setColors(null));
  const g3 = (await page.evaluate(() => window.molart.exportStats(800, 800))).hash;
  check('glass colour choice changes the render and Default restores it', g1 !== g2 && g1 === g3, `${g1} ${g2} ${g3}`);
  check('coordinates unchanged by colour choice', (await page.evaluate(() => window.molart.fingerprint())) === fp0);

  // Transparent export through the browser UI, including transmission inside the glass.
  const more = page.getByRole('button', { name: 'More', exact: true });
  await more.click();
  const transparent = page.getByRole('checkbox', { name: 'Transparent background' });
  await transparent.check();
  await page.getByRole('combobox', { name: 'Export size' }).selectOption('1024');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const glassPNG = await page.locator('.exportbox img').evaluate(async (img) => {
    await img.decode();
    const canvas = document.createElement('canvas');
    const w = canvas.width = img.naturalWidth;
    const h = canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, w, h).data;
    const alpha = (x, y) => pixels[(y * w + x) * 4 + 3];
    let translucent = 0;
    for (let y = 5; y < h - 5; y++) {
      for (let x = 5; x < w - 5; x++) {
        const a = alpha(x, y);
        if (a > 16 && a < 239 && alpha(x - 5, y) && alpha(x + 5, y) && alpha(x, y - 5) && alpha(x, y + 5)) translucent++;
      }
    }
    return { w, h, corners: [alpha(0, 0), alpha(w - 1, 0), alpha(0, h - 1), alpha(w - 1, h - 1)], translucent };
  });
  check('transparent Glass PNG has clear corners and translucent interior pixels',
    glassPNG.w === 1024 && glassPNG.h === 1024 && glassPNG.corners.every((a) => a === 0) && glassPNG.translucent > 250,
    JSON.stringify(glassPNG));
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await more.click();
  await transparent.uncheck();
  await page.getByRole('combobox', { name: 'Export size' }).selectOption('2048');
  await page.keyboard.press('Escape');

  // mark stability: a 0.5° rotation should change few pixels (marks travel with the protein)
  const stability = await page.evaluate(async () => {
    const m = window.molart;
    const c = m.getCamera();
    const rot = (deg) => {
      const a = (deg * Math.PI) / 180;
      const p = c.position.map((v, i) => v - c.target[i]);
      const u = c.up;
      // rotate p about up axis
      const cos = Math.cos(a), sin = Math.sin(a);
      const dot = p[0] * u[0] + p[1] * u[1] + p[2] * u[2];
      const cr = [u[1] * p[2] - u[2] * p[1], u[2] * p[0] - u[0] * p[2], u[0] * p[1] - u[1] * p[0]];
      const r = p.map((v, i) => v * cos + cr[i] * sin + u[i] * dot * (1 - cos));
      return { ...c, position: r.map((v, i) => v + c.target[i]) };
    };
    const grab = (cam) => {
      m.setCamera(cam);
      return document.createElement('canvas') && window.__px(600);
    };
    window.__px = (n) => {
      const st = m.exportStats(n, n);
      return st;
    };
    const out = {};
    for (const style of window.molart.styles().map((x) => x.id)) {
      m.setStyle(style);
      // render raw pixels twice with a tiny rotation, compare
      m.setCamera(c);
      const a = await m.exportPNGBase64(600, 600);
      m.setCamera(rot(0.5));
      const b = await m.exportPNGBase64(600, 600);
      const dec = async (b64) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = cv.height = 600;
        const g = cv.getContext('2d');
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, 600, 600).data;
      };
      const A = await dec(a), B = await dec(b);
      // Count strong changes only in *interior* pixels (flat neighbourhood in frame A): edges always
      // move under rotation, but anchored marks must not flip inside surfaces (= flicker / popping).
      let changed = 0, prot = 0;
      const W = 600;
      const lum = (P, i) => P[i] + P[i + 1] + P[i + 2];
      for (let y = 1; y < W - 1; y++)
        for (let x = 1; x < W - 1; x++) {
          const i = (y * W + x) * 4;
          if (!(A[i] < 250 || A[i + 1] < 250 || A[i + 2] < 250)) continue;
          let flat = true;
          for (const j of [i - 4, i + 4, i - 4 * W, i + 4 * W]) if (Math.abs(lum(A, j) - lum(A, i)) > 45) flat = false;
          if (!flat) continue;
          prot++;
          if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 120) changed++;
        }
      out[style] = changed / prot;
    }
    m.setCamera(c);
    void grab;
    return out;
  });
  const base = stability.normal;
  for (const [style, f] of Object.entries(stability)) {
    if (style === 'normal') continue;
    if (style === 'asciifold') {
      // The character grid is tied to the picture by design, so characters change as the protein turns.
      console.log(`NOTE  asciifold: anchored-marks rotation check not applicable (screen-space text grid), ${(f * 100).toFixed(1)}% changed`);
      continue;
    }
    check(`${style}: 0.5° rotation — interior pixels stable like the plain cartoon (marks anchored, no flicker)`, f < base * 2 + 0.02, `${(f * 100).toFixed(1)}% vs scientific ${(base * 100).toFixed(1)}%`);
  }

  // per-chain styles
  const pc = await page.evaluate(async () => {
    const m = window.molart;
    const info = m.info();
    if (info.chains.length < 2) return { skip: true };
    m.setStyle('normal');
    const fp0 = m.fingerprint();
    const h0 = m.exportStats(500, 500);
    m.setChainStyles({ [info.chains[0]]: 'glass', [info.chains[1]]: 'klimt' });
    const h1 = m.exportStats(500, 500);
    const got = m.getChainStyles();
    const selects = document.querySelectorAll('.targets button[data-chain]:not([data-chain=""])').length;
    const visible = !document.querySelector('.targets').classList.contains('hidden');
    m.setChainStyles(null);
    const h2 = m.exportStats(500, 500);
    return { fp: fp0 === m.fingerprint(), h0, h1, h2, got, selects, visible, n: new Set(info.chains).size };
  });
  if (pc.skip) console.log('NOTE  per-chain styles: not run (loaded structure has one chain)');
  else {
    check('per-chain styles: mixed render differs, clearing restores the single-style render', pc.h1.hash !== pc.h0.hash && pc.h2.hash === pc.h0.hash, `${pc.h0.hash} ${pc.h1.hash} ${pc.h2.hash} ${JSON.stringify(pc.got)}`);
    check('per-chain styles: white opaque background and a selector per chain', pc.h1.minAlpha === 255 && pc.h1.corners.every((c) => c.join() === '255,255,255,255') && pc.selects === pc.n && pc.visible, `${pc.selects} selects`);
    check('coordinates unchanged by per-chain styles', pc.fp);
  }

  // ASCII Fold: same view twice gives the same text; white background kept
  const asc = await page.evaluate(async () => {
    const m = window.molart;
    m.setStyle('normal');
    const n = await m.exportPNGBase64(500, 500);
    m.setStyle('asciifold');
    const a = await m.exportPNGBase64(500, 500), b = await m.exportPNGBase64(500, 500);
    const st = m.exportStats(500, 500);
    return { same: a === b, differs: a !== n, st };
  });
  check('asciifold: deterministic text render, distinct from the plain cartoon', asc.same && asc.differs, JSON.stringify(asc.st).slice(0, 120));

  // style options: Cartoon faces toggle, ASCII Fold text share
  const opt = await page.evaluate(async () => {
    const m = window.molart;
    m.setStyle('toon');
    const fp = m.fingerprint();
    const on = m.exportStats(500, 500).hash;
    const boxShown = !document.getElementById('facesToggle').closest('section').classList.contains('hidden');
    m.setFaces(false);
    const off = m.exportStats(500, 500).hash;
    m.setFaces(true);
    const back = m.exportStats(500, 500).hash;
    m.setStyle('normal');
    const plain = m.exportStats(500, 500).hash;
    m.setStyle('asciifold');
    m.setAsciiAmount(0);
    const a0 = m.exportStats(500, 500);
    m.setAsciiAmount(1);
    const a1 = m.exportStats(500, 500);
    m.setAsciiAmount(0.5);
    const a5 = m.exportStats(500, 500);
    m.setStyle('normal');
    return { on, off, back, boxShown, plain, a0, a1, a5, fp: fp === m.fingerprint() };
  });
  check('cartoon: faces can be turned off and on again', opt.on !== opt.off && opt.on === opt.back && opt.boxShown, `${opt.on} ${opt.off}`);
  check('asciifold: text share slider changes the picture between ribbon only and text only', new Set([opt.a0.hash, opt.a1.hash, opt.a5.hash]).size === 3 && opt.a1.nonWhiteFraction < opt.a0.nonWhiteFraction, `${opt.a0.nonWhiteFraction.toFixed(3)} → ${opt.a1.nonWhiteFraction.toFixed(3)}`);
  check('coordinates unchanged by style options', opt.fp);

  // one way to choose: the style row applies to what is selected (All or one chain)
  if (!pc.skip) {
    await page.evaluate(() => { window.molart.setChainStyles(null); window.molart.setStyle('normal'); });
    await page.locator('.targets button[data-chain="B"]').click();
    await page.locator('[data-style="klimt"]').click();
    const one = await page.evaluate(() => ({ cs: window.molart.getChainStyles(), main: document.querySelector('[data-style="klimt"]').getAttribute('aria-pressed') }));
    await page.locator('.targets button[data-chain=""]').click();
    const mixedMarked = await page.evaluate(() => document.querySelectorAll('.styles [aria-pressed="true"]').length);
    await page.locator('[data-style="glass"]').click();
    const all = await page.evaluate(() => ({ cs: window.molart.getChainStyles(), pressed: document.querySelector('[data-style="glass"]').getAttribute('aria-pressed') }));
    check('style row applies to the selected chain, and "All" makes every chain the same', JSON.stringify(one.cs) === '{"B":"klimt"}' && one.main === 'true' && mixedMarked === 0 && JSON.stringify(all.cs) === '{}' && all.pressed === 'true', JSON.stringify({ one, mixedMarked, all }));
    // the mode switch follows the same selection: Art on one chain only, then "All" makes every chain the same again
    await page.evaluate(() => { window.molart.setArtMode(false); window.molart.setStyle('mondrian'); });
    const sci = await page.evaluate(() => window.molart.exportPNGBase64(256, 256));
    await page.locator('.targets button[data-chain="B"]').click();
    await page.locator('#modeArt').click();
    const mixed = await page.evaluate(async () => ({ png: await window.molart.exportPNGBase64(256, 256), pressed: document.getElementById('modeArt').getAttribute('aria-pressed'), warn: !document.getElementById('artWarn').classList.contains('hidden') }));
    await page.locator('.targets button[data-chain=""]').click();
    const none = await page.evaluate(() => document.querySelectorAll('.mode:not(.targets) [aria-pressed="true"]').length);
    await page.locator('#modeArt').click();
    const full = await page.evaluate(() => window.molart.exportPNGBase64(256, 256));
    await page.locator('#modeScience').click();
    const back = await page.evaluate(() => window.molart.exportPNGBase64(256, 256));
    check('mode switch applies to the selected chain, and "All" sets every chain', mixed.png !== sci && mixed.png !== full && full !== sci && back === sci && mixed.pressed === 'true' && mixed.warn && none === 0, JSON.stringify({ pressed: mixed.pressed, warn: mixed.warn, none, mixedVsSci: mixed.png !== sci, mixedVsFull: mixed.png !== full, back: back === sci }));
    await page.evaluate(() => window.molart.setStyle('normal'));
  }

  // sun: turning it on, turning or colouring it changes the picture; turning it off restores it exactly
  {
    const l = await page.evaluate(async () => {
      const m = window.molart;
      m.setStyle('normal');
      const a = await m.exportPNGBase64(256, 256);
      m.setLight(150, '#ffffff');
      const turned = await m.exportPNGBase64(256, 256);
      m.setLight(0, '#ffb060');
      const tinted = await m.exportPNGBase64(256, 256);
      m.setLight(null);
      return { a, turned, tinted, back: await m.exportPNGBase64(256, 256), fp: m.info().fingerprint };
    });
    check('sun: casts shadows, can be turned and coloured, and off restores the picture', l.turned !== l.a && l.tinted !== l.a && l.tinted !== l.turned && l.back === l.a);
  }

  // memory: clicking through every style in both modes must not pile up meshes
  const mem = await page.evaluate(async () => {
    const m = window.molart;
    let peak = 0;
    for (const art of [true, false]) {
      m.setArtMode(art);
      for (const st of m.styles()) {
        m.setStyle(typeof st === 'string' ? st : st.id);
        peak = Math.max(peak, m.geometryCacheBytes());
      }
    }
    m.setStyle('normal');
    return peak / 1048576;
  });
  check('mesh cache stays bounded across all styles and both modes', mem > 0 && mem < 420, `${mem.toFixed(0)} MB peak`);

  // safe start: a start that follows an unfinished drawing falls back to the scientific view and says so
  const safe = await page.evaluate(() => {
    localStorage.setItem('molart.pending.v1', JSON.stringify({ style: 'klimt', art: true }));
    const s = JSON.parse(localStorage.getItem('molart.settings.v2') || '{}');
    localStorage.setItem('molart.settings.v2', JSON.stringify({ ...s, style: 'klimt', artMode: true }));
    return true;
  });
  {
    // the marker must survive the reload the way it survives a crash (a normal page close clears it)
    await page.addInitScript(() => {
      if (sessionStorage.getItem('crashSim')) return;
      sessionStorage.setItem('crashSim', '1');
      localStorage.setItem('molart.pending.v1', JSON.stringify({ style: 'klimt', art: true }));
    });
    await page.reload();
    await page.waitForFunction(() => window.molart && window.molart.info(), null, { timeout: 60000 * SLOW });
    await page.waitForTimeout(500);
    const st = await page.evaluate(() => ({ pressed: document.querySelector('[data-style="normal"]').getAttribute('aria-pressed'), art: document.getElementById('artToggle').checked, msg: document.querySelector('.error').textContent }));
    check('safe start after an unfinished drawing', safe && st.pressed === 'true' && !st.art && /Klimt/.test(st.msg) && /art mode/.test(st.msg), JSON.stringify(st));
    await page.evaluate(() => localStorage.removeItem('molart.pending.v1'));
  }

  // gallery
  await page.locator('#moreBtn').click();
  await page.getByText('Same-view gallery').click();
  await page.waitForSelector('.gallery img', { timeout: 120000 * SLOW });
  await page.waitForFunction(() => document.querySelectorAll('.gallery img').length === window.molart.styles().length, null, { timeout: 120000 * SLOW });
  check('same-camera gallery shows every style', true);
  await page.screenshot({ path: join(ROOT, 'outputs/ui-gallery.png') });
  await page.keyboard.press('Escape');

  // malformed file
  writeFileSync(join(ROOT, 'outputs/bad.pdb'), 'this is not a structure\n');
  await page.setInputFiles('#file', join(ROOT, 'outputs/bad.pdb'));
  await page.waitForTimeout(300);
  const err = await page.locator('.error').textContent();
  const stillId = await page.evaluate(() => window.molart.info()?.id);
  check('malformed file shows an error and keeps the current structure', /Unrecognised|No ATOM/.test(err ?? '') && stillId === '1TIM', err ?? '');
  // the failed load is a deliberate error path; drop its console message
  const unexpected = errors.filter((e) => !/Unrecognised|No ATOM/.test(e));

  await page.evaluate((c) => window.molart.setCamera(c), cam0);
  await page.keyboard.press('2');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(ROOT, 'outputs/ui.png') });

  check('no JavaScript errors', unexpected.length === 0, unexpected.join(' | '));
  check('no external network requests', external.length === 0, external.join(' '));
} finally {
  await browser.close();
  server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
process.exit(failed.length ? 1 : 0);
