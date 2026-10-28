// Reading files by URL: the page's, fetched, and - in Node, for the tools
// and tests - a file: URL's, from disk. Nothing here needs a GPU: what reads
// a scene (readScene() in antisphere-scene.js) or a shader (ASContext) comes
// here for its bytes.
//
// A file: URL is read through a dynamic import of node:fs, which only a
// file: URL reaches, so a browser never loads it (Node's fetch reads no
// file: URLs). Every other URL is fetched, bypassing the cache so that hot
// reload sees edits.

const isFileURL = (url) => /^file:/i.test(String(url));

// node:fs's readFile, loaded the first time a file: URL is read.
let readFromDisk = null;
async function fromDisk(url) {
  readFromDisk ??= (await import('node:fs/promises')).readFile;
  try {
    return await readFromDisk(new URL(url));
  } catch (error) {
    throw new Error(`${url}: ${error.code === 'ENOENT' ? 'no such file' : error.message}`);
  }
}

/** A file's text: fetched, uncached; a file: URL from disk. */
export async function loadText(url) {
  if (isFileURL(url)) return (await fromDisk(url)).toString('utf8');
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

/** The same, as bytes (an ArrayBuffer): for files that aren't text, such as an STL mesh. */
export async function loadBytes(url) {
  if (isFileURL(url)) {
    const b = await fromDisk(url);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.arrayBuffer();
}
