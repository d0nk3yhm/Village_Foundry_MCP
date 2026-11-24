import * as THREE from './vendor/three.module.js';
import { buildHouse, disposeHouse, houseEntrance } from './house-model.mjs';
import { PRESETS as HOUSE_PRESETS } from './house-schema.mjs';
import { createPaintedSurface } from './painted-surfaces.mjs';
import { makeIslandBoundary, buildIslandLandscape } from './island-landscape.mjs';
import { normalizeMap, MAP_PRESETS } from './map-schema.mjs';
export { normalizeMap, MAP_PRESETS } from './map-schema.mjs';

const UP = new THREE.Vector3(0,1,0);
const rounded = value => Math.round(value*100)/100;
function randomFor(seed){let a=(Number(seed)>>>0)||1;return()=>{a+=0x6d2b79f5;let t=Math.imul(a^a>>>15,1|a);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296;};}
function segmentDistance(x,z,segment){const[a,b]=[segment.start,segment.end],dx=b[0]-a[0],dz=b[1]-a[1],length=dx*dx+dz*dz,t=length?Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/length)):0;return Math.hypot(x-a[0]-dx*t,z-a[1]-dz*t);}
function inRect(x,z,rect,margin=0){return x>=rect.minX-margin&&x<=rect.maxX+margin&&z>=rect.minZ-margin&&z<=rect.maxZ+margin;}

function pointInPolygon(x,z,polygon){
  let inside=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[i],b=polygon[j];if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }return inside;
}
function nearPolygon(x,z,polygon,margin=0){
  return pointInPolygon(x,z,polygon)||margin>0&&polygon.some((a,i)=>segmentDistance(x,z,{start:a,end:polygon[(i+1)%polygon.length]})<margin);
}
function segmentIntersects(a,b,c,d){
  const cross=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
  return cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0;
}
function segmentNearPolygon(segment,polygon,margin){
  if(nearPolygon(...segment.start,polygon,margin)||nearPolygon(...segment.end,polygon,margin))return true;
  return polygon.some((point,i)=>segmentDistance(...point,segment)<margin||segmentIntersects(segment.start,segment.end,point,polygon[(i+1)%polygon.length]));
}
function polygonsOverlap(a,b,padding=.25){
  for(const poly of [a,b])for(let i=0;i<poly.length;i++){
    const p=poly[i],q=poly[(i+1)%poly.length],dx=q[0]-p[0],dz=q[1]-p[1],length=Math.hypot(dx,dz),nx=-dz/length,nz=dx/length;
    const aa=a.map(v=>v[0]*nx+v[1]*nz),bb=b.map(v=>v[0]*nx+v[1]*nz);
    if(Math.max(...aa)+padding<Math.min(...bb)||Math.max(...bb)+padding<Math.min(...aa))return false;
  }return true;
}
function boundsOf(polygon){return{minX:Math.min(...polygon.map(p=>p[0])),maxX:Math.max(...polygon.map(p=>p[0])),minZ:Math.min(...polygon.map(p=>p[1])),maxZ:Math.max(...polygon.map(p=>p[1]))};}
function segmentBounds(segment,margin=0){return{minX:Math.min(segment.start[0],segment.end[0])-margin,maxX:Math.max(segment.start[0],segment.end[0])+margin,minZ:Math.min(segment.start[1],segment.end[1])-margin,maxZ:Math.max(segment.start[1],segment.end[1])+margin};}
// Keep exact collision checks local as the map grows. Grid resolution and
// physical object dimensions stay unchanged; buckets only select candidates.
function pointLookup(items,bounds,cell=4){
  const buckets=new Map(),empty=[];
  for(const item of items){const b=bounds(item);for(let z=Math.floor(b.minZ/cell);z<=Math.floor(b.maxZ/cell);z++)for(let x=Math.floor(b.minX/cell);x<=Math.floor(b.maxX/cell);x++){const key=`${x},${z}`;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(item);}}
  return(x,z)=>buckets.get(`${Math.floor(x/cell)},${Math.floor(z/cell)}`)||empty;
}
function spline(controls,spacing=.85){
  const points=[];
  for(let i=0;i<controls.length-1;i++){
    const p0=controls[Math.max(0,i-1)],p1=controls[i],p2=controls[i+1],p3=controls[Math.min(controls.length-1,i+2)],steps=Math.max(2,Math.ceil(Math.hypot(p2[0]-p1[0],p2[1]-p1[1])/spacing));
    for(let step=0;step<steps;step++){const t=step/steps,t2=t*t,t3=t2*t;points.push([0,1].map(k=>.5*((2*p1[k])+(-p0[k]+p2[k])*t+(2*p0[k]-5*p1[k]+4*p2[k]-p3[k])*t2+(-p0[k]+3*p1[k]-3*p2[k]+p3[k])*t3)));}
  }points.push(controls.at(-1));return points;
}
function pathSegments(path,visible=true){return path.points.slice(1).map((point,i)=>({id:`${path.id}-${i+1}`,pathId:path.id,order:i,start:path.points[i].map(rounded),end:point.map(rounded),width:path.width,surface:path.surface||'dirt',visible}));}
function nearestRoad(point,roads){
  let best=null;for(const road of roads){const a=road.start,b=road.end,dx=b[0]-a[0],dz=b[1]-a[1],length=dx*dx+dz*dz,t=length?Math.max(0,Math.min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dz)/length)):0,q=[a[0]+dx*t,a[1]+dz*t],distance=Math.hypot(q[0]-point[0],q[1]-point[1]);if(!best||distance<best.distance)best={point:q,distance,road};}return best;
}
function alongPath(path,distance){
  for(let i=1;i<path.points.length;i++){const a=path.points[i-1],b=path.points[i],length=Math.hypot(b[0]-a[0],b[1]-a[1]);if(distance<=length)return{point:[a[0]+(b[0]-a[0])*distance/length,a[1]+(b[1]-a[1])*distance/length],tangent:[(b[0]-a[0])/length,(b[1]-a[1])/length]};distance-=length;}return null;
}
function worldTransform(x,z,degrees){const angle=degrees*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);return(a,b)=>[rounded(x+c*a+s*b),rounded(z-s*a+c*b)];}

function islandRouter(boundary,width,depth,margin){
  const cell=Math.max(1.25,Math.sqrt(width*depth/16384)),cols=Math.ceil(width/cell),rows=Math.ceil(depth/cell),nodes=[],allowed=new Uint8Array(cols*rows);
  for(let z=0;z<rows;z++)for(let x=0;x<cols;x++){const point=[-width/2+(x+.5)*cell,-depth/2+(z+.5)*cell],index=z*cols+x;nodes[index]=point;allowed[index]=boundary.landContains(...point,margin)?1:0;}
  const nearest=point=>{let best=-1,d=Infinity;for(let i=0;i<nodes.length;i++)if(allowed[i]){const p=nodes[i],distance=(p[0]-point[0])**2+(p[1]-point[1])**2;if(distance<d){d=distance;best=i;}}return best;};
  const inland=(a,b)=>{const steps=Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/.55);for(let i=0;i<=steps;i++)if(!boundary.landContains(a[0]+(b[0]-a[0])*i/(steps||1),a[1]+(b[1]-a[1])*i/(steps||1),margin))return false;return true;};
  function astar(start,end){
    const source=nearest(start),target=nearest(end);if(source<0||target<0)return[];
    const cost=new Float64Array(nodes.length);cost.fill(Infinity);cost[source]=0;const prior=new Int32Array(nodes.length);prior.fill(-1);const done=new Uint8Array(nodes.length),heap=[];
    const heuristic=index=>Math.hypot(nodes[index][0]-nodes[target][0],nodes[index][1]-nodes[target][1])/cell;
    const push=(index,score)=>{const item={index,score};heap.push(item);let i=heap.length-1;while(i>0){const parent=(i-1)>>1;if(heap[parent].score<=score)break;heap[i]=heap[parent];i=parent;}heap[i]=item;};
    const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(true){let child=i*2+1;if(child>=heap.length)break;if(child+1<heap.length&&heap[child+1].score<heap[child].score)child++;if(last.score<=heap[child].score)break;heap[i]=heap[child];i=child;}heap[i]=last;}return first.index;};
    push(source,heuristic(source));
    while(heap.length){const index=pop();if(done[index])continue;done[index]=1;if(index===target)break;const x=index%cols,z=Math.floor(index/cols);
      for(const[dx,dz]of[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){
        const nx=x+dx,nz=z+dz,next=nz*cols+nx;if(nx<0||nz<0||nx>=cols||nz>=rows||!allowed[next]||done[next]||dx&&dz&&(!allowed[z*cols+nx]||!allowed[nz*cols+x]))continue;
        const value=cost[index]+(dx&&dz?Math.SQRT2:1);if(value<cost[next]){cost[next]=value;prior[next]=index;push(next,value+heuristic(next));}
      }
    }
    if(!done[target])return[];const path=[];for(let index=target;index!==-1;index=prior[index]){path.push(nodes[index]);if(index===source)break;}path.reverse();
    const simple=[path[0]];for(let i=0;i<path.length-1;){let next=path.length-1;while(next>i+1&&!inland(path[i],path[next]))next--;simple.push(path[next]);i=next;}return simple;
  }
  return{nodes,allowed,route(controls){
    const projected=controls.map(point=>boundary.landContains(...point,margin)?point:nodes[nearest(point)]),raw=spline(projected);
    if(raw.every(point=>boundary.landContains(...point,margin)))return raw;
    const waypoints=[];for(let i=1;i<projected.length;i++){const a=projected[i-1],b=projected[i],part=inland(a,b)?[a,b]:astar(a,b);waypoints.push(...(i===1?part:part.slice(1)));}
    if(waypoints.length<2)return raw.filter(point=>boundary.landContains(...point,margin));
    const smoothed=spline(waypoints);return smoothed.every(point=>boundary.landContains(...point,margin))?smoothed:waypoints.flatMap((point,i)=>i?spline([waypoints[i-1],point]).slice(1):[point]);
  }};
}

