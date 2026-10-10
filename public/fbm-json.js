//
// Reformatter for json files in this project.
//
// The goal is readable diffs (and readable json).
//

const INDENT = 2;               // spaces
const MAX_ARRAY_LINE_ITEMS = 4; // more than this number of items -> split line

// Turns out I have to reinvent the json-writing wheel here.
// JSON supports objects having method toJSON, but it's misnamed:
// it doesn't convert to json;  it's a serialization filter
// function which returns a proxy/replacement object.
// It also has JSON.rawJSON, which, in theory, takes JSON
// and marks it as such for JSON.stringify so that it doesn't
// get double-encoded, except it also fails because it considers
// any JSON for any compound object to be invalid JSON.
//
// So, yay, I'm reinventing this wheel.

// returns true if all elements in the array (or object?) passed
// are non-compound
function allNonCompound(inArr) {
  return inArr.every(item =>
    item === null ||
    (typeof item !== "object" && typeof item !== "function")
  );
}

export function stringifyJSON(value, indent=INDENT, depth = 0) {
  const pad = " ".repeat(indent * depth);
  const childPad = " ".repeat(indent * (depth + 1));

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map(v => stringifyJSON(v, indent, depth + 1));

    // MAX_ARRAY_LINE_ITEMS is set with the length of 3-vectors
    // and maybe quaternions in mind...
    if (value.length <= MAX_ARRAY_LINE_ITEMS) {
      // .. but if any elements are compound, don't
      // try to cram it all on one line or it gets
      // tangled again.
      if(allNonCompound(value)) {
        return `[ ${items.join(", ")} ]`;
      }
    }

    return `[\n${childPad}${items.join(`,\n${childPad}`)}\n${pad}]`;
  }

  const entries = Object.entries(value).map(
    ([k, v]) => `${JSON.stringify(k)}: ${stringifyJSON(v, indent, depth + 1)}`
  );

  return `{\n${childPad}${entries.join(`,\n${childPad}`)}\n${pad}}`;
}

// verifies that the 2 json strings passed parse and
// are equivalent in what they encode.  Throws if they
// are not.
export function verifyJSON(jsona, jsonb) {
  const restringed = [
    JSON.stringify(JSON.parse(jsona)),
    JSON.stringify(JSON.parse(jsonb))
  ];
  if (restringed[0] != restringed[1]) {
    throw new Error("Rencoding failed.  This is a bug!");
  }
}



