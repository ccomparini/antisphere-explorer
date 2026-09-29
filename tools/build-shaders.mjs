// Builds the shaders: shaders/*.wgsl (with #import and #if) into plain WGSL
// under public/gen/, plus JS classes for the structs they share with JS.
//
//   node tools/build-shaders.mjs            build once
//   node tools/build-shaders.mjs --watch    rebuild whenever shaders/ changes
//
// What gets built is shaders/build.json; the language and the output are
// described in tools/shader-build/. Files whose content is unchanged are not
// rewritten, so their timestamps only move when they really change.
//
// With --watch running, the page's R reloads the new shaders. A change to a
// shared struct's layout also changes the generated JS, which needs a full
// page reload.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll } from './shader-build/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = 'shaders/build.json';

async function buildOnce() {
  const config = JSON.parse(await readFile(join(ROOT, CONFIG), 'utf8'));
  const files = await buildAll(config, (path) => readFile(join(ROOT, path), 'utf8'));
  let written = 0;
  for (const { path, content } of files) {
    const full = join(ROOT, path);
    const old = await readFile(full, 'utf8').catch(() => null);
    if (old === content) continue;
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    written++;
    console.log(`wrote ${path}`);
  }
  if (!written) console.log(`${files.length} files up to date`);
}

if (!process.argv.includes('--watch')) {
  try {
    await buildOnce();
  } catch (e) {
    console.error(`shader build failed: ${e.message}`);
    process.exit(1);
  }
} else {
  let timer = null, running = false, again = false;
  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      await buildOnce();
    } catch (e) {
      console.error(`shader build failed: ${e.message}`);
    }
    running = false;
    if (again) { again = false; run(); }
  };
  // Editors often write a file in several steps; wait for them to settle.
  watch(join(ROOT, 'shaders'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(run, 100);
  });
  console.log('watching shaders/ (Ctrl-C to stop)');
  run();
}
