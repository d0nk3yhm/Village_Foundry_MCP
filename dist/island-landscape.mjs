import * as THREE from './vendor/three.module.js';
import { createPaintedSurface } from './painted-surfaces.mjs';

// An asymmetric coastline with bays and peninsulas. Buildings and paths use
// the same polygon predicate as the visible land, rather than a hidden square.
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const finite = (n, fallback) => Number.isFinite(Number(n)) ? Number(n) : fallback;
function randomFor(seed) { let a = Number(seed) >>> 0; return () => { a += 0x6d2b79f5; let t = Math.imul(a ^ a >>> 15, a | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function area(points) { return points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0) / 2; }
function smoothClosed(points) {
  const result = [];
  for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; result.push([a[0] * .78 + b[0] * .22, a[1] * .78 + b[1] * .22], [a[0] * .22 + b[0] * .78, a[1] * .22 + b[1] * .78]); }
  return result;
}
function inside(x, z, points) {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) { const a = points[i], b = points[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit; }
  return hit;
}
function nearestOnCoast(x, z, points) {
  let result = null;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
    const t = length ? clamp(((x - a[0]) * dx + (z - a[1]) * dz) / (length * length), 0, 1) : 0;
    const point = [a[0] + dx * t, a[1] + dz * t], distance = Math.hypot(x - point[0], z - point[1]);
    if (!result || distance < result.distance) result = { point, normal: length ? [dz / length, -dx / length] : [0, 1], distance, segment: i, t };
  }
  return result;
}

export function makeIslandBoundary(config = {}) {
  const width = clamp(finite(config.width, 64), 24, 256), depth = clamp(finite(config.depth, 56), 24, 256), seed = Number(config.seed ?? 742) >>> 0;
  const landform = config.landform === 'mainland' ? 'mainland' : 'island', r = randomFor(seed ^ 0x69e34a1b), unit = Math.min(width, depth);
  const rimWidth = clamp(unit * .030, 1.05, 2.15);
  let points;
  if (landform === 'mainland') points = [[-width / 2, -depth / 2], [width / 2, -depth / 2], [width / 2, depth / 2], [-width / 2, depth / 2]];
  else {
    // The long western shoulder and narrow southeastern inlet are deliberate
    // geographical features. Seeded edits alter their shape, not just a radius.
    points = [[-.33,-.48],[-.10,-.50],[.08,-.43],[.25,-.49],[.43,-.42],[.50,-.26],
      [.44,-.15],[.30,-.10],[.32,.015],[.47,.10],[.49,.28],[.35,.43],
      [.22,.42],[.14,.29],[.045,.25],[-.025,.37],[-.13,.50],[-.30,.47],
      [-.38,.34],[-.33,.22],[-.37,.13],[-.49,.11],[-.50,-.07],[-.45,-.22],[-.33,-.27]];
    const mirror = r() < .5 ? -1 : 1, skew = (r() - .5) * .09;
    points = points.map(([x, z], i) => [mirror * (x + (r() - .5) * .035 + z * skew), z + (r() - .5) * .031 + Math.sin(i * 1.47 + seed % 17) * .008]);
    points = smoothClosed(smoothClosed(points));
    const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0])), minZ = Math.min(...points.map(p => p[1])), maxZ = Math.max(...points.map(p => p[1]));
    const spanX = width - 2 * (rimWidth + .28), spanZ = depth - 2 * (rimWidth + .28);
    points = points.map(([x, z]) => [(x - (minX + maxX) / 2) / (maxX - minX) * spanX, (z - (minZ + maxZ) / 2) / (maxZ - minZ) * spanZ]);
  }
  if (area(points) < 0) points.reverse();
  points = points.map(p => Object.freeze(p.map(value => Math.round(value * 10000) / 10000)));
  Object.freeze(points);
  const bounds = { minX: Math.min(...points.map(p => p[0])), maxX: Math.max(...points.map(p => p[0])), minZ: Math.min(...points.map(p => p[1])), maxZ: Math.max(...points.map(p => p[1])) };
  const signedDistance = (x, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return -Infinity;
    const distance = nearestOnCoast(x, z, points).distance;
    return distance < 1e-8 ? 0 : inside(x, z, points) ? distance : -distance;
  };
  return { points, bounds, width, depth, seed, landform, rimWidth, center: [0, 0], landArea: Math.abs(area(points)),
    landContains: (x, z, margin = 0) => Number.isFinite(margin) && signedDistance(x, z) >= margin - 1e-8,
    signedDistance, nearestCoast: (x, z) => nearestOnCoast(x, z, points),
  };
}

