import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {collectProject,packageProject,verifyArchive,ARCHIVE_FOLDER,crc32} from '../scripts/package-project.mjs';

const required=['README.md','package.json','.gitignore','start-local.cmd','start-local.command','dist/index.html','dist/app.js','dist/vendor/three.module.js','dist/vendor/three.core.js','dist/vendor/THREE_LICENSE.txt','src/worker.mjs','scripts/local-server.mjs','scripts/local-storage.mjs','examples/godot/project.godot'];
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'foundry-package-'));t.after(()=>rm(root,{recursive:true,force:true}));for(const path of required){await put(root,path,path==='package.json'?JSON.stringify({name:'village-foundry-mcp',version:'1.0.0'}):`portable source for ${path}\n`);}return root;}
async function put(root,path,value){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),value);}
function centralEntries(zip){const end=zip.length-22,count=zip.readUInt16LE(end+10);let offset=zip.readUInt32LE(end+16);const entries=[];for(let i=0;i<count;i++){assert.equal(zip.readUInt32LE(offset),0x02014b50);const length=zip.readUInt16LE(offset+28),extra=zip.readUInt16LE(offset+30),comment=zip.readUInt16LE(offset+32);entries.push({name:zip.subarray(offset+46,offset+46+length).toString('utf8'),system:zip.readUInt16LE(offset+4)>>8,mode:zip.readUInt32LE(offset+38)>>>16,utf8:zip.readUInt16LE(offset+8)});offset+=46+length+extra+comment;}assert.equal(offset,end);return entries;}

test('inventory includes portable runtime/docs/Godot source and excludes private/generated files',async t=>{
 const root=await fixture(t);await put(root,'docs/media/character-motion.gif',Buffer.from([71,73,70,56,57,97]));await put(root,'dist/assets/materials/palette.json','{"color":"#abcdef"}');await put(root,'examples/godot/village_foundry_demo.gd','extends Node2D\n');await put(root,'examples/godot/.gitignore','.godot/\n');
 for(const path of ['.openai/sites.local.json','node_modules/three/index.js','dist/server/index.js','dist/local-data/scene.json','dist/cache/objects/'+'a'.repeat(64)+'.json','dist/cache/server.lock','src/.env','src/credentials.json','examples/godot/.godot/editor.json','examples/godot/generated/sprite.png','qa/session.json','docs/media/Thumbs.db','docs/media/debug.log','docs/media/archive.zip'])await put(root,path,'PRIVATE OR GENERATED');
 try{await symlink(join(root,'.openai/sites.local.json'),join(root,'src','linked-secret.json'));}catch(error){if(!['EPERM','EACCES','ENOSYS'].includes(error.code))throw error;}
 const inventory=await collectProject(root),paths=inventory.files.map(f=>f.path);assert.ok(paths.includes('docs/media/character-motion.gif'));assert.ok(paths.includes('dist/assets/materials/palette.json'));assert.ok(paths.includes('examples/godot/.gitignore'));assert.ok(paths.includes('dist/vendor/THREE_LICENSE.txt'));assert.ok(!paths.some(p=>/linked-secret|credentials|\.env|\.godot\/|server\/index|local-data|server\.lock|objects\/|Thumbs|debug\.log|archive\.zip/.test(p)));assert.equal(paths.length,required.length+4);
});

test('archive verifies CRC/hash inventory, UTF-8 paths, and executable macOS launcher',async t=>{
 const root=await fixture(t);await put(root,'docs/media/villagé.png',Buffer.from([0,1,2,255]));await put(root,'scripts/example.mjs','export const text = "repeatable source";\n'.repeat(80));
 const output=join(root,'artifacts','portable.zip'),result=await packageProject({root,output});assert.equal(result.verified,true);assert.equal(result.entries,required.length+3);
 const zip=await readFile(output),entries=centralEntries(zip);assert.ok(entries.every(e=>e.name.startsWith(ARCHIVE_FOLDER+'/')&&e.system===3&&e.utf8===0x800));assert.equal(entries.find(e=>e.name.endsWith('/start-local.command')).mode,0o100755);assert.equal(entries.find(e=>e.name.endsWith('/README.md')).mode,0o100644);assert.ok(entries.some(e=>e.name.endsWith('/villagé.png')));
 const manifest=JSON.parse(await readFile(result.manifest,'utf8'));assert.equal(manifest.archive.sha256,result.sha256);assert.equal(manifest.fileCount,required.length+2);assert.ok(manifest.files.every(e=>!e.path.startsWith('/')&&!('sourcePath'in e)));assert.equal((await verifyArchive(output)).sha256,result.sha256);
 const second=await packageProject({root,output:join(root,'artifacts','second.zip')});assert.equal(second.sha256,result.sha256,'Repeated frozen source builds should be deterministic');
});

test('corrupted payload fails archive verification',async t=>{
 const root=await fixture(t),output=join(root,'artifacts','portable.zip');await packageProject({root,output});const zip=await readFile(output);const dataStart=30+zip.readUInt16LE(26)+zip.readUInt16LE(28);zip[dataStart]^=1;await writeFile(output,zip);await assert.rejects(verifyArchive(output));
});

test('dry-run writes no archive and source files cannot be overwritten by manifests',async t=>{
 const root=await fixture(t);await put(root,'package-lock.json','{"lockfileVersion":3}');const before=await readFile(join(root,'package-lock.json'),'utf8');
 const dry=await packageProject({root,dryRun:true});assert.equal(dry.dryRun,true);await assert.rejects(readFile(dry.output),{code:'ENOENT'});await assert.rejects(packageProject({root,manifest:join(root,'package-lock.json')}),/outside the packaged source/);assert.equal(await readFile(join(root,'package-lock.json'),'utf8'),before);
});

test('missing vendored license and nonportable names are rejected',async t=>{
 const root=await fixture(t);await rm(join(root,'dist/vendor/THREE_LICENSE.txt'));await assert.rejects(collectProject(root),/THREE_LICENSE/);await put(root,'dist/vendor/THREE_LICENSE.txt','License');
 if(process.platform!=='win32'){await put(root,'docs/media/CON.txt','not portable');await assert.rejects(collectProject(root),/Non-portable/);}
 assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);
});

test('case-colliding names fail instead of changing imports on Windows/macOS',async t=>{
 const root=await fixture(t);await put(root,'dist/Case.mjs','A');await put(root,'dist/case.mjs','B');
 if((await readdir(join(root,'dist'))).filter(name=>name.toLowerCase()==='case.mjs').length<2){t.skip('Filesystem itself prevents case collisions.');return;}
 await assert.rejects(collectProject(root),/case-insensitive/);
});
