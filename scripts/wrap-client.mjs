/**
 * Wrap tsc's CommonJS emit into the DSH client-bundle envelope.
 *
 * The envelope is fixed by the host loader (ClientModuleSystem.register /
 * .materialize) and reproduced verbatim from dsh's own
 * `packages/client/tsdown.client.ts` banner/intro/footer:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports;
 *     <bundle body>
 *     return module.exports; } });
 *
 * tsdown bundles many source modules into one flat body. tsc cannot bundle, so
 * this script supplies the missing step: each emitted CJS file is registered in
 * a factory-local module table and relative `require()` calls are answered from
 * it, while every non-relative specifier falls through to the host `require`
 * the loader injected. The entry module is executed against the envelope's own
 * `module`/`exports`, so its exports ARE the bundle's exports — byte-for-byte
 * the contract tsdown produces for a single-entry client bundle.
 *
 * Usage: node scripts/wrap-client.mjs --id <pkg> --in <dir> --entry <rel> --out <file>
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join, relative, dirname, sep } from 'node:path'

/** Parse `--flag value` pairs. */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1]
  return out
}

/**
 * Every .js file under `dir`, as posix keys relative to it, sorted.
 *
 * TWO DIRECTORY NAMES ARE SKIPPED, and the reason is measured rather than
 * hypothetical. On 2026-08-27 Stryker was configured with `tempDirName` under
 * `build/`; its sandbox is a COPY OF THE WHOLE PROJECT, `node_modules`
 * included, and a leftover sandbox made this function return 12,518 modules
 * instead of 4 — every dependency, plus a nested copy of `lib/client.js` whose
 * own `window.__ModuleLoader__.load(...)` call would have been registered a
 * second time. The emitted bundle was 1.4 MB of unrelated code.
 *
 * The primary fix is that Stryker no longer writes under `build/`. This skip is
 * the second half: `tsc`'s emit never produces a `node_modules` or a dot-named
 * directory here, so nothing legitimate is lost, and the next tool that decides
 * `build/` is a good scratch directory cannot silently end up inside the
 * shipped artifact. A bundler that trusts its input directory completely is one
 * misconfigured neighbour away from shipping it.
 */
function collect(dir) {
  const keys = []
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const full = join(current, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.js')) keys.push(relative(dir, full).split(sep).join('/'))
    }
  }
  walk(dir)
  return keys.sort()
}

/** Indent a module body so the emitted envelope stays readable. */
function indent(source, pad) {
  return source.replace(/\r\n/g, '\n').split('\n').map(line => (line === '' ? '' : pad + line)).join('\n')
}

const args = parseArgs(process.argv.slice(2))
const id = args.id
const inDir = args.in
const entry = (args.entry ?? 'index.js').split(sep).join('/')
const outFile = args.out
if (!id || !inDir || !outFile) throw new Error('wrap-client: --id, --in and --out are required')

const keys = collect(inDir)
if (!keys.includes(entry)) {
  throw new Error(`wrap-client: entry "${entry}" is not among the emitted modules (${keys.join(', ')})`)
}

const PAD = '\t\t'

/**
 * The factory-local CJS resolver. Relative specifiers are answered from the
 * module table; anything else is the host's problem, which is the whole point
 * of the externals contract.
 */
const runtime = `var __defs = {};
var __cache = {};
function __resolve(base, spec) {
	var parts = base.split("/").slice(0, -1).concat(spec.split("/"));
	var stack = [];
	for (var i = 0; i < parts.length; i++) {
		var part = parts[i];
		if (part === "" || part === ".") continue;
		if (part === "..") { stack.pop(); continue; }
		stack.push(part);
	}
	var path = stack.join("/");
	var stripped = path.slice(0, path.lastIndexOf("."));
	var candidates = [path, stripped + ".js", path + ".js", path + "/index.js"];
	for (var c = 0; c < candidates.length; c++) {
		if (Object.prototype.hasOwnProperty.call(__defs, candidates[c])) return candidates[c];
	}
	throw new Error("${id}/client: unresolved internal module " + spec + " from " + base);
}
function __require(base) {
	return function (spec) {
		if (spec.charAt(0) !== ".") return require(spec);
		var key = __resolve(base, spec);
		var cached = __cache[key];
		if (cached !== undefined) return cached.exports;
		var pending = { exports: {} };
		__cache[key] = pending;
		__defs[key](__require(key), pending, pending.exports);
		return pending.exports;
	};
}`

const registrations = keys.map((key) => {
  const source = readFileSync(join(inDir, key.split('/').join(sep)), 'utf8')
  return `__defs[${JSON.stringify(key)}] = function (require, module, exports) {\n${indent(source.replace(/\n+$/, ''), '\t')}\n};`
}).join('\n')

const bootstrap = `__cache[${JSON.stringify(entry)}] = module;
__defs[${JSON.stringify(entry)}](__require(${JSON.stringify(entry)}), module, exports);`

const bundle = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(id)},`,
  '\tfactory: (require) => {',
  `${PAD}var module = { exports: {} };`,
  `${PAD}var exports = module.exports;`,
  `${PAD}Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
  indent(runtime, PAD),
  indent(registrations, PAD),
  indent(bootstrap, PAD),
  `${PAD}return module.exports;`,
  '\t}',
  '});',
  '',
].join('\n')

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, bundle)
process.stdout.write(`wrap-client: ${outFile} <- ${keys.length} module(s) [${keys.join(', ')}], entry ${entry}\n`)
