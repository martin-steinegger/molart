#!/usr/bin/env node
// molart CLI — renders through the same browser renderer as the app (headless Chromium),
// so CLI output matches the interactive viewer. Structure files are read locally and passed
// into the page; nothing is uploaded anywhere.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { launch, openApp, serveStatic } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `molart — artist-inspired renderings of real protein structures

usage:
  molart render  <file.pdb|.cif> --style <id> [--width 2400] [--height 2400] [--seed 42]
                 [--deform 0..1] [--colors '#aaaaaa,#bbbbbb'] [--camera cam.json] [--chains A,B]
                 [--chain-styles A=glass,B=klimt] [--no-faces] [--ascii 0..1] [--art]
                 [--transparent]
                 [--output out.png]
  molart gallery <file.pdb|.cif> [--styles normal,schiele,picasso,klimt,vangogh,dali]
                 [--size 1024] [--seed 42] [--deform 0..1] [--camera cam.json] [--chains A]
                 [--output-dir outputs/]
  molart styles

options:
  --background must be #ffffff (exports are opaque white unless --transparent is given); other values are rejected.
  --transparent  write the PNG without the white paper (alpha channel); laid over white it is the normal picture.
  --camera     JSON {position,target,up,fov} as produced by "Copy camera" in the app.
  --chains     frame the camera on these chains (all chains are still drawn).
  --chain-styles  give chains their own style (chain id = style id); other chains use --style.
  --no-faces   Cartoon style: plain ribbons without faces, heads and arms.
  --art        Art mode: styles that define one draw simplified or reshaped forms instead of the true ribbon.
  --ascii      ASCII Fold style: share of the picture drawn as text, 0 (ribbon only) .. 1 (text only); default 0.5.
  --colors     two hex colours for styles with a colour choice (glass): helices/strands, loops/edges.
  --deform     artistic deformation for deformable styles (Dalí: melt; Picasso: shifted viewpoints); 0 = scientific geometry.
