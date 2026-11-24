/** Final map examples using the exact workbench scene, renderer and ZIP code. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import{buildMap,disposeMap}from'../dist/map-model.mjs';
import{HouseRenderer}from'../dist/renderer.mjs';
import{zipBlobs}from'../dist/zip.mjs';
const require=createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'probe.js'):import.meta.url);
const{createCanvas}=require('@napi-rs/canvas');globalThis.document={createElement:()=>createCanvas(1,1)};
const out=resolve(process.argv[2]||'qa/island-downloads');await mkdir(out,{recursive:true});
const renderer=new HouseRenderer(createCanvas(900,700)),entries=[],artifacts=[],contact=createCanvas(1200,520),ctx=contact.getContext('2d');ctx.fillStyle='#30332e';ctx.fillRect(0,0,1200,520);
const json=value=>JSON.stringify(value,null,2),digest=data=>createHash('sha256').update(data).digest('hex');
async function save(name,bytes,type){await writeFile(join(out,name),bytes);entries.push({name,blob:new Blob([bytes],{type})});}
function checkAccess(layout){
  const grid=layout.walkable,W=grid.width,D=grid.depth,cell=([x,z])=>[Math.floor((x-grid.origin[0])/grid.cellSize),Math.floor((z-grid.origin[1])/grid.cellSize)];
  const goal=cell(layout.paths[0].points[Math.floor(layout.paths[0].points.length/2)]),seen=new Uint8Array(W*D),queue=[goal];assert.equal(grid.rows[goal[1]][goal[0]],'.');seen[goal[1]*W+goal[0]]=1;
  for(let i=0;i<queue.length;i++){const[x,z]=queue[i];for(const[a,b]of[[x-1,z],[x+1,z],[x,z-1],[x,z+1]])if(a>=0&&b>=0&&a<W&&b<D&&!seen[b*W+a]&&grid.rows[b][a]==='.') {seen[b*W+a]=1;queue.push([a,b]);}}
  for(const b of layout.buildings){const[x,z]=cell(b.entrance.approach);assert(seen[z*W+x],`${b.id}: entrance is blocked.`);assert.equal(b.entrance.overlap,.30);}
}
const specs=[
  {name:'village-island-illustrated',label:'illustrated',resolution:2048,preset:'village',sea:true,count:10},
  {name:'village-island-pixel',label:'pixel',resolution:1024,preset:'village',sea:true,count:10},
  {name:'village-island-cutout',label:'illustrated',resolution:2048,preset:'village',sea:false,count:10},
  {name:'riverside-island-illustrated',label:'illustrated',resolution:2048,preset:'riverside',sea:true,count:8},
];
let map=null,previousKey='';
try{
  for(const[index,spec]of specs.entries()){
    const key=`${spec.preset}:${spec.sea}`;
    if(key!==previousKey){renderer.setHouse(null);if(map)disposeMap(map);globalThis.gc?.();map=buildMap({preset:spec.preset,width:80,depth:80,houseCount:spec.count,seed:742,landform:'island',sea:spec.sea});previousKey=key;renderer.setHouse(map);checkAccess(map.userData.layout);assert.equal(map.userData.layout.actualHouseCount,spec.count);}
    if(spec.preset==='riverside'){assert(map.userData.layout.bridges.some(bridge=>bridge.kind!=='dock'));assert(map.userData.layout.riverMouths.length>=1);}
    const begin=performance.now(),output={resolution:spec.resolution,scale:1,pixelated:spec.label==='pixel',outline:false,shadow:true,sizeMode:'auto',width:512,height:512,padding:8,fit:'contain'},view={elevation:45,azimuth:0};
    const canvas=renderer.render({...view,...output,style:spec.label},{previewGround:false}),metadata=JSON.parse(JSON.stringify(renderer.lastMeta));
    assert.equal(metadata.resolution,spec.resolution);assert.equal(metadata.nativePixelsPerUnit,spec.resolution/80);assert.equal(metadata.renderScale,1);assert.equal(metadata.resolutionReduced,false);assert.equal(metadata.groundIncluded,false);
    const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let transparent=0,opaque=0,partial=0;
    for(let i=3;i<data.length;i+=4){if(!data[i])transparent++;else if(data[i]===255)opaque++;else partial++;}
    assert(transparent>0&&opaque>canvas.width*canvas.height*.2);if(!spec.sea)assert(transparent>canvas.width*canvas.height*.10);
    for(let x=0;x<canvas.width;x++){assert.equal(data[x*4+3],0);assert.equal(data[((canvas.height-1)*canvas.width+x)*4+3],0);}
    for(let y=0;y<canvas.height;y++){assert.equal(data[(y*canvas.width)*4+3],0);assert.equal(data[(y*canvas.width+canvas.width-1)*4+3],0);}
    const png=canvas.toBuffer('image/png'),recipe={format:'village-foundry-map',version:1,config:map.userData.config,materials:{roof:'roof_weathered',wall:'wall_aged_stone',wood:'wood_oak',ground:'ground_warm_cobble'},tints:{roof:map.userData.config.roofColor,wall:map.userData.config.stoneColor,wood:map.userData.config.woodColor},paletteBase:{roof:map.userData.config.roofColor,wall:map.userData.config.stoneColor,wood:map.userData.config.woodColor},view,output};
    const result={format:'village-foundry-render',version:1,file:`${spec.name}.png`,sha256:digest(png),recipe:`${spec.name}.recipe.json`,style:spec.label,config:map.userData.config,...metadata,alpha:{transparent,opaque,partial},renderMs:Math.round(performance.now()-begin),layout:map.userData.layout};
    if(index===0)await writeFile(join(out,'village-island-layout.json'),json({format:'village-foundry-map-layout',version:1,config:map.userData.config,...map.userData.layout}));
    await save(`${spec.name}.png`,png,'image/png');await save(`${spec.name}.recipe.json`,json(recipe),'application/json');await save(`${spec.name}.metadata.json`,json(result),'application/json');
    const {layout,...report}=result;artifacts.push({...report,placedHouses:layout.actualHouseCount,access:'all doors connected',riverMouths:layout.riverMouths.length});
    if(index<2){const fit=Math.min(580/canvas.width,455/canvas.height),x=index*600+(600-canvas.width*fit)/2,y=38+(455-canvas.height*fit)/2;ctx.imageSmoothingEnabled=!spec.label.includes('pixel');ctx.drawImage(canvas,x,y,canvas.width*fit,canvas.height*fit);ctx.fillStyle='#eee6d1';ctx.font='18px sans-serif';ctx.fillText(`${spec.label==='pixel'?'Pixel':'Illustrated'} · native detail ${spec.resolution}`,index*600+20,26);}
    console.log(JSON.stringify({file:result.file,width:canvas.width,height:canvas.height,nativePixelsPerUnit:metadata.nativePixelsPerUnit,alpha:result.alpha,renderMs:result.renderMs,houses:layout.actualHouseCount,bridges:layout.bridges.length,riverMouths:layout.riverMouths.length}));
  }
  const readme=`Village Foundry island examples\n\nFour actual RGBA PNGs rendered from seeded procedural maps.\nThe illustrated village, transparent cutout, and riverside island use native\ndetail 2048. The pixel village uses native detail 1024. Camera elevation 45 degrees,\nazimuth 0 degrees and export scale 1 are shared throughout.\n\nEach PNG has a matching editable recipe and full metadata file. The metadata\nrecords exact dimensions, world-unit density, the ground anchor, all house\nrecipes, linked interiors, roads, gates, entrance paths, plants, coast and\nwalkability cells. Every doorway has a verified route to the main road.\n\nSea-on maps include surrounding water and retain transparent edge padding.\nThe cutout has transparency beyond its coastal fringe. Each recipe preserves\nthat setting. No preview ground is included.\n`;
  await save('README.txt',readme,'text/plain');
  const zip=await zipBlobs(entries),zipPath=join(out,'village-island-examples.zip');await writeFile(zipPath,new Uint8Array(await zip.arrayBuffer()));
  const verification=execFileSync(process.env.CODEX_PRIMARY_RUNTIME_PYTHON||(process.platform==='win32'?'python':'python3'),['-c',"import sys,zipfile,json\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n assert len(z.namelist())==13\n print(json.dumps({'zipEntries':len(z.namelist()),'crc':'passed'}))",zipPath],{encoding:'utf8'});
  await writeFile(join(out,'village-island-preview.png'),contact.toBuffer('image/png'));
  await writeFile(join(out,'village-island-verification.json'),json({passed:true,archiveBytes:zip.size,zip:JSON.parse(verification),artifacts}));
  console.log(JSON.stringify({passed:true,zip:zipPath,bytes:zip.size,files:entries.length,verification:JSON.parse(verification)}));
}finally{renderer.setHouse(null);if(map)disposeMap(map);renderer.dispose();}
