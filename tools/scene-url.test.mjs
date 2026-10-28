// Tests for tools/scene-url.mjs: what a tool is told a scene is, as a URL.
// Run with:
//   node --test tools/scene-url.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sceneURL, SCENES } from './scene-url.mjs';

test('a URL as given; a file as a file: URL; else a name under public/scenes; else, where it looked', () => {
  assert.equal(sceneURL('https://example.com/models/scene.json'), 'https://example.com/models/scene.json');
  assert.equal(sceneURL('file:///tmp/x.json'), 'file:///tmp/x.json');
  const dir = mkdtempSync(join(tmpdir(), 'scene-url-'));
  writeFileSync(join(dir, 'mine.json'), '{}');
  assert.equal(sceneURL(join(dir, 'mine.json')), pathToFileURL(join(dir, 'mine.json')).href, 'a file, wherever it is');
  assert.equal(sceneURL('scene.json'), pathToFileURL(join(SCENES, 'scene.json')).href, 'a name, under public/scenes');
  assert.equal(sceneURL('mine.json', { scenes: dir }), pathToFileURL(join(dir, 'mine.json')).href, 'or under another');
  assert.throws(() => sceneURL('none.json'), /no scene none\.json, as a file or in .*public\/scenes/);
});
