#!/usr/bin/env node
/** Build one self-contained Cloudflare Worker with local static assets.
 * No runtime bundler, package download, or external host is required.
 */
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { resolve, relative, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const server = resolve(dist, 'server');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.zip': 'application/zip',
};

function importedBindings(binding, namespace) {
  const value = binding.trim();
  if (value.startsWith('{') && value.endsWith('}')) {
    const names = value.slice(1, -1).split(',').map(part => part.trim()).filter(Boolean).map(part => {
      const [original, alias] = part.split(/\s+as\s+/);
      if (!/^[$\w]+$/.test(original) || (alias && !/^[$\w]+$/.test(alias))) throw new Error(`Unsupported import binding: ${part}`);
      return alias ? `${original}: ${alias}` : original;
    });
    return `const { ${names.join(', ')} } = ${namespace};`;
  }
  const match = /^\*\s+as\s+([$\w]+)$/.exec(value);
  if (match) return `const ${match[1]} = ${namespace};`;
  throw new Error(`Only named or namespace imports can be embedded: ${value}`);
}

function replaceImports(source, allowed) {
  const result = source.replace(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?\s*$/gm, (_match, binding, specifier) => {
    if (!allowed[specifier]) throw new Error(`Unexpected server dependency: ${specifier}`);
    return importedBindings(binding, allowed[specifier]);
  });
  if (/^import\s/m.test(result)) throw new Error('An unsupported server-side import remains.');
  return result;
}

function inlineModule(source, namespace, allowed = {}) {
  source = replaceImports(source, allowed);
  const names = [];
  source = source.replace(/\bexport\s+((?:async\s+)?function|const|let|var|class)\s+([$\w]+)/g, (_match, kind, name) => {
    names.push(name); return `${kind} ${name}`;
  });
  source = source.replace(/^export\s*\{([^}]+)\};?\s*$/gm, (_match, bindings) => {
    for (const value of bindings.split(',').map(part => part.trim()).filter(Boolean)) {
      const [local, alias] = value.split(/\s+as\s+/); names.push(alias ? `${alias}: ${local}` : local);
    }
    return '';
  });
  if (/^export\s/m.test(source)) throw new Error(`Unsupported export syntax in ${namespace}.`);
  return `const ${namespace} = (() => {\n${source}\nreturn { ${[...new Set(names)].join(', ')} };\n})();\n`;
}

async function collectAssets(directory, output) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    // server is the generated bundle itself; .openai and other hidden files
    // belong to deployment tooling and must never become public static assets.
    if (entry.name.startsWith('.') || (directory === dist && entry.name === 'server')) continue;
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink() || (await lstat(path)).isSymbolicLink()) throw new Error(`Static asset symlinks are not supported: ${path}`);
    if (entry.isDirectory()) { await collectAssets(path, output); continue; }
    if (!entry.isFile()) continue;
    const data = await readFile(path);
    const key = '/' + relative(dist, path).split(sep).join('/');
    output[key] = { mime: mimeTypes[extname(path).toLowerCase()] || 'application/octet-stream', data: data.toString('base64'), etag: `"${createHash('sha256').update(data).digest('hex')}"` };
  }
}

const assets = {};
await collectAssets(dist, assets);
if (!assets['/index.html'] || !assets['/app.js']) throw new Error('dist/index.html and dist/app.js are required before building the Worker.');
const schema = await readFile(resolve(dist, 'interior-schema.mjs'), 'utf8');
const houseSchema = await readFile(resolve(dist, 'house-schema.mjs'), 'utf8');
const mapSchema = await readFile(resolve(dist, 'map-schema.mjs'), 'utf8');
const characterSchema = await readFile(resolve(dist, 'character-schema.mjs'), 'utf8');
const director = await readFile(resolve(dist, 'director.mjs'), 'utf8');
let worker = await readFile(resolve(root, 'src/worker.mjs'), 'utf8');
worker = replaceImports(worker, { '../dist/interior-schema.mjs': '__interiorSchema', '../dist/house-schema.mjs': '__houseSchema', '../dist/map-schema.mjs': '__mapSchema', '../dist/character-schema.mjs': '__characterSchema', '../dist/director.mjs': '__interiorDirector' });
if (!worker.includes('/*__STATIC_ASSETS__*/ {}')) throw new Error('Worker static-asset marker is missing.');
worker = worker.replace('/*__STATIC_ASSETS__*/ {}', JSON.stringify(assets));
const output = `// Generated by scripts/build-worker.mjs. Edit src/worker.mjs instead.\n`
  + inlineModule(schema, '__interiorSchema')
  + inlineModule(houseSchema, '__houseSchema')
  + inlineModule(mapSchema, '__mapSchema', { './house-schema.mjs': '__houseSchema' })
  + inlineModule(characterSchema, '__characterSchema')
  + inlineModule(director, '__interiorDirector', { './interior-schema.mjs': '__interiorSchema' })
  + worker;
await mkdir(server, { recursive: true });
await writeFile(resolve(server, 'index.js'), output);
console.log(`Built dist/server/index.js: ${Object.keys(assets).length} assets, ${(Buffer.byteLength(output) / 1048576).toFixed(2)} MiB.`);