function plan(config,boundary=null){
  const inside=(x,z,margin=0)=>!boundary||boundary.landContains(x,z,margin);
  const inlandSegment=(a,b,margin)=>{const steps=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/.65));for(let i=0;i<=steps;i++)if(!inside(a[0]+(b[0]-a[0])*i/steps,a[1]+(b[1]-a[1])*i/steps,margin))return false;return true;};
  const r=randomFor(config.seed),W=config.width,D=config.depth,unit=Math.min(W,D),mainWidth=2.35+Math.min(.65,unit/90),paths=[],router=boundary?islandRouter(boundary,W,D,mainWidth/2+.5):null;
  const addPath=(id,controls,width,kind='lane')=>{const points=router?router.route(controls):spline(controls),path={id,kind,width,points,surface:config.roadStyle};if(points.length>1)paths.push(path);return path;};
  const bend=Math.min(1,unit/52),sway=(r()-.5)*D*.07*bend;
  const main=addPath('winding-high-road',[[-W/2-1,-D*.09*bend+sway],[-W*.31,-D*(.13+r()*.025)*bend],[-W*.07,D*.015*bend+sway],[W*.18,D*(.085+r()*.025)*bend],[W*.36,D*.025*bend-sway],[W/2+1,-D*.055*bend]],mainWidth,'main');
  const at=f=>main.points[Math.round((main.points.length-1)*f)];
  const north=at(config.water?.46:.35),south=at(.68);
  addPath('north-lane',[north,[north[0]+W*.035,north[1]-D*.12],[-W*.05,-D*.32],[-W*.13,-D/2-1]],mainWidth*.68);
  if((config.preset!=='farm'||config.houseCount>5)&&(unit>=36||config.houseCount>4))addPath('orchard-lane',[south,[south[0]-W*.04,south[1]+D*.13],[W*.06,D*.34],[W*.15,D/2+1]],mainWidth*.59);
  if(config.preset==='crossroads')addPath('old-west-track',[at(.22),[-W*.28,D*.18],[-W*.37,D*.36],[-W*.42,D/2+1]],mainWidth*.62);
  if(config.houseCount>16&&Math.min(W,D)>=60)addPath('eastern-lane',[at(.84),[W*.32,-D*.17],[W*.25,-D*.36],[W*.31,-D/2-1]],mainWidth*.60);
  if(config.houseCount>20&&unit>=60)addPath('woodland-lane',[at(config.water?.28:.21),[-W*(config.water?.22:.31),D*.15],[-W*(config.water?.20:.28),D*.34],[-W*(config.water?.25:.37),D/2+1]],mainWidth*.57);
  if(config.water&&config.houseCount>20&&unit>=60)addPath('eastern-meadow-lane',[at(.85),[W*.35,D*.15],[W*.31,D*.34],[W*.40,D/2+1]],mainWidth*.55);
  const roads=paths.flatMap(path=>pathSegments(path,config.roads));
  if(boundary&&config.houseCount>=6){
    const extra=config.houseCount>24?6:config.houseCount>12?3:1;
    const sampleStride=Math.max(3,Math.ceil(router.nodes.length/2048));
    const inlandNodes=router.nodes.filter((point,i)=>i%sampleStride===0&&router.allowed[i]&&boundary.landContains(...point,6.8));
    for(let branch=0;branch<extra;branch++){
      let target=null,attachment=null,best=0;
      for(const point of inlandNodes){const nearest=nearestRoad(point,roads);if(nearest.distance>best){best=nearest.distance;target=point;attachment=nearest.point;}}
      if(!target||best<7)break;
      const dx=target[0]-attachment[0],dz=target[1]-attachment[1],length=Math.hypot(dx,dz),offset=(r()-.5)*Math.min(3,length*.2),middle=[(target[0]+attachment[0])/2-dz/length*offset,(target[1]+attachment[1])/2+dx/length*offset];
      const path=addPath(`settlement-lane-${branch+1}`,[attachment,middle,target],mainWidth*.55,'settlement');roads.push(...pathSegments(path,config.roads));
    }
  }
  const river=config.water?{centerX:-W*.375,width:Math.max(2.8,Math.min(96,unit)*.065),points:spline(Array.from({length:7},(_,i)=>[-W*.375+Math.sin(i*1.25+.7)*Math.min(W,D*1.5)*.035,-D/2-1+i*(D+2)/6])),minZ:-D/2,maxZ:D/2}:null;
  if(river)river.segments=river.points.slice(1).map((point,i)=>({start:river.points[i],end:point,width:river.width}));
  const bridges=[];
  if(river){
    // A bridge is meaningful only where a road actually crosses the river.
    // The crossing angle controls its span; nearest-road guesses can put a
    // bridge on grass or leave one end in water on a narrow rectangular map.
    const ordered=[...roads].sort((a,b)=>(a.pathId===main.id?0:1)-(b.pathId===main.id?0:1));
    for(const road of ordered)for(const water of river.segments){
      const a=road.start,b=road.end,c=water.start,d=water.end,rx=b[0]-a[0],rz=b[1]-a[1],sx=d[0]-c[0],sz=d[1]-c[1],cross=rx*sz-rz*sx;
      if(Math.abs(cross)<1e-8)continue;
      const qx=c[0]-a[0],qz=c[1]-a[1],t=(qx*sz-qz*sx)/cross,u=(qx*rz-qz*rx)/cross;
      if(t<0||t>1||u<0||u>1)continue;
      const x=a[0]+rx*t,z=a[1]+rz*t,length=Math.hypot(rx,rz),axis=[rx/length,rz/length];
      if(bridges.some(other=>Math.hypot(x-other.x,z-other.z)<Math.max(road.width,other.depth)*.6))continue;
      const sine=Math.abs(cross)/(length*Math.hypot(sx,sz));
      let span=river.width/Math.max(.12,sine)+2.15;
      const bankDistance=sign=>Math.min(...river.segments.map(segment=>segmentDistance(x+axis[0]*span*.5*sign,z+axis[1]*span*.5*sign,segment)));
      while(span<48&&(bankDistance(-1)<river.width/2+.40||bankDistance(1)<river.width/2+.40))span+=.5;
      bridges.push({id:bridges.length?`river-road-bridge-${bridges.length+1}`:'river-road-bridge',x:rounded(x),z:rounded(z),width:rounded(span),depth:road.width+.48,rotation:Math.atan2(-rz,rx)*180/Math.PI,axis});
    }
  }
  const candidates=[],hubs=[[-W*.14,-D*.015],[W*.16,D*.08],[-W*.1,D*.26]];
  let candidateIndex=0;const candidateStride=Math.max(1,Math.max(W,D)/96);
  for(const [routeIndex,path]of paths.entries()){
    const length=path.points.slice(1).reduce((sum,p,i)=>sum+Math.hypot(p[0]-path.points[i][0],p[1]-path.points[i][1]),0);
    for(let station=4+r()*2;station<length-4;station+=(1.75+r()*.75)*candidateStride)for(const side of [-1,1])for(const layer of(config.houseCount>=6?[0,1]:[0])){
      const sample=alongPath(path,station);if(!sample)continue;
      const seed=(config.seed+104729*(++candidateIndex))%2147483648,pick=r();
      const preset=config.housePreset==='mixed'?(pick<.45?'village':pick<.66?'cottage':pick<.82?'source':pick<.95?'inn':'manor'):config.housePreset;
      const compact=config.houseCount>16,template=HOUSE_PRESETS[preset];
      const useTemplateShape=['longhouse','gatehouse','weaver'].includes(preset);
      const houseWidth=useTemplateShape?rounded(template.width+(r()-.5)*.6):rounded(6+r()*(compact?.40:preset==='inn'?1.55:1.05));
      const houseDepth=useTemplateShape?rounded(template.depth+(r()-.5)*.8):rounded(6+r()*(compact?.65:preset==='inn'?2.15:1.65));
      // Parcels face the road. Turn the building so its chosen entrance faces the gate.
      const sideDoor=template.doorFace==='left'||template.doorFace==='right';
      const width=sideDoor?houseDepth:houseWidth,depth=sideDoor?houseWidth:houseDepth;
      const frontMargin=compact?.82+r()*.25:.95+r()*.65,backMargin=compact?.55+r()*.55:config.gardens&&r()<.42?2.65+r()*1.15:.72+r()*1.35,plotWidth=width+(compact?1.05+r()*.3:1.35+r()*.55);
      const outward=[-sample.tangent[1]*side,sample.tangent[0]*side],front=[-outward[0],-outward[1]],setback=path.width/2+frontMargin+depth/2+.5+r()*.6+layer*7.6;
      const drift=(r()-.5)*1.35,x=sample.point[0]+outward[0]*setback+sample.tangent[0]*drift,z=sample.point[1]+outward[1]*setback+sample.tangent[1]*drift;
      const rotation=rounded(Math.atan2(front[0],front[1])*180/Math.PI+(r()-.5)*7),transform=worldTransform(x,z,rotation),frontZ=depth/2+frontMargin,backZ=-depth/2-backMargin;
      const polygon=[transform(-plotWidth/2,frontZ),transform(plotWidth/2,frontZ),transform(plotWidth/2*(.96+r()*.08),backZ),transform(-plotWidth/2*(.96+r()*.08),backZ)];
      if(polygon.some((p,i)=>Math.abs(p[0])>W/2-.65||Math.abs(p[1])>D/2-.65||!inlandSegment(p,polygon[(i+1)%polygon.length],.4)))continue;
      if(roads.some(segment=>segmentNearPolygon(segment,polygon,segment.width/2+.22)))continue;
      if(river&&river.segments.some(segment=>segmentNearPolygon(segment,polygon,river.width/2+.85)))continue;
      const entry=houseEntrance({preset,width:houseWidth,depth:houseDepth,porch:false});
      const buildingRotation=rotation-Math.atan2(...entry.direction)*180/Math.PI;
      const buildingTransform=worldTransform(x,z,buildingRotation);
      const doorLocal=entry.u,door=buildingTransform(entry.x,entry.z),gate=transform(doorLocal,frontZ);
      const nearest=nearestRoad(gate,roads.filter(segment=>segment.pathId===path.id));
      const approach=buildingTransform(entry.approach.x,entry.approach.z);
      const points=[door,gate,nearest.point.map(rounded)],entrance={id:`candidate-entry-${candidateIndex}`,points,width:1.18,surface:'dirt'};
      const entrySegments=pathSegments(entrance,config.roads);entrySegments[0].thresholdWidth=entry.width+.20;
      if(entrySegments.some(segment=>!inlandSegment(segment.start,segment.end,segment.width/2+.10)))continue;
      if(river&&entrySegments.some(segment=>river.segments.some(water=>segmentIntersects(segment.start,segment.end,water.start,water.end))))continue;
      const score=Math.min(...hubs.map(h=>Math.hypot((x-h[0])/W,(z-h[1])/D)))+r()*.19+routeIndex*.018+layer*.08;
      candidates.push({seed,preset,width,depth,houseWidth,houseDepth,buildingRotation,useTemplateShape,frontMargin,backMargin,plotWidth,frontZ,backZ,x:rounded(x),z:rounded(z),rotation,polygon,doorLocal,door,gate,approach,entry,entrySegments,entrance,score,transform});
    }
  }
  candidates.sort((a,b)=>a.score-b.score);
  // Seeded alternative packing orders recover usable plots around bends without
  // relaxing any road/river/entrance or parcel collision rule.
  let chosen=[];
  for(let attempt=0;attempt<48&&chosen.length<config.houseCount;attempt++){
    const shuffle=randomFor(config.seed+attempt*7919),order=attempt?candidates.map(c=>({c,rank:c.score+shuffle()*(.18+Math.min(attempt,20)*.022)+(attempt>16?c.plotWidth*(c.depth+c.frontMargin+c.backMargin)*.006:0)})).sort((a,b)=>a.rank-b.rank).map(item=>item.c):candidates;
    const accepted=[];
    for(const c of order){
      if(accepted.some(other=>polygonsOverlap(c.polygon,other.polygon,.40)||other.entrySegments.some(segment=>segmentNearPolygon(segment,c.polygon,segment.width/2+.3))||c.entrySegments.some(segment=>segmentNearPolygon(segment,other.polygon,segment.width/2+.28))))continue;
      accepted.push(c);if(accepted.length>=config.houseCount)break;
    }
    if(accepted.length>chosen.length)chosen=accepted;
  }
  const buildings=[],plots=[],entrancePaths=[],fencePaths=[],gardens=[],placementWarnings=[];
  for(const candidate of chosen){
    if(buildings.length>=config.houseCount)break;
    if(plots.some(plot=>polygonsOverlap(candidate.polygon,plot.polygon,.40)))continue;
    if(entrancePaths.some(segment=>segmentNearPolygon(segment,candidate.polygon,segment.width/2+.3)))continue;
    if(candidate.entrySegments.some(segment=>plots.some(plot=>segmentNearPolygon(segment,plot.polygon,segment.width/2+.28))))continue;
    const i=buildings.length,id=`house-${String(i+1).padStart(2,'0')}`,c=candidate,t=c.transform,rr=randomFor(c.seed);
    const template=HOUSE_PRESETS[c.preset];
    const floors=c.useTemplateShape?template.floors:['cottage','source'].includes(c.preset)?1:c.preset==='inn'&&rr()>.55?3:2;
    const params={preset:c.preset,seed:c.seed,paintSeed:config.seed,width:c.houseWidth,depth:c.houseDepth,floors,floorHeight:1.70+Math.round(rr()*12)/100,roofPitch:c.useTemplateShape?template.roofPitch:Math.round(42+rr()*9),
      roofColor:config.roofColor,stoneColor:config.stoneColor,woodColor:config.woodColor,wallColor:config.plasterColor,
      roofKind:'shingles',wallKind:c.useTemplateShape?template.wallKind:c.preset==='cottage'?'plaster':'stone',timber:c.useTemplateShape?template.timber:!['source','manor'].includes(c.preset),
      chimney:rr()>.17,dormer:floors>1&&rr()>.78,porch:false,sideWing:false,shutters:rr()>.5,planters:rr()>.2};
    const footprintPolygon=[t(-c.width/2,-c.depth/2),t(c.width/2,-c.depth/2),t(c.width/2,c.depth/2),t(-c.width/2,c.depth/2)];
    const plot={id:`plot-${i+1}`,buildingId:id,...boundsOf(c.polygon),polygon:c.polygon,gate:c.gate,gateWidth:1.70,rotation:c.rotation};plots.push(plot);
    for(const [index,segment]of c.entrySegments.entries())entrancePaths.push({...segment,id:`entry-${i+1}-${index+1}`,pathId:`entry-${i+1}`,buildingId:id});
    if(config.fences){
      const gateHalf=.85,segments=[[c.polygon[0],t(c.doorLocal-gateHalf,c.frontZ)],[t(c.doorLocal+gateHalf,c.frontZ),c.polygon[1]],
        [c.polygon[1],c.polygon[2]],[c.polygon[2],c.polygon[3]],[c.polygon[3],c.polygon[0]]];
      for(const[start,end]of segments)if(Math.hypot(end[0]-start[0],end[1]-start[1])>.20)fencePaths.push({id:`fence-${fencePaths.length+1}`,buildingId:id,start,end});
    }
    if(config.gardens||rr()>.66){
      const gardenWidth=c.width*.68,gardenDepth=Math.min(c.backMargin-.35,2.25),center=t((rr()-.5)*.6,-c.depth/2-gardenDepth/2-.22);
      if(gardenDepth>.6)gardens.push({id:`garden-${gardens.length+1}`,buildingId:id,x:center[0],z:center[1],width:gardenWidth,depth:gardenDepth,rotation:c.rotation,rows:Math.max(2,Math.round(gardenDepth/.55))});
    }
    buildings.push({id,seed:c.seed,x:c.x,z:c.z,rotation:c.buildingRotation,rotationDegrees:c.buildingRotation,params,
      interior:{preset:c.preset==='inn'?'tavern':['manor','weaver'].includes(c.preset)?'workshop':'cottage',width:c.houseWidth,depth:c.houseDepth,seed:c.seed,floor:0},
      entrance:{x:c.door[0],z:c.door[1],width:c.entry.width,overlap:c.entry.overlap,approach:c.approach,gate:c.gate,road:c.entrance.points.at(-1),local:c.entry},
      footprint:{...boundsOf(footprintPolygon),polygon:footprintPolygon}});
  }
  if(buildings.length<config.houseCount)placementWarnings.push(`This ${config.landform} fits ${buildings.length} of ${config.houseCount} requested houses with the current seed and clear access paths. ${Math.min(W,D)<256?'Increase the map size or reduce the count.':'Reduce the count or choose another seed.'}`);
  const clearings=[{x:north[0],z:north[1],radius:2.4+unit*.015,scaleZ:.68},{x:south[0]-1.0,z:south[1]+.2,radius:2.1,scaleZ:.8}];
  let market=null;
  if(buildings.length>=3){
    const center=at(.5);
    for(const radius of[3.4,4.5,5.6,6.7]){
      for(let direction=0;direction<12;direction++){
        const angle=direction/12*Math.PI*2+.2,x=center[0]+Math.cos(angle)*radius,z=center[1]+Math.sin(angle)*radius;
        if(!inside(x,z,2.0)||plots.some(plot=>nearPolygon(x,z,plot.polygon,1.2))||roads.some(road=>segmentDistance(x,z,road)<road.width/2+.9)||entrancePaths.some(path=>segmentDistance(x,z,path)<path.width/2+.9))continue;
        if(river&&river.segments.some(segment=>segmentDistance(x,z,segment)<river.width/2+1.5))continue;
        const closest=nearestRoad([x,z],roads),path={id:'market-access',pathId:'market-access',order:0,start:[rounded(x),rounded(z)],end:closest.point.map(rounded),width:1.4,surface:'dirt',visible:config.roads};
        if(plots.some(plot=>segmentNearPolygon(path,plot.polygon,.8)))continue;
        market={x:rounded(x),z:rounded(z),radius:1.65,kind:'well-clearing',rotation:Math.atan2(closest.point[0]-x,closest.point[1]-z)*180/Math.PI};
        entrancePaths.push(path);clearings.push({...market,scaleZ:.85});break;
      }
      if(market)break;
    }
  }
  return{style:'organic',paths,roads,entrancePaths,fencePaths,plots,buildings,gardens,clearings,market,river,bridges,trees:[],props:market?[{kind:'well',x:market.x,z:market.z,radius:.75}]:[],
    requestedHouseCount:config.houseCount,actualHouseCount:buildings.length,visibleHouseCount:config.includeHouses?buildings.length:0,placementWarnings};

}

