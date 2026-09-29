// Line numbers in generated shaders, translated back to their sources.
//
// tools/build-shaders.mjs links several files under shaders/ into one file
// under gen/. Each source file lands as one contiguous block with its line
// numbers intact (directives are blanked, not removed), so a line in the
// output is a line in exactly one source, at a fixed offset. The build
// records those blocks in the output's last line:
//
//   // sourcemap: [{"path":"shaders/node.wgsl","offset":3,"lines":57}, ...]
//
// offset is the number of output lines before the block, so output line
// offset + n is line n of path.

const MARKER = '// sourcemap: ';

/** The block list from a generated shader's last line, or null if it has none. */
export function readSourceMap(code) {
  const at = code.lastIndexOf(MARKER);
  if (at < 0) return null;
  const end = code.indexOf('\n', at);
  try {
    return JSON.parse(code.slice(at + MARKER.length, end < 0 ? undefined : end));
  } catch {
    return null;
  }
}

/** Where output line `line` (1-based) came from: { path, line }. */
export function mapLine(map, line) {
  for (const block of map ?? []) {
    if (line > block.offset && line <= block.offset + block.lines) {
      return { path: block.path, line: line - block.offset };
    }
  }
  return null;
}
