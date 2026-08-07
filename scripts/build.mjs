// scripts/build.mjs
// Builds the Firefox extension into ./dist
//   - Bundles src/background.js (+ @huggingface/transformers) into dist/background.js
//   - Copies the static extension files (manifest, content scripts, popup, options, icons)
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OUT_DIR = fileURLToPath(new URL('../dist/', import.meta.url));

console.log('▶ Cleaning dist/');
await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

console.log('▶ Bundling background worker (Transformers.js + AI logic)…');
await build({
  entryPoints: ['src/background.js'],
  bundle: true,
  format: 'iife',        // classic script that runs in an MV3 event-page worker
  platform: 'browser',
  target: ['firefox128'],
  outfile: join(OUT_DIR, 'background.js'),
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info'
});

console.log('▶ Copying static files…');
for (const file of ['manifest.json', 'rules.js', 'content.js']) {
  await cp(join('static', file), join(OUT_DIR, file));
}
for (const dir of ['popup', 'options', 'icons']) {
  await cp(join('static', dir), join(OUT_DIR, dir), { recursive: true });
}

console.log('▶ Done. Load the "dist" folder as a temporary add-on in Firefox.');