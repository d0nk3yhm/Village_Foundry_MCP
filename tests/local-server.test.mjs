import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {startLocalServer, parseOptions} from '../scripts/local-server.mjs';
import {LocalBucket, acquireDataDirectory, defaultDataDirectory} from '../scripts/local-storage.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=', 'base64');
const workspaceKey = 'scenes/local-workspace.json';
const jsonRequest = body => ({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
async function call(app, name, args = {}) {
  const response = await fetch(`${app.origin}/mcp`, jsonRequest({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}));
  assert.equal(response.status,200); const body=await response.json();
  assert.equal(body.result.isError,false,JSON.stringify(body)); return body.result.structuredContent;
}
async function raw(app, path, headers, body='') {
  return new Promise((done,reject)=>{
    const request=httpRequest(`${app.origin}${path}`,{method:body?'POST':'GET',headers},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>done({status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
    });request.on('error',reject);request.end(body);
  });
}
async function temporary(t) {
  const path=await mkdtemp(join(tmpdir(),'village-foundry-local-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;
}

test('disk storage persists atomic body/metadata records and enforces concurrent conditional writes', async t => {
  const dir=await temporary(t),bucket=await new LocalBucket(dir).init();
  const first=await bucket.put(workspaceKey,'{"revision":1}',{onlyIf:{etagDoesNotMatch:'*'},customMetadata:{source:'local'}});
  assert(first);assert.equal(await bucket.put(workspaceKey,'wrong',{onlyIf:{etagDoesNotMatch:'*'}}),null);
  const secondInstance=await new LocalBucket(dir).init();
  const writes=await Promise.all([bucket,secondInstance].map((store,i)=>store.put(workspaceKey,JSON.stringify({revision:i+2}),{onlyIf:{etagMatches:first.etag}})));
  assert.equal(writes.filter(Boolean).length,1,'Only one concurrent CAS write can win');
  const restarted=await new LocalBucket(dir).init(),stored=await restarted.get(workspaceKey);
  assert.equal((await stored.json()).revision,2);
  const png=await restarted.put('exports/local-workspace/sample.png',PNG,{httpMetadata:{contentType:'image/png'},customMetadata:{sha256:'sample'}});
  const retrieved=await new LocalBucket(dir).get('exports/local-workspace/sample.png');
  assert.equal(retrieved.etag,png.etag);assert.equal(retrieved.customMetadata.sha256,'sample');assert.equal(retrieved.httpMetadata.contentType,'image/png');
  assert.deepEqual(Buffer.from(await retrieved.arrayBuffer()),PNG);
  assert((await readdir(join(dir,'objects'))).every(name=>name.endsWith('.json')),'No partial temporary file remains');
});

test('one local server owns its data directory and releases the lock on close', async t => {
  const dir=await temporary(t),app=await startLocalServer({port:0,dataDir:dir});t.after(()=>app.close());
  assert.equal(app.server.address().address,'127.0.0.1');
  await assert.rejects(startLocalServer({port:0,dataDir:dir}),/Another Village Foundry server/);
  await app.close();const release=await acquireDataDirectory(dir);await release();
});

test('local app, MCP, pending exports and completed PNGs survive server restart', async t => {
  const dir=await temporary(t);let app=await startLocalServer({port:0,dataDir:dir});t.after(()=>app.close());
  const page=await fetch(app.origin+'/');assert.equal(page.status,200);assert.match(await page.text(),/Village Foundry/);
  const module=await fetch(app.origin+'/vendor/three.module.js');assert.equal(module.status,200);assert.match(module.headers.get('content-type'),/javascript/);await module.arrayBuffer();
  const info=await (await fetch(app.origin+'/api/local-info')).json();assert.equal(info.mode,'local');assert.equal(info.mcpUrl,app.origin+'/mcp');assert.equal(info.requiresOpenBrowser,true);
  const init=await (await fetch(app.origin+'/mcp',jsonRequest({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{}}}))).json();
  assert.equal(init.result.serverInfo.name,'village-foundry-mcp');
  const listed=await (await fetch(app.origin+'/mcp',jsonRequest({jsonrpc:'2.0',id:2,method:'tools/list'}))).json();assert(listed.result.tools.some(tool=>tool.name==='generate_map'));
  const made=await call(app,'generate_map',{config:{preset:'village',width:128,depth:128,seed:418,houseCount:12}});
  assert.equal(made.scene.config.width,128);
  const queued=await call(app,'request_export');assert.equal(queued.exportJob.status,'pending');const id=queued.exportJob.id;
  await app.close();app=await startLocalServer({port:0,dataDir:dir});
  const restored=await call(app,'get_scene');assert.equal(restored.scene.config.seed,418);assert.equal(restored.exportJob.id,id);assert.equal(restored.exportJob.status,'pending');
  const complete=await fetch(`${app.origin}/api/exports/${id}`,{method:'POST',headers:{'content-type':'image/png',origin:app.origin,'x-foundry-anchor-x':'0','x-foundry-anchor-y':'1'},body:PNG});
  assert.equal(complete.status,200);assert.equal((await complete.json()).exportJob.status,'ready');
  await app.close();app=await startLocalServer({port:0,dataDir:dir});
  const final=await call(app,'get_scene');assert.equal(final.exportJob.status,'ready');assert.deepEqual(final.exportJob.metadata.anchorPixels,[0,1]);
  const image=await fetch(app.origin+final.exportJob.url);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await image.arrayBuffer()),PNG);
});

test('loopback adapter rejects foreign Host/Origin and cannot expose source or spoof another owner', async t => {
  const dir=await temporary(t),app=await startLocalServer({port:0,dataDir:dir});t.after(()=>app.close());
  const payload=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'generate_house',arguments:{params:{seed:99}}}});
  assert.equal((await raw(app,'/api/scene',{host:'evil.example'})).status,403);
  for(const origin of ['https://evil.example','null','http://127.0.0.1:1'])assert.equal((await raw(app,'/mcp',{'content-type':'application/json',origin},payload)).status,403);
  assert.equal((await call(app,'get_scene')).revision,0);
  assert.equal((await raw(app,'/mcp',{'content-type':'application/json',origin:app.origin},payload)).status,200);
  const request=await fetch(app.origin+'/api/scene',{headers:{'oai-authenticated-user-id':'other-person'}});
  assert.equal((await request.json()).scene.params.seed,99);
  for(const path of ['/server/index.js','/.openai/sites.local.json','/src/worker.mjs','/%2e%2e/package.json','/assets/%2e%2e/%2e%2e/package.json'])assert.equal((await fetch(app.origin+path)).status,404,path);
  // A bodyless cancellation remains bodyless when adapted to a Fetch Request.
  const pending=await call(app,'request_export');const cancelled=await fetch(`${app.origin}/api/exports/${pending.exportJob.id}/cancel`,{method:'POST'});
  assert.equal(cancelled.status,200);assert.equal((await cancelled.json()).exportJob.status,'cancelled');
  const objects=await readdir(join(dir,'objects'));const keys=await Promise.all(objects.map(async file=>JSON.parse(await readFile(join(dir,'objects',file),'utf8')).key));
  assert(keys.includes(workspaceKey));assert(!keys.some(key=>key.includes('other-person')));
});

