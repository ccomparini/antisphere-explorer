#!/usr/bin/env node

//
// Reformatter for json files in this project.  Reformats
// json files in-place.
//
// The goal is readable diffs (and readable json).
//
// Usage:
//
//  node tools/reformat-json.mjs [ file1.json ] [ file2.json ] ...
// 
//
import * as fs from 'node:fs';
import { stringifyJSON, verifyJSON } from '../public/fbm-json.js';

function main(argv) {
  const sources = [ ];
  for (const srcname of argv) {
    const src = fs.readFileSync(srcname);
    const formatted = stringifyJSON(JSON.parse(src));
    verifyJSON(src, formatted);
    fs.writeFileSync(srcname, formatted);
  }
}

main(process.argv.slice(2));

