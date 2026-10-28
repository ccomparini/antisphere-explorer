// What a tool is told a scene is, as the URL readScene() reads it by
// (public/antisphere-scene.js): a URL as given, http(s) or file:; else a
// file, if there is one; else a name under public/scenes. So every tool
// reads a scene as the page does - references, .gz, an STL on its own - and
// a URL too.
//
//   const { spec, files, path } = await readScene(sceneURL(name));

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCENES = fileURLToPath(new URL('../public/scenes/', import.meta.url));

export const isURL = (name) => /^[a-z][a-z0-9+.-]*:\/\//i.test(name);

/**
 * The URL of the scene `name` names: a URL as given; a file that exists, as
 * a file: URL; else `name` under `scenes` (public/scenes by default). The
 * error, if none of those, says where it looked.
 */
export function sceneURL(name, { scenes = SCENES } = {}) {
  if (isURL(name)) return name;
  if (existsSync(name)) return pathToFileURL(path.resolve(name)).href;
  const under = path.join(scenes, name);
  if (existsSync(under)) return pathToFileURL(under).href;
  throw new Error(`no scene ${name}, as a file or in ${path.relative(process.cwd(), scenes) || scenes}`);
}
