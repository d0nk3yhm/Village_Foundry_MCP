#!/usr/bin/env node
/** Local-only app + MCP server. No hosted URL, cloud credentials or build required. */
import {createServer} from 'node:http';
import {realpath, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {dirname, extname, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {webcrypto} from 'node:crypto';
import worker from '../src/worker.mjs';
import {LocalBucket, acquireDataDirectory, defaultDataDirectory} from './local-storage.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 16 * 1024 * 1024;
const LOCAL_OWNER = 'local-workspace';
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.gif':'image/gif','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8','.woff':'font/woff','.woff2':'font/woff2','.wasm':'application/wasm','.zip':'application/zip'};
const failure = (status, message) => Object.assign(new Error(message), {status});

function requestOrigin(request, port) {
  const remote = request.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) throw failure(403, 'This server accepts loopback connections only.');
  let url;
  try { url = new URL(`http://${request.headers.host || ''}`); } catch { throw failure(403, 'Unrecognized Host header.'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || Number(url.port || 80) !== port || url.username || url.password || url.pathname !== '/') throw failure(403, 'Unrecognized Host header. Use this server’s loopback address and port.');
  return url.origin;
}
function bodyBytes(request) {
  const declared = request.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) { request.resume(); throw failure(413, 'Request body exceeds 16 MiB.'); }
  return new Promise((resolveBody, reject) => {
    const chunks = []; let length = 0, settled = false;
    request.on('data', chunk => {
      if (settled) return;
      length += chunk.length;
      if (length > MAX_BODY) { settled = true; chunks.length = 0; reject(failure(413, 'Request body exceeds 16 MiB.')); return; }
      chunks.push(chunk);
    });
    request.on('end', () => { if (!settled) { settled = true; resolveBody(length ? Buffer.concat(chunks) : undefined); } });
    request.on('error', error => { if (!settled) { settled = true; reject(error); } });
    request.on('aborted', () => { if (!settled) { settled = true; reject(failure(400, 'Request was interrupted.')); } });
  });
}
async function sendResponse(response, outgoing, method) {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (method === 'HEAD' || !response.body) { outgoing.end(); return; }
  await pipeline(Readable.fromWeb(response.body), outgoing);
}
function sendJson(outgoing, status, value, method) {
  const body = JSON.stringify(value);
  outgoing.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  outgoing.end(method === 'HEAD' ? undefined : body);
}
async function serveStatic(request, outgoing, url, directory) {
  if (!['GET','HEAD'].includes(request.method)) throw failure(405, 'Static assets support GET and HEAD only.');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { throw failure(404, 'File not found.'); }
  if (pathname === '/') pathname = '/index.html';
  const parts = pathname.split('/').filter(Boolean);
  if (pathname.includes('\\') || pathname.includes('\0') || parts.some(part => part.startsWith('.')) || parts[0] === 'server') throw failure(404, 'File not found.');
  let path, info;
  try {
    path = await realpath(resolve(directory, `.${pathname}`));
    const within = relative(directory, path);
    if (!within || within.startsWith(`..${sep}`) || within === '..' || isAbsolute(within)) throw failure(404, 'File not found.');
    info = await stat(path); if (!info.isFile()) throw failure(404, 'File not found.');
  } catch (error) { if (['ENOENT','ENOTDIR'].includes(error.code)) throw failure(404, 'File not found.'); throw error; }
  const etag = `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
  const headers = {'content-type':mime[extname(path).toLowerCase()] || 'application/octet-stream','cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'same-origin','cross-origin-resource-policy':'same-origin',etag};
  if (request.headers['if-none-match'] === etag) { outgoing.writeHead(304, headers); outgoing.end(); return; }
  outgoing.writeHead(200, {...headers, 'content-length':info.size});
  if (request.method === 'HEAD') outgoing.end(); else await pipeline(createReadStream(path), outgoing);
}

export async function startLocalServer({port = 8787, host = '127.0.0.1', dataDir = defaultDataDirectory(), staticDir = resolve(projectRoot, 'dist')} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 1 to 65535 (0 is allowed for automated tests).');
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('--host must be 127.0.0.1 or localhost. Public-interface binding is not supported.');
  const directory = await realpath(staticDir);
  await stat(resolve(directory, 'index.html'));
  dataDir = resolve(dataDir);
  const release = await acquireDataDirectory(dataDir);
  let bucket;
  try { bucket = await new LocalBucket(dataDir).init(); }
  catch (error) { await release(); throw error; }
  let actualPort;
  const server = createServer(async (request, outgoing) => {
    try {
      const origin = requestOrigin(request, actualPort);
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw failure(400, 'Use an origin-relative request path.');
      const url = new URL(request.url, origin), isMcp = url.pathname === '/mcp' || url.pathname === '/mcp/';
      const originHeader = request.headers.origin;
      if ((isMcp || !['GET','HEAD'].includes(request.method)) && originHeader && originHeader !== origin) throw failure(403, 'Local writes must come from this app’s exact origin. Native MCP clients may omit Origin.');
      if (url.pathname === '/api/local-info') {
        if (!['GET','HEAD'].includes(request.method)) throw failure(405, 'Use GET for local-server information.');
        sendJson(outgoing, 200, {mode:'local',mcpUrl:`${origin}/mcp`,persistentStorage:true,renderer:'browser',requiresOpenBrowser:true}, request.method); return;
      }
      if (isMcp || url.pathname.startsWith('/api/')) {
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        // Local owner injection exists ONLY in this loopback adapter. The hosted
        // Worker still requires the authenticated Sites gateway identity.
        headers.set('oai-authenticated-user-id', LOCAL_OWNER);
        const body = ['GET','HEAD'].includes(request.method) ? undefined : await bodyBytes(request);
        const response = await worker.fetch(new Request(url, {method:request.method,headers,body}), {BUCKET:bucket});
        await sendResponse(response, outgoing, request.method); return;
      }
      await serveStatic(request, outgoing, url, directory);
    } catch (error) {
      if (outgoing.headersSent) { outgoing.destroy(error); return; }
      const status = error.status || 500;
      if (status === 500) console.error('Local Village Foundry request failed:', error);
      sendJson(outgoing, status, {error:{code:status===403?'local_access_denied':'local_server_error',message:status===500?'The local server could not complete this request. Check the server terminal.':error.message}}, request.method);
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
    actualPort = server.address().port;
  } catch (error) { await release(); throw error; }
  let closed = false;
  return {server, port:actualPort, origin:`http://127.0.0.1:${actualPort}`, dataDir,
    async close() {
      if (closed) return; closed = true;
      await new Promise((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeIdleConnections?.(); });
      await release();
    }};
}