function normalsFor(points) {
  return points.map((p, i) => {
    const a = points[(i + points.length - 1) % points.length], b = points[(i + 1) % points.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz) || 1;
    return [dz / length, -dx / length];
  });
}
function offset(points, normals, distance) { return points.map((p, i) => { const d = typeof distance === 'function' ? distance(i) : distance; return [p[0] + normals[i][0] * d, p[1] + normals[i][1] * d]; }); }
function stripGeometry(inner, outer, innerY, outerY, innerColor, outerColor, includeSegment = () => true) {
  const positions = [], colors = [], aColor = new THREE.Color(innerColor), bColor = new THREE.Color(outerColor);
  const vertex = (p, y, color) => { positions.push(p[0], y, p[1]); colors.push(color.r, color.g, color.b); };
  for (let i = 0; i < inner.length; i++) {
    if (!includeSegment(i)) continue;
    const j = (i + 1) % inner.length;
    for (const [ring, k] of [[0,i],[0,j],[1,i],[1,i],[0,j],[1,j]]) vertex(ring ? outer[k] : inner[k], ring ? outerY : innerY, ring ? bColor : aColor);
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geo.computeVertexNormals(); return geo;
}
function waterTexture(boundary, sea, extent, mouths) {
  const makeCanvas = (w,h) => {
    const canvas = typeof document !== 'undefined' && document.createElement ? document.createElement('canvas') : typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w,h) : null;
    if (canvas) { canvas.width=w;canvas.height=h; } return canvas;
  };
  const ratio=extent.depth/extent.width,fw=Math.round(384/Math.max(1,ratio)),fh=Math.round(fw*ratio),field=makeCanvas(fw,fh);
  if(!field)return null;
  const ctx=field.getContext('2d'),pixels=ctx.createImageData(fw,fh),unit=Math.min(boundary.width,boundary.depth),fade=sea?Math.max(3.4,unit*.075):Math.max(1.5,boundary.rimWidth*1.25);
  const edges=boundary.points.map((a,i)=>{const b=boundary.points[(i+1)%boundary.points.length],dx=b[0]-a[0],dz=b[1]-a[1];return{a,dx,dz,inverse:1/(dx*dx+dz*dz),minX:Math.min(a[0],b[0])-fade*2,maxX:Math.max(a[0],b[0])+fade*2,minZ:Math.min(a[1],b[1])-fade*2,maxZ:Math.max(a[1],b[1])+fade*2};});
  for(let py=0;py<fh;py++)for(let px=0;px<fw;px++){
    const x=(px+.5)/fw*extent.width-extent.width/2,z=(py+.5)/fh*extent.depth-extent.depth/2;let distance2=fade*fade*4;
    for(const edge of edges){if(x<edge.minX||x>edge.maxX||z<edge.minZ||z>edge.maxZ)continue;const t=clamp(((x-edge.a[0])*edge.dx+(z-edge.a[1])*edge.dz)*edge.inverse,0,1),dx=x-edge.a[0]-edge.dx*t,dz=z-edge.a[1]-edge.dz*t;distance2=Math.min(distance2,dx*dx+dz*dz);}
    const distance=Math.sqrt(distance2),variation=.92+.08*Math.sin(x*.12+z*.09+boundary.seed%17),shallow=Math.exp(-distance2/(fade*fade*.36))*variation;
    const light=.5+.5*Math.sin(x*.035-z*.027),cloud=Math.sin(x*.11+z*.07)*Math.cos(z*.09-x*.04)*2.2,deep=[41+light*8,108+light*13,123+light*9],near=[106,172,165];
    const contact=Math.exp(-distance/.18)*.18,at=(py*fw+px)*4;
    for(let channel=0;channel<3;channel++)pixels.data[at+channel]=(deep[channel]*(1-shallow)+near[channel]*shallow+cloud)*(1-contact);
    pixels.data[at+3]=sea?255:Math.round(255*(1-clamp(distance/fade,0,1))**1.65);
  }
  ctx.putImageData(pixels,0,0);
  const tw=Math.round(1024/Math.max(1,ratio)),th=Math.round(tw*ratio),canvas=makeCanvas(tw,th),paint=canvas.getContext('2d');paint.imageSmoothingEnabled=true;paint.imageSmoothingQuality='high';paint.drawImage(field,0,0,tw,th);
  const sx=tw/extent.width,sz=th/extent.depth,screen=(x,z)=>[(x+extent.width/2)*sx,(z+extent.depth/2)*sz],r=randomFor(boundary.seed^0x791ac);
  paint.globalCompositeOperation='source-atop';paint.lineCap='round';paint.lineJoin='round';
  // Sparse, predominantly horizontal ripples follow the painted reference;
  // the coast glow already comes from true distance, not polygonal bands.
  for(let i=0;i<Math.min(260,Math.round(extent.width*extent.depth*.025));i++){
    const x=(r()-.5)*extent.width,z=(r()-.5)*extent.depth;if(boundary.landContains(x,z,-.15))continue;
    const [a,b]=screen(x,z),length=(.18+r()*.65)*sx;paint.strokeStyle=`rgba(176,219,208,${.10+r()*.15})`;paint.lineWidth=Math.max(.55,sx*.035);paint.beginPath();paint.moveTo(a,b);paint.quadraticCurveTo(a+length*.45,b+.1*sz,a+length,b);paint.stroke();
  }
  const normals=normalsFor(boundary.points);
  for(let i=0;i<boundary.points.length;i+=2){
    if(r()<.44)continue;const a=boundary.points[i],b=boundary.points[(i+1)%boundary.points.length],n=normals[i],distance=.32+r()*.60;
    if(mouths.some(m=>Math.hypot(a[0]-m.point[0],a[1]-m.point[1])<m.width*.6))continue;
    const p=screen(a[0]+n[0]*distance,a[1]+n[1]*distance),q=screen(b[0]+n[0]*distance,b[1]+n[1]*distance);
    paint.strokeStyle=`rgba(207,230,208,${.20+r()*.24})`;paint.lineWidth=Math.max(.65,sx*(.040+r()*.035));paint.beginPath();paint.moveTo(...p);paint.quadraticCurveTo((p[0]+q[0])*.5+n[0]*sx*.11,(p[1]+q[1])*.5+n[1]*sz*.11,...q);paint.stroke();
  }
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.magFilter=texture.minFilter=THREE.LinearFilter;texture.generateMipmaps=false;texture.name='painted-island-sea';return texture;
}
function coastStoneGeometry() {
  const ring = [[-.38,-.5],[.38,-.5],[.5,-.35],[.5,.35],[.38,.5],[-.38,.5],[-.5,.35],[-.5,-.35]], vertices = [], colors = [], uvs = [];
  const add = (x,y,z,tone) => { vertices.push(x,y,z); colors.push(tone,tone,tone); uvs.push(x+.5,z+.5); };
  const tri = (a,b,c,tone) => { for (const p of [a,b,c]) add(...p,tone); };
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length, a = ring[i], b = ring[j];
    const loA=[a[0]*.89,-.50,a[1]*.89],loB=[b[0]*.89,-.50,b[1]*.89],midA=[a[0],.17,a[1]],midB=[b[0],.17,b[1]],topA=[a[0]*.75,.45,a[1]*.75],topB=[b[0]*.75,.45,b[1]*.75];
    tri(midA,midB,loA,.83); tri(loA,midB,loB,.83); tri(topA,topB,midA,.98); tri(midA,topB,midB,.98); tri([.015,.47,-.015],topB,topA,1.06);
  }
  const geo = new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geo.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));geo.computeVertexNormals();return geo;
}