test('launcher settings support managed PORT, explicit overrides, and portable data paths', () => {
  assert.equal(parseOptions([],{PORT:'9123'}).port,9123);
  assert.equal(parseOptions([],{PORT:'9123',VILLAGE_FOUNDRY_PORT:'9124'}).port,9124);
  assert.equal(parseOptions(['--port','9125'],{PORT:'9123',VILLAGE_FOUNDRY_PORT:'9124'}).port,9125);
  assert.match(parseOptions(['--data-dir','folder with spaces'],{}).dataDir,/folder with spaces$/);
  assert.throws(()=>parseOptions(['--port','0'],{}),/1 to 65535/);
  const daemon = parseOptions(['--host','127.0.0.1','--port','4173','--strictPort'],{});
  assert.equal(daemon.host,'127.0.0.1');assert.equal(daemon.port,4173);assert.equal(daemon.strictPort,true);
  assert.equal(parseOptions(['--host','localhost'],{}).host,'localhost');
  assert.throws(()=>parseOptions(['--host','0.0.0.0'],{}),/127.0.0.1 or localhost/);
  assert.throws(()=>parseOptions(['--host','evil.example'],{}),/127.0.0.1 or localhost/);
  assert.match(defaultDataDirectory({},'darwin','/users/test'),/Library\/Application Support\/VillageFoundry$/);
});