export function parseOptions(argv = process.argv.slice(2), env = process.env) {
  const options = {port:Number(env.VILLAGE_FOUNDRY_PORT || env.PORT || 8787), host:'127.0.0.1', dataDir:defaultDataDirectory(env)};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--help' || value === '-h') return {help:true};
    if (value === '--strictPort') { options.strictPort = true; continue; }
    if (!['--port','--data-dir','--host'].includes(value) || !argv[i+1]) throw new Error(`Unknown or incomplete argument: ${value}. Use --help.`);
    const argument = argv[++i];
    if (value === '--host') options.host = argument;
    else options[value === '--port' ? 'port' : 'dataDir'] = value === '--port' ? Number(argument) : resolve(argument);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('--port must be an integer from 1 to 65535.');
  if (!['127.0.0.1', 'localhost'].includes(options.host)) throw new Error('--host must be 127.0.0.1 or localhost. Public-interface binding is not supported.');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Village Foundry local server requires Node.js 20 or newer.');
    const options = parseOptions();
    if (options.help) console.log('Village Foundry local server\n\nnode scripts/local-server.mjs [--port 8787] [--data-dir PATH] [--host 127.0.0.1|localhost] [--strictPort]\n\nPort: --port, VILLAGE_FOUNDRY_PORT, PORT, then 8787.\nData: --data-dir, VILLAGE_FOUNDRY_DATA_DIR, then your OS application-data folder.\nBoth host names bind to 127.0.0.1 only; occupied ports always fail. No browser opens automatically.');
    else {
      const app = await startLocalServer(options);
      console.log(`Village Foundry is ready.\nWorkbench: ${app.origin}/\nMCP endpoint: ${app.origin}/mcp\nPersistent data: ${app.dataDir}\nPNG export jobs require this LOCAL workbench open with Follow MCP changes enabled.\nPress Ctrl+C to stop.`);
      let stopping = false;
      const stop = async () => { if (stopping) return; stopping = true; try { await app.close(); process.exitCode = 0; } catch (error) { console.error(error.message); process.exitCode = 1; } };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    }
  } catch (error) { console.error(`Village Foundry could not start: ${error.message}`); process.exitCode = 1; }
}
