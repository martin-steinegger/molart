# molart

**Website: https://martin-steinegger.github.io/molart/**

Artist-inspired renderings of real protein, DNA and RNA structures, in the browser.

<img src="docs/molart.gif" alt="molart drawing the same protein in many styles" width="360">

molart loads a PDB or mmCIF file, draws the usual cartoon, and then redraws the same structure in 21 styles.

## Inspired by great artists

Egon Schiele, Pablo Picasso, Gustav Klimt, Vincent van Gogh, Salvador Dalí, Claude Monet,
Katsushika Hokusai, Georgia O'Keeffe, Andy Warhol, Jackson Pollock, Wassily Kandinsky,
Henri Matisse, Piet Mondrian and Leonardo da Vinci, and the sumi-e ink tradition.

The styles are a tribute, not the artists' work: each is our own reimagination, drawn by code.

Further styles: glass, frosted, cartoon, surface and ASCII.

## Features

- **Coordinates never change.** Every effect lives in display geometry and shaders.
- **Science | Art.** Science mode keeps the ribbon geometry; art mode (opt-in, labelled) lets a
  style reshape the drawn ribbon.
- **Per chain.** Each chain can have its own style and mode.
- **DNA and RNA.** Nucleic acids are drawn as a backbone band through the phosphates with a slab
  for every base, alone or next to protein. Art mode does not reshape them.
- **Local.** Files you open stay in your browser. Fetching by PDB ID is an explicit button and
  goes to files.rcsb.org.
- **Export.** White-background PNG up to 4K.

## Run

Requires Node 20 or newer.

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

## Command line

Renders with the same code as the app, in headless Chromium
(`npx playwright-core install chromium`).

```sh
node cli/molart.mjs render public/samples/1TIM.cif --style klimt --width 2400 --height 2400 --output klimt.png
node cli/molart.mjs gallery public/samples/1TIM.cif --size 2048 --output-dir outputs/
node cli/molart.mjs styles
```


## Credits

- molart was inspired by Sergey Ovchinnikov's protein structure visualization in
  [LocalFold](https://github.com/sokrypton/localfold).
- The Scientific style follows Jane Richardson's hand-drawn ribbon diagrams (1981).
- The Glass style is inspired by a protein rendering in a
  [LinkedIn post](https://www.linkedin.com/feed/update/urn:li:activity:7526936072279212032/) by Latent Labs.
- The ASCII style is inspired by [ascii-fold](https://github.com/mitsenkov/ascii-fold) by
  Maxim Tsenkov.

## License

MIT, see [LICENSE](LICENSE).
