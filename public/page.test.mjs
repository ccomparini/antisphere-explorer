// Tests for page.js, on stand-in elements: no browser. Run with:
//   node --test public/page.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPage, noteIn } from './page.js';

const element = () => ({ textContent: '', hidden: true, style: {} });

test('runPage: a page that fails shows why in #err, in place of the page, and throws on', async () => {
  const err = element(), app = element();
  globalThis.document = { getElementById: (id) => (id === 'err' ? err : null) };
  await assert.rejects(runPage(async () => { throw new Error('no usable GPU'); }, { hide: app }),
                       /no usable GPU/, 'thrown on, for the console');
  assert.equal(err.textContent, 'no usable GPU');
  assert.equal(err.hidden, false);
  assert.equal(err.style.display, 'grid');
  assert.equal(app.style.display, 'none');
  delete globalThis.document;
});

test('noteIn: a note shows, green or red, and clears itself - later if bad', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const line = element();
  const note = noteIn(line);
  note('saved');
  assert.equal(line.textContent, 'saved');
  assert.equal(line.style.color, '#4ade80');
  t.mock.timers.tick(1600);
  assert.equal(line.textContent, '', 'cleared');
  note('reload failed', true);
  assert.equal(line.style.color, '#f87171');
  t.mock.timers.tick(1600);
  assert.equal(line.textContent, 'reload failed', 'still there');
  note('again', true);                     // a new note restarts the clock
  t.mock.timers.tick(5999);
  assert.equal(line.textContent, 'again');
  t.mock.timers.tick(1);
  assert.equal(line.textContent, '');
});