function terrainTexture(config,layout){
  if(typeof document==='undefined'&&typeof OffscreenCanvas==='undefined')return null;
  const size=Math.max(config.width,config.depth)>64?1536:1024,longest=Math.max(config.width,config.depth),textureWidth=Math.round(size*config.width/longest),textureHeight=Math.round(size*config.depth/longest);
  const canvas=typeof document!=='undefined'?document.createElement('canvas'):new OffscreenCanvas(textureWidth,textureHeight);canvas.width=textureWidth;canvas.height=textureHeight;
  const ctx=canvas.getContext('2d'),r=randomFor(config.seed^0x1ab54f),sx=textureWidth/config.width,sz=textureHeight/config.depth,average=(sx+sz)/2;
  const point=([x,z])=>[(x+config.width/2)*sx,(z+config.depth/2)*sz];
  const polygon=points=>{ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(...point(p)):ctx.moveTo(...point(p)));ctx.closePath();};
  ctx.fillStyle='#7e883c';ctx.fillRect(0,0,textureWidth,textureHeight);
  // Large soft growth patches establish meadow/woodland regions without noise.
  for(let i=0;i<125;i++){
    const x=r()*textureWidth,y=r()*textureHeight,radius=(.035+r()*.15)*Math.min(textureWidth,textureHeight),g=ctx.createRadialGradient(x,y,0,x,y,radius);
    g.addColorStop(0,i%3?'#adad5638':'#4f682f55');g.addColorStop(1,i%3?'#adad5600':'#4f682f00');ctx.fillStyle=g;ctx.fillRect(x-radius,y-radius,radius*2,radius*2);
  }
  for(const plot of layout.plots){
    polygon(plot.polygon);ctx.fillStyle='#b4a96a20';ctx.fill();
    const b=layout.buildings.find(b=>b.id===plot.buildingId),[x,y]=point([b.x,b.z]);
    const patch=ctx.createRadialGradient(x,y,average*2,x,y,average*6);patch.addColorStop(0,'#b9a47828');patch.addColorStop(1,'#b9a47800');ctx.fillStyle=patch;ctx.fillRect(x-average*6,y-average*6,average*12,average*12);
  }
  const tuftCount=Math.min(1700,Math.round(config.width*config.depth*.43));
  for(let tuft=0;tuft<tuftCount;tuft++){
    const x=r()*textureWidth,y=r()*textureHeight,h=(.10+r()*.10)*average;ctx.lineWidth=Math.max(.7,average*.035);ctx.strokeStyle=tuft%3?'#536b2b7a':'#b6b96280';
    for(let blade=-1;blade<=1;blade++){ctx.beginPath();ctx.moveTo(x,y);ctx.quadraticCurveTo(x+blade*h*.3,y-h*.5,x+blade*h*.55,y-h);ctx.stroke();}
    if(tuft%31===0){ctx.fillStyle='#e3dda4';for(const[a,b]of[[-1.3,0],[1.3,0],[0,-1.3],[0,1.3]]){ctx.beginPath();ctx.ellipse(x+a,y+b,1.2,.9,0,0,Math.PI*2);ctx.fill();}ctx.fillStyle='#c4a64e';ctx.fillRect(x-.5,y-.5,1,1);}
  }
  function drawPath(path,entrance=false){
    const points=path.points.map(point),width=path.width*average,distance=[0];
    for(let i=1;i<points.length;i++)distance[i]=distance[i-1]+Math.hypot(points[i][0]-points[i-1][0],points[i][1]-points[i-1][1]);
    const total=distance.at(-1),taper=d=>{let value=1;if(path.kind==='main')value=Math.min(value,Math.max(.10,d/(average*3.2)));if(path.kind&&path.kind!=='main')value=Math.min(value,Math.max(.10,(total-d)/(average*3.3)));return value;};
    const stroke=(lineWidth,color)=>{
      ctx.fillStyle=color;ctx.strokeStyle=color;ctx.lineJoin='round';
      if(!path.kind){ctx.lineWidth=lineWidth;ctx.lineCap='round';ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.stroke();return;}
      const left=[],right=[];
      for(let i=0;i<points.length;i++){const before=points[Math.max(0,i-1)],after=points[Math.min(points.length-1,i+1)],dx=after[0]-before[0],dy=after[1]-before[1],l=Math.hypot(dx,dy)||1,half=lineWidth*.5*taper(distance[i])*(1+.035*Math.sin(i*1.37));left.push([points[i][0]-dy/l*half,points[i][1]+dx/l*half]);right.push([points[i][0]+dy/l*half,points[i][1]-dx/l*half]);}
      ctx.beginPath();left.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));right.reverse().forEach(p=>ctx.lineTo(...p));ctx.closePath();ctx.fill();
    };
    if(entrance&&path.thresholdWidth){const[a]=points,radius=path.thresholdWidth*average*.90,g=ctx.createRadialGradient(a[0],a[1],0,a[0],a[1],radius);g.addColorStop(0,'#b19b6675');g.addColorStop(.55,'#b19b6644');g.addColorStop(1,'#b19b6600');ctx.fillStyle=g;ctx.fillRect(a[0]-radius,a[1]-radius,radius*2,radius*2);}
    stroke(width+average*.85,'#8e895622');stroke(width+average*.52,'#a593614f');stroke(width+average*.20,'#af9a6480');stroke(width,entrance?'#ad9864':'#b59c65');stroke(width*.64,'#bea77345');
    if(entrance&&path.thresholdWidth&&points.length>1){const[a,b]=points,dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy)||1,nx=-dy/length,ny=dx/length,start=path.thresholdWidth*average/2,end=width/2;ctx.beginPath();ctx.moveTo(a[0]+nx*start,a[1]+ny*start);ctx.lineTo(b[0]+nx*end,b[1]+ny*end);ctx.lineTo(b[0]-nx*end,b[1]-ny*end);ctx.lineTo(a[0]-nx*start,a[1]-ny*start);ctx.closePath();ctx.fillStyle='#ad9864';ctx.fill();}
    for(let i=1;i<points.length;i++){
      const a=points[i-1],b=points[i],dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy),nx=-dy/length,ny=dx/length,localWidth=width*taper((distance[i-1]+distance[i])*.5);
      for(let t=0;t<length;t+=Math.max(4,average*.22+r()*average*.26)){
        const side=r()<.5?-1:1,f=t/length,x=a[0]+dx*f+nx*localWidth*.48*side,y=a[1]+dy*f+ny*localWidth*.48*side;
        ctx.fillStyle=r()<.48?'#b59c65':'#7f893f';ctx.beginPath();ctx.ellipse(x,y,average*(.07+r()*.15),average*(.055+r()*.11),r()*3,0,Math.PI*2);ctx.fill();
        if(r()<.33){ctx.strokeStyle='#667b3577';ctx.lineWidth=.85;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+nx*3,y+ny*3-2);ctx.stroke();}
      }
      if(i%2===0&&r()<.65){const x=(a[0]+b[0])/2+nx*(r()-.5)*localWidth*.65,y=(a[1]+b[1])/2+ny*(r()-.5)*localWidth*.65;ctx.fillStyle='#8d80565c';ctx.beginPath();ctx.ellipse(x,y,average*.07,average*.035,Math.atan2(dy,dx),0,Math.PI*2);ctx.fill();}
    }
    if(config.roadStyle==='cobble'&&!entrance){
      stroke(width*.86,'#a99b7d');
      for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy),nx=-dy/length,ny=dx/length,localWidth=width*taper((distance[i-1]+distance[i])*.5);
        for(let offset=-localWidth*.37;offset<localWidth*.4;offset+=average*.38){const x=(a[0]+b[0])/2+nx*offset,y=(a[1]+b[1])/2+ny*offset;ctx.fillStyle=r()<.5?'#c5b69a':'#b9aa8d';ctx.beginPath();ctx.ellipse(x,y,average*.16,average*.12,Math.atan2(dy,dx),0,Math.PI*2);ctx.fill();}}
    }
  }

  if(config.roads){
    const entrances=new Map();for(const segment of layout.entrancePaths){if(!entrances.has(segment.pathId))entrances.set(segment.pathId,{points:[segment.start],width:segment.width,thresholdWidth:segment.thresholdWidth});entrances.get(segment.pathId).points.push(segment.end);}
    for(const path of entrances.values())drawPath(path,true);
    for(const path of [...layout.paths].reverse())drawPath(path);
    for(const clearing of layout.clearings){const[x,y]=point([clearing.x,clearing.z]),radius=clearing.radius*average,g=ctx.createRadialGradient(x,y,0,x,y,radius);g.addColorStop(0,'#b8a16b65');g.addColorStop(.55,'#b8a16b35');g.addColorStop(1,'#b8a16b00');ctx.save();ctx.translate(x,y);ctx.scale(1,clearing.scaleZ);ctx.fillStyle=g;ctx.translate(-x,-y);ctx.fillRect(x-radius,y-radius,radius*2,radius*2);ctx.restore();}
  }
  if(layout.river){
    const river=layout.river,points=river.points.map(point),stroke=(width,color)=>{ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.lineWidth=width*average;ctx.strokeStyle=color;ctx.lineCap='round';ctx.lineJoin='round';ctx.stroke();};
    stroke(river.width+1.55,'#85935d35');stroke(river.width+.95,'#9ca47455');stroke(river.width+.43,'#7c916b88');stroke(river.width,'#638f98');stroke(river.width*.72,'#80a7a83f');stroke(river.width*.35,'#96bdbb1a');
    for(let i=1;i<river.points.length;i++){const a=river.points[i-1],b=river.points[i],dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz)||1,side=i%2?1:-1,offset=river.width*.50+(r()-.5)*.14,[x,y]=point([(a[0]+b[0])/2-dz/length*offset*side,(a[1]+b[1])/2+dx/length*offset*side]);ctx.fillStyle=i%3?'#7e883c88':'#a3a16b66';ctx.beginPath();ctx.ellipse(x,y,average*(.12+r()*.15),average*(.08+r()*.10),Math.atan2(dz,dx),0,Math.PI*2);ctx.fill();}
    ctx.lineWidth=1.3;ctx.strokeStyle='#c7d8c975';
    for(let i=2;i<river.points.length-2;i+=2){const[a,b]=[river.points[i-1],river.points[i+1]],dx=b[0]-a[0],dz=b[1]-a[1],l=Math.hypot(dx,dz),side=(r()-.5)*river.width*.65,p=point([river.points[i][0]-dz/l*side,river.points[i][1]+dx/l*side]);ctx.beginPath();ctx.moveTo(p[0]-3,p[1]);ctx.quadraticCurveTo(p[0]+2,p[1]+2,p[0]+8,p[1]);ctx.stroke();}
  }
  for(const garden of layout.gardens){
    const t=worldTransform(garden.x,garden.z,garden.rotation),points=[t(-garden.width/2,-garden.depth/2),t(garden.width/2,-garden.depth/2),t(garden.width/2,garden.depth/2),t(-garden.width/2,garden.depth/2)];
    polygon(points);ctx.fillStyle='#8d754d';ctx.fill();
    for(let row=0;row<garden.rows;row++){const z=-garden.depth/2+(row+.5)*garden.depth/garden.rows,a=point(t(-garden.width/2+.15,z)),b=point(t(garden.width/2-.15,z));ctx.lineWidth=average*.16;ctx.strokeStyle=row%2?'#a38b5d':'#6b633e';ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();}
  }
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.magFilter=texture.minFilter=THREE.LinearFilter;texture.generateMipmaps=false;return texture;
}

