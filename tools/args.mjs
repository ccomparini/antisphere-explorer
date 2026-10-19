// Command-line options for the tools, read by node's util.parseArgs:
//
//   --name value   --name=value   -n value   -n=value   -nvalue
//   --flag         a boolean: present or not
//   --             the end of the options; what follows is positional
//
// What this adds to parseArgs:
//
//   - type 'number': read as a string, given back as a finite number, or
//     refused ("--fit needs a number, not "big"").
//   - -n=value, for a short option, is its value (parseArgs alone would
//     take "=value").
//   - A value starting with a single - (--fit -1, --up -y) is taken as the
//     value unless it is one of the tool's own short options; parseArgs
//     alone calls it ambiguous and wants --up=-y. A value starting -- still
//     needs the = form.
//   - Errors in the tools' own words: "unknown option --bogus", "--fit needs
//     a value", "--whole takes no value", "unexpected argument x".
//
// parseOptions(argv, {
//   out:  { type: 'string', short: 'o' },
//   fit:  { type: 'number' },
//   rev:  { type: 'string', short: 'r', multiple: true },
//   help: { type: 'boolean', short: 'h' },
// }, { positionals: true })
//   -> { values: { out, fit, rev, help }, positionals: [...] }
//
// An option not given is absent from `values` unless it has a `default`.

import { parseArgs } from 'node:util';

export function parseOptions(argv, options, { positionals = false } = {}) {
  const config = {};
  const shorts = new Set();
  for (const [name, o] of Object.entries(options)) {
    const { type, ...rest } = o;
    config[name] = { ...rest, type: type === 'number' ? 'string' : type };
    if (o.default !== undefined) config[name].default = type === 'number' ? String(o.default) : o.default;
    if (o.short) shorts.add(o.short);
  }

  // "--fit -1" -> "--fit=-1", where -1 is no option of ours; "-n=2" -> "--runs=2".
  const longOf = (short) => Object.keys(options).find((n) => options[n].short === short);
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (/^-[^-]=/.test(arg) && longOf(arg[1])) arg = `--${longOf(arg[1])}${arg.slice(2)}`;
    args.push(arg);
    if (arg === '--') { args.push(...argv.slice(i + 1)); break; }
    const name = arg.startsWith('--') ? arg.slice(2)
      : /^-[^-]$/.test(arg) ? longOf(arg[1]) : undefined;
    const next = argv[i + 1];
    if (name && options[name] && options[name].type !== 'boolean' && next !== undefined
        && /^-[^-]/.test(next) && !shorts.has(next[1])) {
      args[args.length - 1] = `--${name}=${next}`;
      i++;
    }
  }

  let parsed;
  try {
    parsed = parseArgs({ args, options: config, allowPositionals: positionals, strict: true });
  } catch (e) {
    throw new Error(reword(e, options));
  }
  const values = { ...parsed.values };
  for (const [name, o] of Object.entries(options)) {
    if (o.type !== 'number' || values[name] === undefined) continue;
    const number = (v) => {
      const n = Number(v);
      if (v.trim() === '' || !Number.isFinite(n)) throw new Error(`--${name} needs a number, not ${JSON.stringify(v)}`);
      return n;
    };
    values[name] = o.multiple ? values[name].map(number) : number(values[name]);
  }
  return { values, positionals: parsed.positionals };
}

// parseArgs's messages, said shortly, naming the option as written long.
function reword(e, options) {
  const quoted = /'([^']*)'/.exec(e.message)?.[1] ?? '';
  const option = quoted.replace(/ <value>$/, '').split(', ').at(-1);
  switch (e.code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION': return `unknown option ${quoted}`;
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL': return `unexpected argument ${quoted}`;
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      if (/does not take an argument/.test(e.message)) return `${option} takes no value`;
      return `${option} needs a value` +
        (/ambiguous/.test(e.message) ? ` (one starting -- goes as ${option}=...)` : '');
    default: return e.message;
  }
}
