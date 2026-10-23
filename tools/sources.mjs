// What the import tools read from: a file or a URL, gzipped or not, or a
// file inside a tar archive (gzipped or not) - named after a #, or, if the
// archive holds only one file of the kind wanted, that one.
//
//   const source = await openSource('https://example.com/models.tar.gz#dir/model.glb',
//                                   { kind: /\.(glb|gltf)$/i, say });
//   source.bytes          the file's bytes, unzipped
//   source.file           its name, without directories or .gz
//   source.besideIt(uri)  the bytes of a file beside it (a .gltf's buffers),
//                         from the same place: a URL's directory, or a file's

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const isURL = (path) => /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
const isRemote = (location) => isURL(location) && !location.startsWith('file:');
const isGzipped = (bytes) => bytes[0] === 0x1f && bytes[1] === 0x8b;
const isTar = (bytes) => new TextDecoder().decode(bytes.subarray(257, 262)) === 'ustar';

/** The files in a tar archive, as a Map of name to bytes. */
function untar(bytes) {
  const files = new Map();
  const text = (at, length) => {
    const field = bytes.subarray(at, at + length);
    const end = field.indexOf(0);
    return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end));
  };
  let at = 0;
  while (at + 512 <= bytes.length && bytes[at] !== 0) {
    const name = text(at, 100);
    const size = parseInt(text(at + 124, 12).trim() || '0', 8);
    const type = text(at + 156, 1);
    const prefix = text(at + 345, 155);
    if (type === '0' || type === '') {
      files.set(prefix ? `${prefix}/${name}` : name, bytes.subarray(at + 512, at + 512 + size));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * A source, opened: { bytes, file, besideIt }. `kind`, a pattern for the
 * file names wanted, picks the one file of that kind in an archive named
 * without a member; `what` names them in messages ("meshes").
 */
export async function openSource(source, { kind, what = 'files', say = () => {} } = {}) {
  const hash = source.indexOf('#');
  const location = hash < 0 ? source : source.slice(0, hash);
  const member = hash < 0 ? null : decodeURIComponent(source.slice(hash + 1));
  let bytes;
  if (isRemote(location)) {
    say(`fetching ${location}`);
    bytes = await fetchBytes(location);
  } else {
    bytes = new Uint8Array(readFileSync(location.startsWith('file:') ? fileURLToPath(location) : location));
  }
  let file = location.split(/[?]/)[0].split('/').pop();
  if (isGzipped(bytes)) {
    bytes = new Uint8Array(gunzipSync(bytes));
    file = file.replace(/\.t?gz$/i, (ext) => (ext.toLowerCase() === '.tgz' ? '.tar' : ''));
  }
  if (isTar(bytes)) {
    const files = untar(bytes);
    const candidates = [...files.keys()].filter((name) => kind.test(name.replace(/\.gz$/i, '')));
    const chosen = member ?? (candidates.length === 1 ? candidates[0] : null);
    if (!chosen) {
      throw new Error(`${location} holds ${candidates.length ? `${candidates.length} ${what}` : `no ${what}`}; ` +
                      `name one after a #${candidates.length ? `:\n  ${candidates.join('\n  ')}` : ''}`);
    }
    if (!files.has(chosen)) throw new Error(`${location} has no ${chosen}`);
    bytes = files.get(chosen);
    file = chosen.split('/').pop();
    if (isGzipped(bytes)) {
      bytes = new Uint8Array(gunzipSync(bytes));
      file = file.replace(/\.gz$/i, '');
    }
  } else if (member) {
    throw new Error(`${location} is not an archive, so it has no ${member} in it`);
  }
  const besideIt = async (uri) => {
    if (isRemote(location)) return fetchBytes(new URL(uri, location).href);
    const local = location.startsWith('file:') ? fileURLToPath(location) : location;
    return new Uint8Array(readFileSync(path.join(path.dirname(local), uri)));
  };
  return { bytes, file, besideIt };
}
