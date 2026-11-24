/** Real CPU renders: cropped zoom must add geometry detail without changing exports. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import * as THREE from '../dist/vendor/three.module.js';
import {HouseRenderer} from '../dist/renderer.mjs';
import {buildHouse,disposeHouse} from '../dist/house-model.mjs';
import {buildMap} from '../dist/map-model.mjs';

const require=createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'probe.js'):import.meta.url);
const {createCanvas}=require('@napi-rs/canvas');
globalThis.document={createElement:()=>createCanvas(1,1)};
globalThis.devicePixelRatio=1;
const out=resolve(process.argv[2]||'qa/preview-detail');await mkdir(out,{recursive:true});
const hash=data=>createHash('sha256').update(data).digest('hex');
const display=createCanvas(640,460);display.clientWidth=640;display.clientHeight=460;
const renderer=new HouseRenderer(display),results=[];
const copyCanvas=source=>{const c=createCanvas(source.width,source.height);c.getContext('2d').drawImage(source,0,0);return c;};
const pixels=canvas=>canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
function geometryState(group){
  const rows=[];group.traverse(node=>{if(node.isMesh)rows.push([node.uuid,node.geometry.uuid,
    hash(Buffer.from(node.geometry.attributes.position.array.buffer)),
    node.isInstancedMesh?hash(Buffer.from(node.instanceMatrix.array.buffer)):null]);});
  return JSON.stringify(rows);
}
function projectToPreview(world){
  const s=renderer.previewSnapshot,f=renderer.previewFrame,c=s.state.camera;
  const p=new THREE.Vector3(...world).applyMatrix4(c.matrixWorldInverse),o=new THREE.Vector3().applyMatrix4(c.matrixWorldInverse);
  return[f.x+(s.anchor[0]+(p.x-o.x)*s.pixelsPerUnit)*f.ratio,
    f.y+(s.anchor[1]-(p.y-o.y)*s.pixelsPerUnit)*f.ratio];
}
async function inspect(name,group,options,zoom,focus){
  renderer.resetPreview();renderer.setHouse(group);
  const geometry=geometryState(group),originalOutput=renderer.show(options),originalOutputHash=hash(originalOutput.toBuffer('image/png'));
  const exportMeta=renderer.lastMeta,exportOptions=renderer.lastOptions;
  const expectedMeta=JSON.stringify(exportMeta),cameraBefore=renderer.camera.matrixWorld.toArray();
  renderer.setPreviewZoom(zoom);
  if(focus){const [x,y]=projectToPreview(focus);renderer.panPreview(320-x,230-y);}
  const cached=copyCanvas(display),backendSize=[renderer.webgl.domElement.width,renderer.webgl.domElement.height];
  const begin=performance.now(),detail=renderer.renderPreviewDetail(),milliseconds=performance.now()-begin;
  const detailed=copyCanvas(display),a=pixels(cached),b=pixels(detailed);
  let changed=0,totalDifference=0;
  for(let i=0;i<a.length;i+=4){let difference=0;for(let c=0;c<4;c++)difference+=Math.abs(a[i+c]-b[i+c]);if(difference)changed++;totalDifference+=difference;}
  assert.equal(detail.status,'ready');assert.equal(detail.source,'geometry-window');
  assert.equal(renderer.house,group);assert.equal(geometryState(group),geometry);
  assert.equal(renderer.lastMeta,exportMeta);assert.equal(renderer.lastOptions,exportOptions);
  assert.equal(JSON.stringify(renderer.lastMeta),expectedMeta);
  assert.deepEqual(renderer.camera.matrixWorld.toArray(),cameraBefore);
  assert.deepEqual([renderer.webgl.domElement.width,renderer.webgl.domElement.height],backendSize);
  assert.ok(detail.renderWidth*detail.renderHeight<=4194304);
  assert.ok(changed>display.width*display.height*.02,'The new view must differ materially from the enlarged raster.');
  assert.equal(hash(renderer.render(options,{previewGround:true}).toBuffer('image/png')),originalOutputHash,
    'The full PNG must remain byte-identical after preview detail navigation.');
  await writeFile(join(out,`${name}-cached.png`),cached.toBuffer('image/png'));
  await writeFile(join(out,`${name}-detail.png`),detailed.toBuffer('image/png'));
  const pair=createCanvas(1280,500),ctx=pair.getContext('2d');ctx.fillStyle='#202820';ctx.fillRect(0,0,1280,500);
  ctx.drawImage(cached,0,40);ctx.drawImage(detailed,640,40);ctx.fillStyle='#efe8d5';ctx.font='18px sans-serif';
  ctx.fillText(`${name} · cached raster at ${zoom}×`,18,27);ctx.fillText('Same geometry · cropped detail render',658,27);
  await writeFile(join(out,`${name}-comparison.png`),pair.toBuffer('image/png'));
  const record={name,seed:group.userData.params?.seed??group.userData.config?.seed,zoom,milliseconds:Math.round(milliseconds),
    geometryUnchanged:true,exportMetadataUnchanged:true,changedPixels:changed,meanChannelDifference:totalDifference/a.length,
    cachedHash:hash(cached.toBuffer('image/png')),detailHash:hash(detailed.toBuffer('image/png')),preview:detail,export:exportMeta};
  results.push(record);console.log(JSON.stringify({name,milliseconds:record.milliseconds,changedPixels:changed,render:[detail.renderWidth,detail.renderHeight]}));
}

try{
  const house=buildHouse({preset:'village',seed:742,roofColor:'#94918b',stoneColor:'#aaa697',woodColor:'#a17f50'});
  assert.equal(house.userData.ownedTextures.length,9);
  const view={elevation:45,azimuth:0,resolution:128,scale:1,pixelated:false,outline:true,shadow:true};
  await inspect('house',house,view,4,[0,3,0]);

  // Fixed contain must render above requested base density and only downsample.
  const fixed=renderer.render({...view,sizeMode:'fixed',width:900,height:700,padding:35,fit:'contain'},{previewGround:false});
  assert.equal(fixed.width,900);assert.equal(fixed.height,700);
  assert.ok(renderer.lastMeta.resolution>128);assert.ok(renderer.lastMeta.renderScale<=1);
  assert.equal(renderer.lastMeta.rasterUpscaled,false);
  results.push({name:'fixed-native-contain',metadata:structuredClone(renderer.lastMeta)});
  renderer.show({...view,sizeMode:'fixed',width:900,height:700,padding:35,fit:'contain'});
  renderer.setPreviewZoom(3,300,220);
  assert.equal(renderer.renderPreviewDetail().status,'ready');

  // HD uses actual native geometry, never the old per-kind 1024 clamp.
  const master=renderer.render({...view,resolution:4096,scale:1,outline:false},{previewGround:false});
  assert.equal(renderer.lastMeta.resolution,4096);assert.equal(renderer.lastMeta.nativePixelsPerUnit,4096/12);
  assert.equal(renderer.lastMeta.renderScale,1);assert.equal(renderer.lastMeta.rasterUpscaled,false);
  assert.equal(pixels(master)[3],0,'The master retains transparent outer padding.');
  results.push({name:'native-4096-master',bytes:master.toBuffer('image/png').length,metadata:structuredClone(renderer.lastMeta)});
  await writeFile(join(out,'house-master.png'),master.toBuffer('image/png'));
  assert.throws(()=>renderer.render({...view,sizeMode:'fixed',width:6000,height:5500,padding:8,fit:'contain'}),
    error=>error.code==='render_budget_exceeded'&&/Reduce/.test(error.message));

  // Pixel art retains the original sample grid while navigating the same mesh.
  renderer.show({...view,resolution:256,scale:2,pixelated:true});renderer.setPreviewZoom(4);
  const nativePPU=renderer.lastMeta.nativePixelsPerUnit,pixel=renderer.renderPreviewDetail();
  assert.ok(Math.abs(pixel.nativePixelsPerUnit-nativePPU)<1e-9);
  results.push({name:'pixel-native-grid',preview:pixel});

  const groundTexture=new THREE.CanvasTexture(createCanvas(16,16));
  const gc=groundTexture.image.getContext('2d');gc.fillStyle='#738745';gc.fillRect(0,0,16,16);
  renderer.setGroundTexture(groundTexture);renderer.show(view);renderer.setPreviewZoom(2);
  const groundDetail=renderer.renderPreviewDetail();assert.equal(groundDetail.groundIncluded,true);
  assert.equal(renderer.lastMeta.groundIncluded,true);
  renderer.render(view,{previewGround:false});assert.equal(renderer.lastMeta.groundIncluded,false);
  renderer.setGroundTexture(null);groundTexture.dispose();
  disposeHouse(house);

  const map=buildMap({preset:'village',width:80,depth:80,seed:742,houseCount:4,trees:true,sea:true});
  const building=map.userData.layout.buildings[0];
  await inspect('map',map,{...view,resolution:256,outline:false},8,[building.x,3,building.z]);
  disposeHouse(map);
  await writeFile(join(out,'verification.json'),JSON.stringify(results,null,2));
  console.log(`Verified detail renders and native exports: ${out}`);
}finally{renderer.dispose();}
