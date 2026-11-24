/** Connected organic map checks plus actual software-rendered PNGs. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {buildMap,disposeMap} from '../dist/map-model.mjs';
import {HouseRenderer} from '../dist/renderer.mjs';
const require=createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'probe.js'):import.meta.url);
const{createCanvas}=require('@napi-rs/canvas');globalThis.document={createElement:()=>createCanvas(1,1)};
const out=resolve(process.argv[2]||'qa/organic-maps');await mkdir(out,{recursive:true});
function reachable(layout){
  const grid=layout.walkable,W=grid.width,D=grid.depth,cell=([x,z])=>[Math.floor((x-grid.origin[0])/grid.cellSize),Math.floor((z-grid.origin[1])/grid.cellSize)];
  const center=layout.paths[0].points[Math.floor(layout.paths[0].points.length/2)],goal=cell(center),seen=new Uint8Array(W*D),queue=[goal];
  assert.equal(grid.rows[goal[1]][goal[0]],'.','The main road must be walkable.');seen[goal[1]*W+goal[0]]=1;
  for(let i=0;i<queue.length;i++){const[x,z]=queue[i];for(const[a,b]of[[x-1,z],[x+1,z],[x,z-1],[x,z+1]])if(a>=0&&b>=0&&a<W&&b<D&&!seen[b*W+a]&&grid.rows[b][a]==='.') {seen[b*W+a]=1;queue.push([a,b]);}}
  for(const building of layout.buildings){const[x,z]=cell(building.entrance.approach);assert(seen[z*W+x],`${building.id} has no walkable route from its door to the main road.`);}
  return queue.length;
}
const fixtures=[
  {preset:'village',seed:742},{preset:'riverside',seed:742},{preset:'crossroads',seed:742},{preset:'farm',seed:742},
  {preset:'village',width:32,depth:32,houseCount:4,seed:742},{preset:'village',width:96,depth:96,houseCount:32,seed:742},
  {preset:'riverside',width:96,depth:96,houseCount:32,seed:742},{preset:'village',width:24,depth:24,houseCount:0,seed:742},
];
const report={passed:true,layouts:[],renders:[]};
for(const config of fixtures){const group=buildMap({...config,includeHouses:false}),layout=group.userData.layout;const reachableCells=reachable(layout);assert(layout.actualHouseCount<=layout.requestedHouseCount);if(layout.actualHouseCount<layout.requestedHouseCount)assert(layout.placementWarnings.length,'A capacity limit must be reported.');if(config.preset==='village'&&config.width===undefined)assert.equal(layout.actualHouseCount,10,'The default island must fit all10houses.');report.layouts.push({config,buildings:layout.actualHouseCount,requested:layout.requestedHouseCount,reachableCells,roadSegments:layout.roads.length,trees:layout.trees.length,layoutBytes:Buffer.byteLength(JSON.stringify(layout)),warnings:layout.placementWarnings});disposeMap(group);}
const renderer=new HouseRenderer(createCanvas(900,700));
for(const spec of[
  {name:'island_village_45',config:{preset:'village',seed:742},resolution:1024},
  {name:'island_riverside_45',config:{preset:'riverside',seed:742},resolution:1024},
  {name:'island_large_45',config:{preset:'village',seed:742,width:96,depth:96,houseCount:32},resolution:1024},
]){
  const start=performance.now(),group=buildMap(spec.config),buildMs=performance.now()-start;
  assert(group.userData.ownedTextures.length<=12,'Map paint should be shared across buildings.');
  for(const child of group.children.filter(child=>child.userData.mapBuildingId))assert.equal(child.userData.ownedTextures.length,0);
  reachable(group.userData.layout);renderer.setHouse(group);
  const canvas=renderer.render({elevation:45,azimuth:0,resolution:spec.resolution,scale:1,style:'illustrated',outline:false,shadow:true},{previewGround:false});
  const metadata=JSON.parse(JSON.stringify(renderer.lastMeta));assert.equal(metadata.groundIncluded,false);assert.equal(metadata.kind,'map');
  await writeFile(join(out,`${spec.name}.png`),canvas.toBuffer('image/png'));
  await writeFile(join(out,`${spec.name}.json`),JSON.stringify({config:group.userData.config,metadata,layout:group.userData.layout},null,2));
  const record={name:spec.name,buildMs:Math.round(buildMs),totalMs:Math.round(performance.now()-start),buildings:group.userData.layout.actualHouseCount,requested:group.userData.layout.requestedHouseCount,layoutBytes:Buffer.byteLength(JSON.stringify(group.userData.layout)),triangles:renderer.webgl.info.render.triangles,ownedTextures:group.userData.ownedTextures.length,width:canvas.width,height:canvas.height};report.renders.push(record);console.log(JSON.stringify(record));renderer.setHouse(null);disposeMap(group);globalThis.gc?.();
}
renderer.dispose();report.memory=process.memoryUsage();await writeFile(join(out,'map-verification-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,layouts:report.layouts.length,renders:report.renders.length}));
