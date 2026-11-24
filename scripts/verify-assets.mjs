/**
 * Real asset/export stress check, using the exact browser geometry, renderer and
 * ZIP implementation. Run with Node --expose-gc for useful retained-memory data:
 *   node --expose-gc scripts/verify-assets.mjs --count 100 --out /absolute/output
 * Requires @napi-rs/canvas and Python (stdlib zipfile checks the finished ZIP).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as THREE from '../dist/vendor/three.module.js';
import { buildHouse, disposeHouse, randomizeHouse, PRESETS, DEFAULT_PARAMS } from '../dist/house-model.mjs';
import { MATERIAL_CATALOG, MATERIAL_FAMILIES } from '../dist/materials.mjs';
import { HouseRenderer } from '../dist/renderer.mjs';
import { zipBlobs } from '../dist/zip.mjs';

const args = Object.fromEntries(Array.from({length:Math.floor((process.argv.length-2)/2)},(_,i)=>[process.argv[2+i*2],process.argv[3+i*2]]));
const count = Number(args['--count'] || 100), baseSeed=Number(args['--seed'] || 1847);
assert(Number.isInteger(count)&&count>=1&&count<=500,'--count must be 1..500');
const out=resolve(args['--out'] || 'qa/asset-verification');
const root=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'probe.js'):import.meta.url);
const {createCanvas}=require('@napi-rs/canvas');
globalThis.document={createElement:()=>createCanvas(1,1)};

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
const rng=seed=>{let a=seed>>>0;return()=>{a+=0x6d2b79f5;let t=Math.imul(a^a>>>15,a|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};};
const catalog=new Map(MATERIAL_CATALOG.map(item=>[item.id,item]));
const familyByPreset={village:'village',cottage:'cottage',source:'townhouse',inn:'townhouse',manor:'manor'};
const output={resolution:384,scale:2,pixelated:true,outline:true,shadow:true};
const view={elevation:45,azimuth:0};

// Mirrors the workbench's coherent family selection and seeded finish variation.
function recipeFor(preset,seed,strength=.65){
  const family=MATERIAL_FAMILIES.find(item=>item.id===familyByPreset[preset]);
  const materials=Object.fromEntries(['roof','wall','wood','ground'].map(key=>[key,family[key]]));
  const paletteBase=Object.fromEntries(['roof','wall','wood'].map(key=>[key,catalog.get(materials[key]).color]));
  const tints=clone(paletteBase),r=rng(seed^0x578713);
  for(const key of ['roof','wall','wood']){
    const color=new THREE.Color(tints[key]);color.offsetHSL((r()-.5)*.025*strength,(r()-.5)*.07*strength,(r()-.5)*.07*strength);tints[key]=`#${color.getHexString()}`;
  }
  const params={...DEFAULT_PARAMS,...PRESETS[preset],...randomizeHouse(preset,seed,strength)};
  params.roofKind=catalog.get(materials.roof).kind;params.wallKind=catalog.get(materials.wall).kind;
  return {format:'house-foundry',version:1,params,materials,tints,paletteBase,view:clone(view),output:clone(output)};
}
function modelParams(recipe){
  const params={...recipe.params,roofColor:recipe.tints.roof,woodColor:recipe.tints.wood};
  if(params.wallKind==='plaster')params.wallColor=recipe.tints.wall;else params.stoneColor=recipe.tints.wall;
  return params;
}

await mkdir(join(out,'sprites'),{recursive:true});await mkdir(join(out,'recipes'),{recursive:true});
const renderer=new HouseRenderer(createCanvas(800,600));
assert.equal(renderer.backend,'software','This harness must exercise the actual CPU fallback.');
const entries=[],assets=[],hashes=new Set(),memory=[],times=[],textureDisposals=[];
const choose=rng(baseSeed^0x732943),start=performance.now();
const contact=createCanvas(1000,Math.ceil(count/10)*128),contactContext=contact.getContext('2d');
contactContext.fillStyle='#302f2a';contactContext.fillRect(0,0,contact.width,contact.height);
function memorySample(index){if(globalThis.gc)globalThis.gc();const value=process.memoryUsage();memory.push({index,rss:value.rss,heapUsed:value.heapUsed,external:value.external,arrayBuffers:value.arrayBuffers});}
memorySample(0);

function renderOne(recipe,index,record=true){
  let house=buildHouse(modelParams(recipe));
  const owned=house.userData.ownedTextures||[];assert.equal(owned.length,9,'Painted textures must be active.');
  let disposed=0;for(const texture of owned)texture.addEventListener('dispose',()=>disposed++);
  const begin=performance.now();renderer.setHouse(house);
  const canvas=renderer.render({...recipe.view,...recipe.output,style:'pixel'},{previewGround:false});
  const meta=clone(renderer.lastMeta),pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  assert.equal(meta.width,canvas.width);assert.equal(meta.height,canvas.height);assert.equal(meta.groundIncluded,false);
  assert.equal(meta.style,'pixel');assert.equal(meta.nativePixelsPerUnit,32);assert.equal(meta.pixelsPerUnit,64);
  assert(meta.anchor_px.every(Number.isFinite));assert(meta.anchor_px[0]>=0&&meta.anchor_px[0]<meta.width&&meta.anchor_px[1]>=0&&meta.anchor_px[1]<meta.height);
  let transparent=0,opaque=0;
  for(let i=3;i<pixels.length;i+=4){if(pixels[i]===0)transparent++;else if(pixels[i]===255)opaque++;else assert.fail('Pixel export alpha must be binary.');}
  assert(transparent>0&&opaque>0,'Each PNG needs visible geometry and transparent background.');
  for(let x=0;x<canvas.width;x++){assert.equal(pixels[x*4+3],0);assert.equal(pixels[((canvas.height-1)*canvas.width+x)*4+3],0);}
  for(let y=0;y<canvas.height;y++){assert.equal(pixels[(y*canvas.width)*4+3],0);assert.equal(pixels[(y*canvas.width+canvas.width-1)*4+3],0);}
  const png=canvas.toBuffer('image/png'),hash=sha(png);
  if(record){
    const fit=Math.min(94/canvas.width,108/canvas.height),x=(index%10)*100,y=Math.floor(index/10)*128;
    contactContext.imageSmoothingEnabled=false;contactContext.drawImage(canvas,x+(100-canvas.width*fit)/2,y+4,canvas.width*fit,canvas.height*fit);
    contactContext.fillStyle='#e8ddc3';contactContext.font='10px sans-serif';contactContext.fillText(`${String(index+1).padStart(3,'0')} ${recipe.params.preset}`,x+6,y+123);
    times.push(performance.now()-begin);textureDisposals.push(disposed);
  }
  renderer.setHouse(null);disposeHouse(house);house=null;
  assert.equal(disposed,9,'All owned texture resources must be disposed after each asset.');
  if(record)textureDisposals[textureDisposals.length-1]=disposed;
  return {png,hash,meta,alpha:{transparent,opaque}};
}

try{
  for(let index=0;index<count;index++){
    const pick=choose(),preset=pick<.52?'village':pick<.75?'cottage':pick<.90?'inn':pick<.97?'manor':'source';
    const seed=(baseSeed+index)%2147483648,recipe=recipeFor(preset,seed),name=`${String(index+1).padStart(3,'0')}-house-${preset}-${seed}`;
    const {png,hash,meta,alpha}=renderOne(recipe,index);
    assert(!hashes.has(hash),'Every distinct seeded asset should have distinct rendered pixels.');hashes.add(hash);
    const file=`sprites/${name}.png`,recipeFile=`recipes/${name}.json`,recipeBytes=JSON.stringify(recipe,null,2);
    await writeFile(join(out,file),png);await writeFile(join(out,recipeFile),recipeBytes);
    entries.push({name:file,blob:new Blob([png],{type:'image/png'})},{name:recipeFile,blob:new Blob([recipeBytes],{type:'application/json'})});
    assets.push({template:preset,seed,file,recipe:recipeFile,sha256:hash,...meta,alpha});
    if((index+1)%10===0||index+1===count){memorySample(index+1);console.log(JSON.stringify({rendered:index+1,count,rssMiB:Math.round(memory.at(-1).rss/1048576),unique:hashes.size}));}
  }
  // A fresh rebuild at both ends proves seeds regenerate the same image bytes.
  for(const index of new Set([0,count-1])){const recipe=JSON.parse(await readFile(join(out,assets[index].recipe),'utf8'));assert.equal(renderOne(recipe,index,false).hash,assets[index].sha256,'Seeded rebuild changed output.');}
  const sources={};for(const file of ['house-model.mjs','house-schema.mjs','painted-surfaces.mjs','materials.mjs','renderer.mjs','software-rasterizer.mjs','zip.mjs'])sources[file]=sha(await readFile(join(root,'dist',file)));
  const manifest={format:'house-foundry-batch',version:1,baseSeed,template:'mixed',variation:.65,count,output,view,
    notes:'Actual RGBA pixel-style PNGs rendered by the workbench CPU backend. Recipes can be loaded in Village Foundry. PNGs share64pixels/world-unit; place them using anchor_px.',assets};
  entries.push({name:'manifest.json',blob:new Blob([JSON.stringify(manifest,null,2)],{type:'application/json'})});
  const archive=await zipBlobs(entries),archivePath=join(out,`village-foundry-${count}-houses-pixel.zip`);
  await writeFile(archivePath,new Uint8Array(await archive.arrayBuffer()));
  const python=process.env.CODEX_PRIMARY_RUNTIME_PYTHON||(process.platform==='win32'?'python':'python3');
  const zipResult=JSON.parse(execFileSync(python,['-c',String.raw`import json,sys,zipfile,hashlib
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None
    names=archive.namelist()
    assert len(names)==len(set(names))
    manifest=json.loads(archive.read('manifest.json'))
    assert len(names)==manifest['count']*2+1
    for asset in manifest['assets']:
        png=archive.read(asset['file'])
        assert png[:8]==b'\x89PNG\r\n\x1a\n'
        assert hashlib.sha256(png).hexdigest()==asset['sha256']
        recipe=json.loads(archive.read(asset['recipe']))
        assert recipe['params']['seed']==asset['seed']
    print(json.dumps({'entries':len(names),'pngs':manifest['count'],'crc':'passed','hashes':'passed','recipes':'passed'}))`,archivePath],{encoding:'utf8'}));
  memorySample(count);const totalMs=performance.now()-start,sorted=[...times].sort((a,b)=>a-b);
  const report={passed:true,count,archive:archivePath,archiveBytes:archive.size,backend:renderer.backend,uniquePngs:hashes.size,
    alphaChecks:'all images contain opaque geometry plus transparent padded edges',metadataChecks:'dimensions, fixed density, anchors, ground exclusion',
    deterministicRebuilds:[assets[0].seed,assets.at(-1).seed],disposedOwnedTextures:textureDisposals.reduce((a,b)=>a+b,0),zip:zipResult,
    timing:{totalSeconds:Number((totalMs/1000).toFixed(2)),renderMedianMs:Math.round(sorted[Math.floor(sorted.length/2)]),render95thMs:Math.round(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))])},
    memory:{gcAvailable:Boolean(globalThis.gc),peakRssMiB:Math.round(Math.max(...memory.map(sample=>sample.rss))/1048576),samples:memory},sourceSha256:sources};
  await writeFile(join(out,'verification-report.json'),JSON.stringify(report,null,2));await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2));
  await writeFile(join(out,'contact-sheet.png'),contact.toBuffer('image/png'));
  console.log(JSON.stringify({...report,memory:{gcAvailable:report.memory.gcAvailable,peakRssMiB:report.memory.peakRssMiB},sourceSha256:undefined},null,2));
}finally{renderer.dispose();}