function crownGeometry(variant){
  const positions=[],colors=[],indices=[],segments=16,rings=3;
  for(let ring=0;ring<=rings;ring++)for(let k=0;k<=segments;k++){
    const angle=k/segments*Math.PI*2,t=ring/rings;
    const radius=t*(1+.11*Math.sin(angle*5+variant)+.075*Math.cos(angle*3-variant));
    const y=.72*Math.sqrt(Math.max(0,1-t*t))+.08*Math.sin(angle*3+variant)*t;
    positions.push(Math.cos(angle)*radius,y,Math.sin(angle)*radius);
    const shade=.82+(1-t)*.25+.045*Math.sin(angle*4+variant);colors.push(shade,shade,shade);
    if(ring<rings&&k<segments){const a=ring*(segments+1)+k,b=a+segments+1;indices.push(a,b,a+1,b,b+1,a+1);}
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.setIndex(indices);geometry.computeVertexNormals();return geometry;
}

function leafClusterGeometry(variant){
  const r=randomFor(6931+variant*379),positions=[],colors=[],normals=[];
  const outline=[[-.86,0],[-.38,-.51],[.42,-.43],[.94,.02],[.30,.56],[-.43,.43]];
  for(let leaf=0;leaf<38;leaf++){
    const angle=r()*Math.PI*2,radius=Math.sqrt(r())*.91,cx=Math.cos(angle)*radius,cz=Math.sin(angle)*radius*.88,cy=.48*Math.sqrt(Math.max(0,1-radius*radius))+(r()-.5)*.10;
    const turn=r()*Math.PI*2,c=Math.cos(turn),s=Math.sin(turn),size=.20+r()*.15,shade=.77+r()*.25;
    const edge=outline.map(([x,z])=>[cx+(x*c-z*s)*size,cy+(r()-.5)*.024,cz+(x*s+z*c)*size]);
    const normal=new THREE.Vector3(cx*.19,1,cz*.19).normalize();
    const vertex=(point,tone)=>{positions.push(...point);colors.push(tone,tone,tone*.96);normals.push(normal.x,normal.y,normal.z);};
    for(let j=0;j<edge.length;j++){vertex([cx,cy+.025,cz],shade+.16);vertex(edge[(j+1)%edge.length],shade+.025);vertex(edge[j],shade);}
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));return geometry;
}
function paleBarkTexture(seed){
  if(typeof document==='undefined'&&typeof OffscreenCanvas==='undefined')return null;
  const canvas=typeof document!=='undefined'?document.createElement('canvas'):new OffscreenCanvas(128,256);canvas.width=128;canvas.height=256;const ctx=canvas.getContext('2d'),r=randomFor(seed^0x48961);
  const gradient=ctx.createLinearGradient(0,0,128,0);gradient.addColorStop(0,'#8f8b72');gradient.addColorStop(.28,'#cbc5a5');gradient.addColorStop(.58,'#d8cdae');gradient.addColorStop(1,'#a9a48c');ctx.fillStyle=gradient;ctx.fillRect(0,0,128,256);
  for(let i=0;i<16;i++){const x=r()*128,y=r()*256,w=4+r()*15;ctx.strokeStyle=i%3?'#74786466':'#ede4c477';ctx.lineWidth=1.1+r()*1.5;ctx.beginPath();ctx.moveTo(x,y);ctx.quadraticCurveTo(x+w*.55,y+2,x+w,y-1);ctx.stroke();}
  for(const x of[18,49,88,112]){ctx.strokeStyle='#8a8b7155';ctx.lineWidth=1.0;ctx.beginPath();ctx.moveTo(x,0);ctx.bezierCurveTo(x-4,70,x+5,165,x-1,256);ctx.stroke();}
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.magFilter=texture.minFilter=THREE.LinearFilter;texture.generateMipmaps=false;return texture;
}
function riverMouths(river,boundary){
  if(!river||boundary.landform!=='island')return[];const mouths=[];
  for(const segment of river.segments)for(let i=0;i<boundary.points.length;i++){
    const a=segment.start,b=segment.end,c=boundary.points[i],d=boundary.points[(i+1)%boundary.points.length],rx=b[0]-a[0],rz=b[1]-a[1],sx=d[0]-c[0],sz=d[1]-c[1],den=rx*sz-rz*sx;
    if(Math.abs(den)<1e-9)continue;const qx=c[0]-a[0],qz=c[1]-a[1],t=(qx*sz-qz*sx)/den,u=(qx*rz-qz*rx)/den;
    if(t<0||t>1||u<0||u>1)continue;const point=[a[0]+rx*t,a[1]+rz*t];
    if(mouths.some(m=>Math.hypot(m.point[0]-point[0],m.point[1]-point[1])<river.width*.7))continue;
    mouths.push({point:point.map(rounded),width:river.width,normal:boundary.nearestCoast(...point).normal});
  }return mouths;
}