/** Caller retains terrainTexture ownership. Generated coast textures belong to this group. */
export function buildIslandLandscape(config = {}, boundary = makeIslandBoundary(config), terrainTexture = null) {
  const group = new THREE.Group();group.name = `${boundary.landform}-landscape`;
  const { points, width, depth, rimWidth } = boundary, r = randomFor(boundary.seed ^ 0x1987ac), normals = normalsFor(points), ownedTextures = [];
  const mouths=(boundary.riverMouths||[]).filter(m=>Array.isArray(m.point)&&m.point.length===2&&m.point.every(Number.isFinite)&&Number.isFinite(m.width)&&m.width>0).map(m=>({...m,normal:Array.isArray(m.normal)?m.normal:boundary.nearestCoast(...m.point).normal}));
  const mouthAt=(x,z,extra=0)=>mouths.some(m=>Math.hypot(x-m.point[0],z-m.point[1])<m.width*.52+extra);
  const solidSegment=i=>{const a=points[i],b=points[(i+1)%points.length];return!mouthAt((a[0]+b[0])*.5,(a[1]+b[1])*.5,.20);};
  const material = (color, extra = {}) => new THREE.MeshStandardMaterial({color,roughness:1,metalness:0,flatShading:true,...extra});
  const add = (name, geometry, mat, cast = false, receive = true) => { const mesh = new THREE.Mesh(geometry,mat);mesh.name=name;mesh.castShadow=cast;mesh.receiveShadow=receive;group.add(mesh);return mesh; };
  const shape = new THREE.Shape();points.forEach(([x,z],i)=>i?shape.lineTo(x,-z):shape.moveTo(x,-z));shape.closePath();
  const land = new THREE.ShapeGeometry(shape);land.rotateX(-Math.PI/2);
  const position = land.getAttribute('position'),uv = land.getAttribute('uv');
  for(let i=0;i<position.count;i++)uv.setXY(i,(position.getX(i)+width/2)/width,1-(position.getZ(i)+depth/2)/depth);
  add('island-land-top',land,material(terrainTexture?'#ffffff':'#7e883c',{map:terrainTexture}));
  if(boundary.landform==='mainland') {
    group.userData={kind:'landscape',landform:'mainland',coastline:points.map(p=>[...p]),landArea:boundary.landArea};
    Object.defineProperty(group.userData,'ownedTextures',{value:ownedTextures,enumerable:false});return group;
  }
  const beach = i => .18 + .78 * Math.max(0,Math.sin(i/points.length*Math.PI*4+.9)) ** 3;
  add('soft-coastal-beach',stripGeometry(offset(points,normals,i=>-beach(i)),points,.012,.008,'#859047','#baa674',solidSegment),material('#ffffff',{vertexColors:true}));
  // The exposed rim has genuine depth, so an elevated view sees warm gray
  // cliff faces while a top view retains the same usable land boundary.
  const cliffPositions=[],cliffColors=[],cliffUvs=[];
  const cliffs = [new THREE.Color('#9d9a88'),new THREE.Color('#b3a58d')];
  const lower=offset(points,normals,i=>.13+.16*Math.sin(i*.73)),middle=offset(points,normals,i=>.08+.10*Math.sin(i*.49+.8));
  for(let i=0;i<points.length;i++){
    if(!solidSegment(i))continue;
    const j=(i+1)%points.length,base=-.91+.17*Math.sin(i*.83),mid=-.34-.10*Math.cos(i*.61),tone=cliffs[0].clone().lerp(cliffs[1],.5+.5*Math.sin(i*.28+.6));
    const put=(p,y,u,v,factor)=>{cliffPositions.push(p[0],y,p[1]);cliffUvs.push(u,v);cliffColors.push(tone.r*factor,tone.g*factor,tone.b*factor);};
    for(const [top,bottom,ya,yb,factor]of[[points,middle,-.02,mid,1],[middle,lower,mid,base,.82]]){
      for(const [ring,k,u,v]of[[0,i,0,1],[0,j,1,1],[1,i,0,0],[1,i,0,0],[0,j,1,1],[1,j,1,0]])put(ring?bottom[k]:top[k],ring?yb:ya,u,v,factor);
    }
  }
  const cliffGeo=new THREE.BufferGeometry();cliffGeo.setAttribute('position',new THREE.Float32BufferAttribute(cliffPositions,3));cliffGeo.setAttribute('color',new THREE.Float32BufferAttribute(cliffColors,3));cliffGeo.setAttribute('uv',new THREE.Float32BufferAttribute(cliffUvs,2));cliffGeo.computeVertexNormals();
  add('layered-coastal-cliffs',cliffGeo,material('#ffffff',{vertexColors:true}),true);
  const sea=config.sea===true,margin=sea?Math.max(2.8,Math.min(width,depth)*.06):rimWidth*.55,extent={width:width+margin*2,depth:depth+margin*2};
  const waterMap=waterTexture(boundary,sea,extent,mouths);if(waterMap)ownedTextures.push(waterMap);
  const waterGeo=new THREE.PlaneGeometry(extent.width,extent.depth);waterGeo.rotateX(-Math.PI/2);waterGeo.translate(0,-.86,0);
  add(sea?'painted-open-sea':'soft-transparent-water-fringe',waterGeo,new THREE.MeshBasicMaterial({color:waterMap?'#ffffff':'#3e858d',map:waterMap,transparent:!sea,opacity:waterMap||sea?1:0,depthWrite:sea,toneMapped:false}),false,false);
  // River mouths replace their beach/cliff segment with a shallow water apron.
  // The terrain's river stroke supplies the landward half; no grass lip remains.
  for(const mouth of mouths){
    const n=mouth.normal,t=[-n[1],n[0]],half=mouth.width*.54,a=[mouth.point[0]-n[0]*.22,mouth.point[1]-n[1]*.22],b=[mouth.point[0]+n[0]*1.15,mouth.point[1]+n[1]*1.15];
    const positions=[],uvs=[];
    for(const [p,y,side]of[[a,.018,-1],[a,.018,1],[b,-.84,-1],[b,-.84,-1],[a,.018,1],[b,-.84,1]]){const x=p[0]+t[0]*half*side,z=p[1]+t[1]*half*side;positions.push(x,y,z);uvs.push((x+extent.width/2)/extent.width,1-(z+extent.depth/2)/extent.depth);}
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geo.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));geo.computeVertexNormals();add('river-to-sea-water-apron',geo,new THREE.MeshBasicMaterial({color:waterMap?'#ffffff':'#65a7a4',map:waterMap,side:THREE.DoubleSide,toneMapped:false}),false,false);
  }
  const rockGeo=coastStoneGeometry(),rockMaps=[0,1].map(variant=>createPaintedSurface(THREE,'stone',variant?'#b0a28c':'#aaa596',{seed:boundary.seed,variant}));
  for(const map of rockMaps)if(map)ownedTextures.push(map);
  const rockMats=rockMaps.map((map,i)=>material(map?'#ffffff':i?'#b0a28c':'#aaa596',{map,vertexColors:true})),rockBatches=[[],[]];
  let rockDistance=.3+r(),rockIndex=0;
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length],length=Math.hypot(b[0]-a[0],b[1]-a[1]);
    while(rockDistance<length){
      const t=rockDistance/length;rockDistance+=1.05+r()*1.85;
      if(beach(i)>.64&&r()<.78||r()<.18)continue;
      const x=a[0]+(b[0]-a[0])*t,z=a[1]+(b[1]-a[1])*t,n=normals[i],rotation=Math.atan2(b[1]-a[1],b[0]-a[0]);
      if(mouthAt(x,z,.32))continue;
      const size=[.82+r()*1.45,.50+r()*.60,.61+r()*.57],matrix=new THREE.Matrix4(),outward=.05+r()*.20;
      matrix.compose(new THREE.Vector3(x+n[0]*outward,-.36+r()*.12,z+n[1]*outward),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),-rotation+(r()-.5)*.46),new THREE.Vector3(...size));
      rockBatches[rockIndex++%2].push({matrix,tint:.82+r()*.30});
      if(r()<.27){const rubble=new THREE.Matrix4();rubble.compose(new THREE.Vector3(x+n[0]*.40,-.62,z+n[1]*.40),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),-rotation+.4),new THREE.Vector3(size[0]*.52,.34,.50));rockBatches[rockIndex++%2].push({matrix:rubble,tint:.82+r()*.12});}
    }
    rockDistance-=length;
  }
  let rockCount=0;
  for(let i=0;i<rockBatches.length;i++){const batch=rockBatches[i],mesh=new THREE.InstancedMesh(rockGeo,rockMats[i],batch.length);mesh.name='beveled-coast-stones';batch.forEach((item,j)=>{mesh.setMatrixAt(j,item.matrix);mesh.setColorAt(j,new THREE.Color().setScalar(item.tint));});mesh.castShadow=mesh.receiveShadow=true;mesh.computeBoundingSphere();group.add(mesh);rockCount+=batch.length;}
  group.userData={kind:'landscape',landform:'island',sea,coastline:points.map(p=>[...p]),landArea:boundary.landArea,landBounds:{...boundary.bounds},rimWidth,seaExtent:extent,riverMouths:mouths.map(m=>({point:[...m.point],width:m.width,normal:[...m.normal]})),coastStones:rockCount,groundY:0,cliffBottomY:-1.08};
  Object.defineProperty(group.userData,'ownedTextures',{value:ownedTextures,enumerable:false});
  return group;
}