`;

function parseChainStyles(v) {
  const out = {};
  for (const part of String(v).split(',')) {
    const m = /^([^=]+)=([a-z0-9]+)$/i.exec(part.trim());
    if (!m) throw new Error(`--chain-styles expects chain=style pairs, e.g. --chain-styles A=glass,B=klimt (got "${v}")`);
    out[m[1]] = m[2];
  }
  return out;
}
function parseColors(v) {
  const c = String(v).split(',').map((x) => (x.startsWith('#') ? x : '#' + x));
  if (c.length !== 2 || !c.every((x) => /^#[0-9a-f]{6}$/i.test(x))) throw new Error(`--colors expects two hex colours, e.g. --colors '#5cc8e8,#4a6cf0' (got "${v}")`);
  return c;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

function ensureBuilt() {
  const dist = join(ROOT, 'dist', 'index.html');
  if (!existsSync(dist)) {
    console.error('molart: building app (first run)…');
    execSync('npx vite build --logLevel error', { cwd: ROOT, stdio: 'inherit' });
  }
  return join(ROOT, 'dist');
}

async function withPage(fn) {
  const server = await serveStatic(ensureBuilt());
  const { browser, page, errors } = await launch();
  try {
    await openApp(page, server.url);
    return await fn(page, errors);
  } finally {
    await browser.close();
    server.close();
  }
}

async function prepare(page, args, file) {
  const text = readFileSync(file, 'utf8');
  const info = await page.evaluate(([t, n]) => window.molart.loadText(t, n), [text, basename(file)]);
  await page.evaluate(([seed, deform]) => {
    window.molart.setSeed(seed);
    window.molart.setDeform(deform);
  }, [parseInt(args.seed ?? '42', 10), parseFloat(args.deform ?? '0')]);
  if (args['no-faces']) await page.evaluate(() => window.molart.setFaces(false));
  await page.evaluate((on) => window.molart.setArtMode(on), !!args.art);
  if (args.ascii !== undefined) {
    const v = parseFloat(args.ascii);
    if (!(v >= 0 && v <= 1)) throw new Error(`--ascii expects a number from 0 to 1 (got "${args.ascii}")`);
    await page.evaluate((x) => window.molart.setAsciiAmount(x), v);
  }
  if (args.chains) await page.evaluate((c) => window.molart.frameChains(c.split(',')), args.chains);
  else await page.evaluate(() => window.molart.resetCamera());
  if (args.camera) await page.evaluate((c) => window.molart.setCamera(c), JSON.parse(readFileSync(args.camera, 'utf8')));
  return info;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help) return console.log(USAGE);
  if (args.background && args.background.toLowerCase() !== '#ffffff') throw new Error('Only --background #ffffff is supported (protein on pure white).');

  if (cmd === 'styles') {
    const styles = await withPage((page) => page.evaluate(() => window.molart.styles()));
    for (const s of styles) console.log(`${s.id.padEnd(9)} ${s.label.padEnd(11)} ${s.technique}`);
    return;
  }
  const file = args._[1];
  if (!file || !existsSync(file)) throw new Error(`Structure file not found: ${file ?? '(missing)'}\n\n${USAGE}`);

  if (cmd === 'render') {
    const w = parseInt(args.width ?? '2400', 10), h = parseInt(args.height ?? args.width ?? '2400', 10);
    const style = args.style ?? 'normal';
    const out = args.output ?? `${basename(file).replace(/\.[^.]+$/, '')}-${style}.png`;
    await withPage(async (page, errors) => {
      const info = await prepare(page, args, file);
      await page.evaluate((s) => window.molart.setStyle(s), style);
      if (args['chain-styles']) {
        const cs = parseChainStyles(args['chain-styles']);
        const info = await page.evaluate(() => window.molart.info());
        for (const c of Object.keys(cs)) if (!info.chains.includes(c)) throw new Error(`--chain-styles: no chain "${c}" in this structure (chains: ${info.chains.join(', ')})`);
        await page.evaluate((m) => window.molart.setChainStyles(m), cs);
      }
      if (args.colors) await page.evaluate((c) => window.molart.setColors(c[0], c[1]), parseColors(args.colors));
      const b64 = await page.evaluate(([W, H, T]) => window.molart.exportPNGBase64(W, H, { transparent: T }), [w, h, !!args.transparent]);
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(out, Buffer.from(b64, 'base64'));
      const cam = await page.evaluate(() => window.molart.getCamera());
      console.log(JSON.stringify({ output: out, width: w, height: h, style, seed: parseInt(args.seed ?? '42', 10), structure: info.id, fingerprint: info.fingerprint, camera: cam }));
      if (errors.length) throw new Error('Browser errors:\n' + errors.join('\n'));
    });
    return;
  }

  if (cmd === 'gallery') {
    const size = parseInt(args.size ?? '1024', 10);
    const outDir = args['output-dir'] ?? 'outputs';
    mkdirSync(outDir, { recursive: true });
    await withPage(async (page, errors) => {
      const info = await prepare(page, args, file);
      const ids = (args.styles ?? (await page.evaluate(() => window.molart.styles().map((s) => s.id)).then((x) => x.join(',')))).split(',');
      const tiles = [];
      for (const id of ids) {
        await page.evaluate((s) => window.molart.setStyle(s), id);
        if (args.colors) await page.evaluate((c) => window.molart.setColors(c[0], c[1]), parseColors(args.colors));
        const b64 = await page.evaluate(([n]) => window.molart.exportPNGBase64(n, n), [size]);
        const p = join(outDir, `${info.id}-${id}.png`);
        writeFileSync(p, Buffer.from(b64, 'base64'));
        tiles.push({ id, b64 });
        console.log(p);
      }
      // same-camera comparison sheet; labels sit below each artwork, never inside it
      const labels = await page.evaluate(() => Object.fromEntries(window.molart.styles().map((s) => [s.id, s.label])));
      const sheet = await page.evaluate(
        async ([tiles, size, labels, deform]) => {
          const cols = Math.min(3, tiles.length), rows = Math.ceil(tiles.length / cols), lab = Math.round(size * 0.07);
          const c = document.createElement('canvas');
          c.width = cols * size;
          c.height = rows * (size + lab);
          const g = c.getContext('2d', { alpha: false });
          g.fillStyle = '#fff';
          g.fillRect(0, 0, c.width, c.height);
          g.fillStyle = '#5b524b';
          g.font = `${Math.round(lab * 0.42)}px system-ui, sans-serif`;
          g.textAlign = 'center';
          for (let i = 0; i < tiles.length; i++) {
            const img = new Image();
            img.src = 'data:image/png;base64,' + tiles[i].b64;
            await img.decode();
            const x = (i % cols) * size, y = Math.floor(i / cols) * (size + lab);
            g.drawImage(img, x, y);
            const extra = tiles[i].id === 'dali' && deform > 0 ? ' — artistic deformation' : '';
            g.fillText((labels[tiles[i].id] ?? tiles[i].id) + extra, x + size / 2, y + size + lab * 0.6);
          }
          return c.toDataURL('image/png').split(',')[1];
        },
        [tiles, size, labels, parseFloat(args.deform ?? '0')],
      );
      const p = join(outDir, `comparison-${info.id}.png`);
      writeFileSync(p, Buffer.from(sheet, 'base64'));
      console.log(p);
      if (errors.length) throw new Error('Browser errors:\n' + errors.join('\n'));
    });
    return;
  }
  throw new Error(`Unknown command "${cmd}".\n\n${USAGE}`);
}

main().catch((e) => {
  console.error('molart:', e.message);
  process.exit(1);
});