/** Build a complete illustrated map. House transforms and interiors share metadata. */
export function buildMap(input={}){
  const config=normalizeMap(input),boundary=makeIslandBoundary(config),layout=plan(config,config.landform==='island'?boundary:null),r=randomFor(config.seed^0x238aa),group=new THREE.Group();
  layout.landform=config.landform;layout.sea=config.sea;layout.coastline=boundary.points.map(point=>[...point]);layout.landArea=boundary.landArea;
  boundary.riverMouths=riverMouths(layout.river,boundary);layout.riverMouths=boundary.riverMouths;
  if(config.landform==='island'&&layout.paths[0]?.points.length){const roadEnd=layout.paths[0].points.at(-1),coast=boundary.nearestCoast(...roadEnd),start=[roadEnd[0],roadEnd[1]],end=[coast.point[0]+coast.normal[0]*boundary.rimWidth*.78,coast.point[1]+coast.normal[1]*boundary.rimWidth*.78],dx=end[0]-start[0],dz=end[1]-start[1],length=Math.hypot(dx,dz);layout.bridges.push({id:'village-dock',kind:'dock',x:(start[0]+end[0])/2,z:(start[1]+end[1])/2,width:length,depth:2.0,rotation:Math.atan2(-dz,dx)*180/Math.PI,axis:[dx/length,dz/length]});layout.coastalAccess={road:roadEnd,shore:coast.point,dockEnd:end};}group.name=`${config.preset}-map`;
  const ownedTextures=[],housePaintCache=new Map(),materials=new Map(),batches=new Map(),unitBox=new THREE.BoxGeometry(1,1,1),trunkGeo=new THREE.CylinderGeometry(.5,.62,1,9),rockGeo=new THREE.DodecahedronGeometry(1,0);
  const crowns=[0,1,2].map(crownGeometry),leafClusters=[0,1,2,3].map(leafClusterGeometry),branchGeometry=new THREE.CylinderGeometry(.36,.5,1,9),qIdentity=new THREE.Quaternion(),matrix=new THREE.Matrix4();
  const paint=createPaintedSurface(THREE,'wood',config.woodColor,{seed:config.seed,variant:0});if(paint)ownedTextures.push(paint);
  const mat=(key,color,map=null)=>{if(!materials.has(key))materials.set(key,new THREE.MeshStandardMaterial({color:map?'#ffffff':color,map,roughness:1,metalness:0,flatShading:true}));return materials.get(key);};
  const barkMap=paleBarkTexture(config.seed);if(barkMap)ownedTextures.push(barkMap);
  const wood=mat('wood',config.woodColor,paint),darkWood=mat('dark-wood','#70553b'),leaf=mat('leaf','#7d8c3b'),leafLight=mat('leaf-light','#a4ad4e'),leafGold=mat('golden-leaf','#b8a355'),bark=mat('pale-bark','#c2b997',barkMap),cutWood=mat('cut-wood','#c6af7d'),stone=mat('stone','#aaa591');
  for(const material of[leaf,leafLight,leafGold]){material.vertexColors=true;material.side=THREE.DoubleSide;material.flatShading=false;}bark.flatShading=false;
  function instance(geometry,material,position,size,quaternion=qIdentity,tint=1,name='map-details'){
    const key=`${geometry.uuid}:${material.uuid}:${name}`;let batch=batches.get(key);if(!batch){batch={geometry,material,name,matrices:[],colors:[]};batches.set(key,batch);}
    matrix.compose(new THREE.Vector3(...position),quaternion,new THREE.Vector3(...size));batch.matrices.push(matrix.clone());batch.colors.push(new THREE.Color().setScalar(tint));
  }
  function branch(a,b,radius){const av=new THREE.Vector3(...a),bv=new THREE.Vector3(...b),delta=bv.clone().sub(av);instance(branchGeometry,bark,av.add(bv).multiplyScalar(.5).toArray(),[radius*2,delta.length(),radius*2],new THREE.Quaternion().setFromUnitVectors(UP,delta.normalize()),1,'pale-branching-tree');}
  const box=(position,size,material=wood,q=qIdentity,tint=1,name='map-carpentry')=>instance(unitBox,material,position,size,q,tint,name);
  function beam(a,b,width=.10,depth=.12,material=wood){const av=new THREE.Vector3(...a),bv=new THREE.Vector3(...b),delta=bv.clone().sub(av);if(delta.length()<.02)return;box(av.add(bv).multiplyScalar(.5).toArray(),[width,delta.length(),depth],material,new THREE.Quaternion().setFromUnitVectors(UP,delta.normalize()));}
  const terrain=terrainTexture(config,layout);if(terrain)ownedTextures.push(terrain);
  group.add(buildIslandLandscape(config,boundary,terrain));

  if(config.includeHouses)for(const building of layout.buildings){
    const house=buildHouse(building.params,{}, {paintCache:housePaintCache});house.position.set(building.x,0,building.z);house.rotation.y=THREE.MathUtils.degToRad(building.rotation);house.userData.mapBuildingId=building.id;group.add(house);
  }
  ownedTextures.push(...[...housePaintCache.values()].filter(Boolean));
  for(const fence of layout.fencePaths){
    const[a,b]=[fence.start,fence.end],length=Math.hypot(b[0]-a[0],b[1]-a[1]),sections=Math.max(1,Math.ceil(length/1.15));
    for(let i=0;i<=sections;i++){const t=i/sections,x=a[0]+(b[0]-a[0])*t,z=a[1]+(b[1]-a[1])*t;box([x,.48,z],[.15,.96,.15],wood,qIdentity,.92+r()*.12,'fence-posts');box([x,.985,z],[.20,.07,.20],wood,qIdentity,1.05,'fence-caps');}
    for(const y of[.35,.72])beam([a[0],y,a[1]],[b[0],y,b[1]],.12,.10,wood);
  }
  for(const bridge of layout.bridges){
    const transform=worldTransform(bridge.x,bridge.z,bridge.rotation),q=new THREE.Quaternion().setFromAxisAngle(UP,bridge.rotation*Math.PI/180),planks=Math.ceil(bridge.width/.24);
    for(let i=0;i<planks;i++){const[x,z]=transform(-bridge.width/2+(i+.5)*bridge.width/planks,0);box([x,.11,z],[bridge.width/planks-.018,.18,bridge.depth],wood,q,.88+r()*.17,'bridge-planks');}
    for(const side of[-1,1]){
      const localZ=side*(bridge.depth/2+.10);
      for(let i=0;i<4;i++){const[x,z]=transform(-bridge.width/2+i*bridge.width/3,localZ);box([x,bridge.kind==='dock'?0:.53,z],[.16,bridge.kind==='dock'?2:1.1,.16],wood,q,1,'bridge-posts');}
      const a=transform(-bridge.width/2,localZ),b=transform(bridge.width/2,localZ);beam([a[0],.9,a[1]],[b[0],.9,b[1]],.13,.14,wood);
    }
  }

  const gardenPolygons=layout.gardens.map(g=>{const t=worldTransform(g.x,g.z,g.rotation);return[t(-g.width/2,-g.depth/2),t(g.width/2,-g.depth/2),t(g.width/2,g.depth/2),t(-g.width/2,g.depth/2)];});
  const free=(x,z,radius,allowCanopyOverlap=false)=>{
    if(Math.abs(x)+radius>config.width/2-.25||Math.abs(z)+radius>config.depth/2-.25||!boundary.landContains(x,z,radius+.25))return false;
    if(layout.river&&layout.river.segments.some(segment=>segmentDistance(x,z,segment)<layout.river.width/2+radius+.45))return false;
    if(layout.plots.some(plot=>nearPolygon(x,z,plot.polygon,radius+.18))||gardenPolygons.some(polygon=>nearPolygon(x,z,polygon,radius)))return false;
    if([...layout.roads,...layout.entrancePaths].some(seg=>segmentDistance(x,z,seg)<seg.width/2+radius+.3))return false;
    if(layout.trees.some(tree=>Math.hypot(x-tree.x,z-tree.z)<(radius+tree.radius)*(allowCanopyOverlap?.66:1)+.18))return false;
    if(layout.props.some(prop=>Math.hypot(x-prop.x,z-prop.z)<radius+prop.radius+.2))return false;
    return true;
  };
  if(layout.market){
    const market=layout.market,x=market.x,z=market.z,t=worldTransform(x,z,market.rotation),q=new THREE.Quaternion().setFromAxisAngle(UP,market.rotation*Math.PI/180);
    const wall=new THREE.Mesh(new THREE.CylinderGeometry(.56,.61,.56,16,1,true),stone);wall.position.set(x,.28,z);wall.castShadow=wall.receiveShadow=true;group.add(wall);
    const inner=new THREE.Mesh(new THREE.CylinderGeometry(.52,.52,.035,16),darkWood);inner.position.set(x,.15,z);group.add(inner);
    const lip=new THREE.Mesh(new THREE.TorusGeometry(.555,.075,6,18),stone);lip.rotation.x=Math.PI/2;lip.position.set(x,.56,z);lip.castShadow=lip.receiveShadow=true;group.add(lip);
    for(const side of[-1,1]){const[p,qz]=t(side*.66,0);box([p,.95,qz],[.13,1.9,.13],wood,q);}
    box([x,1.69,z],[1.55,.13,.14],wood,q);
    for(const side of[-1,1]){const[p,qz]=t(0,side*.30),roofQ=q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),side*.4));box([p,1.86,qz],[1.85,.09,.68],darkWood,roofQ,1,'village-well-roof');}
  }
  // Working-yard details sit beside fences, away from doors and lanes.
  const logGeometry=new THREE.CylinderGeometry(.5,.53,1,10),capGeometry=new THREE.CylinderGeometry(.5,.5,1,12),barrelGeometry=new THREE.CylinderGeometry(.5,.43,1,12),barrelRing=new THREE.TorusGeometry(.31,.024,5,14);
  for(const building of layout.buildings){
    const t=worldTransform(building.x,building.z,building.rotation),q=new THREE.Quaternion().setFromAxisAngle(UP,building.rotation*Math.PI/180),side=r()<.5?-1:1;
    const candidates=[t(side*(building.params.width/2+1.9),building.params.depth*.20),t(-side*(building.params.width/2+1.9),-building.params.depth*.25)];
    const placement=candidates.find(point=>free(...point,.9));if(!placement)continue;const[x,z]=placement,local=worldTransform(x,z,building.rotation);
    if(r()<.62){
      const along=q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2));
      for(const[height,offset]of[[.20,-.18],[.20,.18],[.53,0]]){const[px,pz]=local(0,offset);instance(logGeometry,wood,[px,height,pz],[.35,1.45,.35],along,.96,'stacked-yard-logs');for(const end of[-.73,.73]){const[ex,ez]=local(end,offset);instance(capGeometry,cutWood,[ex,height,ez],[.35,.025,.35],along,1,'fresh-log-ends');}}
      layout.props.push({kind:'logs',x:rounded(x),z:rounded(z),rotation:building.rotation,radius:.9});
    }else{
      instance(barrelGeometry,wood,[x,.41,z],[.66,.82,.66],q,1,'yard-barrels');instance(capGeometry,cutWood,[x,.835,z],[.62,.025,.62],q,1,'barrel-lids');
      const ringQ=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),Math.PI/2);for(const y of[.17,.65])instance(barrelRing,darkWood,[x,y,z],[1,1,1],ringQ,1,'barrel-hoops');
      layout.props.push({kind:'barrel',x:rounded(x),z:rounded(z),radius:.45});
    }
  }
  if(config.trees){
    layout.groves=Array.from({length:8},(_,i)=>{const angle=i/8*Math.PI*2+(r()-.5)*.32;return{x:Math.cos(angle)*config.width*(.37+r()*.05),z:Math.sin(angle)*config.depth*(.37+r()*.05),radius:Math.min(config.width,config.depth)*(.12+r()*.07)};});
    const wanted=Math.min(150,Math.round(config.width*config.depth/56));
    for(let attempt=0;attempt<2600&&layout.trees.length<wanted;attempt++){
      const radius=1.40+r()*.70;let x,z;
      if(attempt%5!==0){const grove=layout.groves[Math.floor(r()*layout.groves.length)],angle=r()*Math.PI*2,distance=Math.sqrt(r())*grove.radius;x=grove.x+Math.cos(angle)*distance;z=grove.z+Math.sin(angle)*distance;}
      else{x=(r()-.5)*(config.width-3);z=(r()-.5)*(config.depth-3);}
      if(!free(x,z,radius,true))continue;
      const speciesRoll=r(),species=speciesRoll<.18?'golden':speciesRoll>.83?'oak':'birch',old=species==='oak',height=(old?6.3:4.7)+r()*.9,trunkRadius=old?.35:.145+r()*.035;
      const turn=r()*Math.PI*2,lean=[(r()-.5)*.30,(r()-.5)*.24],fork=[x+lean[0],height*.47,z+lean[1]],top=[x-lean[0]*.4,height*.88,z-lean[1]*.2];
      branch([x,0,z],[x+lean[0]*.3,height*.24,z+lean[1]*.3],trunkRadius);
      branch([x+lean[0]*.3,height*.24,z+lean[1]*.3],fork,trunkRadius*.83);
      branch(fork,top,trunkRadius*.62);
      for(let root=0;root<(old?5:3);root++){const angle=turn+root/(old?5:3)*Math.PI*2;branch([x,.31,z],[x+Math.cos(angle)*trunkRadius*2.3,.045,z+Math.sin(angle)*trunkRadius*2.3],trunkRadius*.48);}
      const count=old?7:5,foliage=species==='golden'?leafGold:leaf;
      for(let limb=0;limb<count;limb++){
        const angle=turn+limb/count*Math.PI*2+(r()-.5)*.35,reach=radius*(.45+r()*.22),end=[x+Math.cos(angle)*reach,height*(.62+r()*.18),z+Math.sin(angle)*reach];
        const start=[fork[0],height*(.40+r()*.20),fork[2]],middle=[(start[0]+end[0])*.5,height*(.59+r()*.06),(start[2]+end[2])*.5];
        branch(start,middle,trunkRadius*.47);branch(middle,end,trunkRadius*.25);
        const size=radius*(.48+r()*.12),material=species==='golden'?leafGold:limb%3===0?leafLight:foliage;
        instance(leafClusters[(layout.trees.length+limb)%4],material,end,[size,.80+r()*.22,size],qIdentity,.91+r()*.13,'painted-leaf-clusters');
        const outer=[end[0]+Math.cos(angle)*size*.33,end[1]-.32,end[2]+Math.sin(angle)*size*.33];
        instance(leafClusters[(limb+2)%4],foliage,outer,[size*.68,.63,size*.68],qIdentity,.88+r()*.09,'outer-leaf-sprays');
      }
      instance(leafClusters[layout.trees.length%4],species==='golden'?leafGold:leafLight,top,[radius*.60,.88,radius*.57],qIdentity,1.03,'sunlit-tree-crown');
      layout.trees.push({id:`tree-${layout.trees.length+1}`,kind:species,x:rounded(x),z:rounded(z),radius:rounded(radius*1.12),trunkRadius:rounded(trunkRadius*1.5),height:rounded(height+.7)});
    }
  }

  for(const garden of layout.gardens){
    const transform=worldTransform(garden.x,garden.z,garden.rotation),columns=Math.max(3,Math.round(garden.width/.55));
    for(let row=0;row<garden.rows;row++)for(let col=0;col<columns;col++){
      const[x,z]=transform(-garden.width/2+(col+.5)*garden.width/columns,-garden.depth/2+(row+.5)*garden.depth/garden.rows);
      instance(crowns[(row+col)%3],row%2?leaf:leafLight,[x,.05,z],[.20,.32,.23],qIdentity,.88+r()*.16,'garden-crops');
    }
  }
  // Benches and stones follow roadside clearings, not fixed quadrant positions.
  for(let attempt=0;attempt<30&&layout.props.filter(p=>p.kind==='bench').length<Math.min(5,1+Math.floor(layout.buildings.length/3));attempt++){
    const road=layout.roads[Math.floor(r()*layout.roads.length)],dx=road.end[0]-road.start[0],dz=road.end[1]-road.start[1],length=Math.hypot(dx,dz),side=r()<.5?-1:1;
    const x=(road.start[0]+road.end[0])/2-dz/length*(road.width/2+1.4)*side,z=(road.start[1]+road.end[1])/2+dx/length*(road.width/2+1.4)*side;
    if(!free(x,z,.9))continue;const rotation=Math.atan2(-dz,dx)*180/Math.PI,t=worldTransform(x,z,rotation),q=new THREE.Quaternion().setFromAxisAngle(UP,rotation*Math.PI/180);
    for(const leg of[-.55,.55]){const[p,qz]=t(leg,0);box([p,.28,qz],[.13,.56,.44],darkWood,q);}
    box([x,.58,z],[1.5,.12,.54],wood,q);for(const leg of[-.62,.62]){const[p,qz]=t(leg,-.24);box([p,.95,qz],[.10,.72,.10],wood,q);}
    const[p,qz]=t(0,-.24);box([p,1.13,qz],[1.5,.25,.10],wood,q);layout.props.push({kind:'bench',x:rounded(x),z:rounded(z),rotation,radius:.85});
  }
  const rockTarget=Math.max(5,Math.min(16,Math.round(config.width*config.depth/350)));
  for(let i=0;i<rockTarget*15;i++){
    const x=(r()-.5)*(config.width-2),z=(r()-.5)*(config.depth-2);if(!free(x,z,.72,true))continue;
    const turn=r()*Math.PI*2;
    for(const[j,scale]of[1,.53,.34].entries()){const angle=turn+j*2.3,reach=j?.39+j*.07:0;instance(rockGeo,stone,[x+Math.cos(angle)*reach,.24*scale,z+Math.sin(angle)*reach],[.57*scale,.40*scale,.48*scale],new THREE.Quaternion().setFromAxisAngle(UP,angle),.91+r()*.18,'contextual-stone-clusters');}
    layout.props.push({kind:'rock-cluster',x:rounded(x),z:rounded(z),radius:.72});if(layout.props.filter(p=>p.kind==='rock-cluster').length>=rockTarget)break;
  }

  for(const batch of batches.values()){
    const mesh=new THREE.InstancedMesh(batch.geometry,batch.material,batch.matrices.length);mesh.name=batch.name;
    for(let i=0;i<batch.matrices.length;i++){mesh.setMatrixAt(i,batch.matrices[i]);mesh.setColorAt(i,batch.colors[i]);}
    mesh.instanceMatrix.needsUpdate=true;mesh.instanceColor.needsUpdate=true;mesh.castShadow=mesh.receiveShadow=true;mesh.computeBoundingSphere();group.add(mesh);
  }
  const cell=.5,columns=Math.ceil(config.width/cell),rows=Math.ceil(config.depth/cell),walkable=[];
  const riverAt=pointLookup(layout.river?.segments||[],segment=>segmentBounds(segment,layout.river.width/2));
  const buildingsAt=pointLookup(layout.buildings,b=>({minX:b.footprint.minX-.1,maxX:b.footprint.maxX+.1,minZ:b.footprint.minZ-.1,maxZ:b.footprint.maxZ+.1}));
  const fencesAt=pointLookup(layout.fencePaths,f=>segmentBounds(f,.20));
  const treesAt=pointLookup(layout.trees,t=>({minX:t.x-t.trunkRadius-.12,maxX:t.x+t.trunkRadius+.12,minZ:t.z-t.trunkRadius-.12,maxZ:t.z+t.trunkRadius+.12}));
  const propsAt=pointLookup(layout.props,p=>({minX:p.x-p.radius,maxX:p.x+p.radius,minZ:p.z-p.radius,maxZ:p.z+p.radius}));
  for(let row=0;row<rows;row++){
    let line='';for(let col=0;col<columns;col++){
      const x=-config.width/2+(col+.5)*cell,z=-config.depth/2+(row+.5)*cell;
      const water=!boundary.landContains(x,z,.12)||(layout.river&&riverAt(x,z).some(segment=>segmentDistance(x,z,segment)<layout.river.width/2));
      const bridge=layout.bridges.some(b=>{const dx=x-b.x,dz=z-b.z;return Math.abs(dx*b.axis[0]+dz*b.axis[1])<=b.width/2&&Math.abs(-dx*b.axis[1]+dz*b.axis[0])<=b.depth/2;});
      const blocked=buildingsAt(x,z).some(b=>nearPolygon(x,z,b.footprint.polygon,.10))||fencesAt(x,z).some(f=>segmentDistance(x,z,f)<.20)||treesAt(x,z).some(t=>Math.hypot(x-t.x,z-t.z)<t.trunkRadius+.12)||propsAt(x,z).some(p=>Math.hypot(x-p.x,z-p.z)<p.radius);
      line+=blocked?'#':water&&!bridge?'~':'.';
    }walkable.push(line);
  }
  layout.walkable={cellSize:cell,width:columns,depth:rows,origin:[-config.width/2,-config.depth/2],rows:walkable,legend:{'.':'walkable','#':'solid obstacle','~':'water'}};
  group.updateMatrixWorld(true);const bounds=new THREE.Box3().setFromObject(group);
  group.userData={kind:'map',config,params:config,layout,preset:config.preset,parts:group.children.length,
    bounds:{min:bounds.min.toArray(),max:bounds.max.toArray(),size:bounds.getSize(new THREE.Vector3()).toArray()},
    coordinateSystem:'X right, Y up, Z south; building rotations are degrees around +Y.'};
  Object.defineProperty(group.userData,'ownedTextures',{value:ownedTextures,enumerable:false});
  return group;
}

/** disposeHouse already walks nested house maps, materials and owned textures. */
export function disposeMap(group){disposeHouse(group);}
