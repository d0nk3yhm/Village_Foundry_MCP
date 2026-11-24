import * as THREE from './vendor/three.module.js';
import { createPaintedSurface } from './painted-surfaces.mjs';

/** Solid, deterministic, reusable geometry. No billboards or model services. */
import { PRESETS, DEFAULT_PARAMS, normalizeHouse, houseEntrance } from './house-schema.mjs';
export { PRESETS, DEFAULT_PARAMS, normalizeHouse, houseEntrance };

const UP = new THREE.Vector3(0, 1, 0);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n)));
function seeded(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => { a += 0x6D2B79F5; let t = Math.imul(a ^ a >>> 15, 1 | a); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function color(hex, factor = 1) { return new THREE.Color(hex).multiplyScalar(factor); }
function validColor(value, fallback) { return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback; }

/** Keep procedural variations within a coherent architectural family. */
export function randomizeHouse(template = 'village', seed = 1, variation = 0.65) {
  const base = PRESETS[template] || PRESETS.village;
  const r = seeded(seed), v = clamp(variation, 0, 1);
  const vary = (n, amount) => Math.round((n + (r() * 2 - 1) * amount * v) * 10) / 10;
  const varyFlag = (key, probability) => r() < v ? r() < probability : Boolean(base[key]);
  const result = { preset: PRESETS[template] ? template : 'village', ...base, seed: Number(seed) >>> 0,
    width: clamp(vary(base.width, 1.1), 3.5, 8), depth: clamp(vary(base.depth, 1.5), 3.5, 10),
    roofPitch: Math.round(clamp(vary(base.roofPitch, 7), 35, 60)),
    chimney: varyFlag('chimney', .85), shutters: varyFlag('shutters', .52), planters: varyFlag('planters', .75),
    dormer: base.floors > 1 && varyFlag('dormer', .35), porch: varyFlag('porch', template === 'inn' ? .85 : .20),
    sideWing: template === 'village' && varyFlag('sideWing', .60),
  };
  for (const key of ['roofColor', 'woodColor', 'wallColor']) {
    const c = new THREE.Color(base[key]);
    c.offsetHSL((r() - .5) * .035 * v, (r() - .5) * .10 * v, (r() - .5) * .12 * v);
    result[key] = `#${c.getHexString()}`;
  }
  return result;
}

function shingleGeometry(variant) {
  const polygons = [
    [[-.5,-.5],[.5,-.5],[.49,.39],[.31,.47],[.08,.49],[-.20,.53],[-.48,.43]],
    [[-.5,-.5],[.5,-.5],[.48,.48],[.08,.49],[-.03,.43],[-.13,.51],[-.49,.48]],
    [[-.5,-.5],[.5,-.5],[.49,.43],[.22,.52],[-.12,.47],[-.47,.5]],
    [[-.5,-.5],[.5,-.5],[.49,.48],[.30,.48],[.29,.43],[-.13,.49],[-.48,.45]],
  ];
  const p = polygons[variant % polygons.length].map(([x,y]) => new THREE.Vector2(x,y));
  const triangles = THREE.ShapeUtils.triangulateShape(p, []);
  const positions = [], uvs = [];
  const vertex = (x,y,z) => { positions.push(x,y,z); uvs.push(x + .5, .5 - y); };
  const topGroups=[];
  for (const [j,tri] of triangles.entries()) {
    const first=positions.length/3;
    for (const i of tri) vertex(p[i].x, p[i].y, .5);
    topGroups.push({start:first,count:3,materialIndex:(variant%3===1&&j===1)||(variant===3&&j===2)?2:0});
  }
  const topCount = positions.length / 3;
  // A narrow painted/contact edge follows the irregular exposed lower lip.
  // It stays visible at a frontal camera angle where the physical thickness
  // faces away from the camera, reproducing a restrained illustrated overlap.
  for(let i=2;i<p.length-1;i++){
    const a=p[i],b=p[i+1],d=.055;
    for(const v of [[a.x,a.y,.504],[b.x,b.y,.504],[b.x,b.y-d,.504],[a.x,a.y,.504],[b.x,b.y-d,.504],[a.x,a.y-d,.504]])vertex(...v);
  }
  for (const tri of triangles) for (const i of [...tri].reverse()) vertex(p[i].x, p[i].y, -.5);
  for (let i=0; i<p.length; i++) {
    const a=p[i], b=p[(i+1)%p.length];
    for (const q of [[a.x,a.y,-.5],[b.x,b.y,-.5],[b.x,b.y,.5],[a.x,a.y,-.5],[b.x,b.y,.5],[a.x,a.y,.5]]) vertex(...q);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  for(const part of topGroups)g.addGroup(part.start,part.count,part.materialIndex);
  g.addGroup(topCount, positions.length / 3 - topCount, 1);
  g.computeVertexNormals(); return g;
}

function softenedBoxGeometry(bevel=.04) {
  const a=.5-bevel,s=new THREE.Shape();s.moveTo(-a,-a);s.lineTo(a,-a);s.lineTo(a,a);s.lineTo(-a,a);s.closePath();
  const g=new THREE.ExtrudeGeometry(s,{depth:1-2*bevel,bevelEnabled:true,bevelThickness:bevel,bevelSize:bevel,bevelSegments:1,steps:1,curveSegments:1});
  g.translate(0,0,-.5+bevel);g.clearGroups();
  const pos=g.getAttribute('position'),norm=g.getAttribute('normal'),uv=g.getAttribute('uv');
  for(let i=0;i<pos.count;i++){
    const ax=Math.abs(norm.getX(i)),ay=Math.abs(norm.getY(i)),az=Math.abs(norm.getZ(i));
    if(az>=ax&&az>=ay)uv.setXY(i,pos.getX(i)+.5,pos.getY(i)+.5);
    else if(ax>=ay)uv.setXY(i,pos.getZ(i)+.5,pos.getY(i)+.5);
    else uv.setXY(i,pos.getX(i)+.5,pos.getZ(i)+.5);
  }
  return g;
}

function reflectionGeometry(){
  const pts=[[-.40,-.46],[-.17,-.46],[.40,.31],[.40,.47],[.25,.47],[-.40,-.30]].map(([x,y])=>new THREE.Vector2(x,y));
  const pos=[];for(const tri of THREE.ShapeUtils.triangulateShape(pts,[]))for(const i of tri)pos.push(pts[i].x,pts[i].y,0);
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.computeVertexNormals();return g;
}

function gableGeometry(width, depth, rise) {
  const p = [], uv = [];
  const A=[-width/2,0,depth/2], B=[width/2,0,depth/2], C=[0,rise,depth/2];
  const D=[-width/2,0,-depth/2], E=[width/2,0,-depth/2], F=[0,rise,-depth/2];
  const tri=(a,b,c)=>{ for(const v of [a,b,c]) { p.push(...v); uv.push(v[0]/width+.5, v[1]/rise); } };
  tri(A,B,C);tri(E,D,F);tri(D,A,C);tri(D,C,F);tri(B,E,F);tri(B,F,C);tri(D,E,B);tri(D,B,A);
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.computeVertexNormals();return g;
}

/**
 * X right, Y up, +Z front. All supplied texture objects remain caller-owned.
 * Textured materials use white tint; texture sampling/wrapping are not mutated.
 */
export function buildHouse(params = {}, textures = {}, resources = {}) {
  const p=normalizeHouse(params),preset=p.preset;
  // The illustrated village style is geometry-first. Legacy photo/pixel maps
  // are never applied implicitly. A caller can explicitly opt into new maps.
  if(p.useTextures!==true)textures={};
  for(const n of [p.width,p.depth,p.floorHeight,p.roofPitch]) if(!Number.isFinite(n)) throw new Error('House dimensions must be finite numbers.');
  const r=seeded(p.seed), group=new THREE.Group();group.name=`${preset}-house`;
  const W=p.width,D=p.depth,FH=p.floorHeight,hw=W/2,hd=D/2,base=.14,wallTop=base+p.floors*FH;
  const roofRise=hw*Math.tan(THREE.MathUtils.degToRad(p.roofPitch));
  const materials=new Map(), batches=new Map(), unitBox=new THREE.BoxGeometry(1,1,1);
  const stoneBox=softenedBoxGeometry(.045),timberBox=softenedBoxGeometry(.023);
  const timberHorizontalBox=timberBox.clone();
  {
    const positions=timberHorizontalBox.getAttribute('position'),normals=timberHorizontalBox.getAttribute('normal'),uv=timberHorizontalBox.getAttribute('uv');
    for(let i=0;i<positions.count;i++)if(Math.abs(normals.getX(i))<.9)uv.setXY(i,Math.abs(normals.getY(i))>.5?positions.getZ(i)+.5:positions.getY(i)+.5,positions.getX(i)+.5);
  }
  const paneReflection=reflectionGeometry(),ownedTextures=new Set();
  // A map may own a shared cache across all its buildings. Individual houses
  // own only textures they create without that cache, so disposing a child
  // cannot invalidate its neighbours' materials.
  const sharedPaintCache=resources.paintCache instanceof Map;
  const paintCache=sharedPaintCache?resources.paintCache:new Map();
  const paint=(kind,baseColor,variant=0)=>{
    if(!p.usePaintedSurfaces)return null;
    const value=baseColor?.getHexString?`#${baseColor.getHexString()}`:baseColor,key=`${kind}:${value}:${p.paintSeed}:${variant}`;
    if(!paintCache.has(key)){const texture=createPaintedSurface(THREE,kind,value,{seed:p.paintSeed,variant});paintCache.set(key,texture);if(texture&&!sharedPaintCache)ownedTextures.add(texture);}
    return paintCache.get(key);
  };
  const roofMaps=Array.from({length:4},(_,variant)=>textures.roof||paint('shingle',p.roofColor,variant));
  const woodMap=textures.wood||paint('wood',p.woodColor,0),woodLightMap=textures.wood||paint('wood',color(p.woodColor,1.14),1);
  const stoneMap=textures.wall||paint('stone',p.stoneColor,0),stoneAltMap=textures.wall||paint('stone',p.stoneColor,1);
  const tileGeometries=Array.from({length:4},(_,i)=>shingleGeometry(i));
  const matrix=new THREE.Matrix4(), qIdentity=new THREE.Quaternion();
  const mat=(key,hex,map=null)=>{
    if(!materials.has(key)) materials.set(key,new THREE.MeshStandardMaterial({color:map?'#ffffff':hex,map:map||null,roughness:1,metalness:0,flatShading:true}));
    return materials.get(key);
  };
  const m={
    wood:mat('wood',p.woodColor,woodMap),woodDark:mat('wood-dark',color(p.woodColor,.44)),woodLight:mat('wood-light',color(p.woodColor,1.14),woodLightMap),woodWeathered:mat('wood-weathered',color(p.woodColor,1.07)),
    plaster:mat('plaster',p.wallColor,(p.wallKind==='plaster'?textures.wall:null)||paint('plaster',p.wallColor,0)),mortar:mat('mortar',preset==='source'?'#655e50':'#80755e',textures.wall),
    stone:mat('stone',p.stoneColor,stoneMap),stoneAlt:mat('stone-alt',p.stoneColor,stoneAltMap),
    brick:mat('brick',p.wallKind==='brick'?p.stoneColor:'#a46c49',stoneMap),
    roof:mat('roof',p.roofColor,roofMaps[0]),roofEdge:mat('roof-edge','#655448'),roofRidge:mat('roof-ridge',color(p.roofColor,1.07),roofMaps[1]),roofWeathered:mat('roof-weathered',color(p.roofColor,1.065)),
    glass:mat('glass','#475257'),glassLight:mat('glass-light','#6c7a80'),reflection:mat('glass-reflection','#a0acae'),lattice:mat('window-lattice','#6c5136'),void:mat('opening','#29271e'),metal:mat('iron','#433e32'),barrelBand:mat('barrel-bands','#b4a074'),
    soil:mat('soil','#514832'),leaf:mat('leaf','#788344'),leafLight:mat('leaf-light','#a4ac59'),flower:mat('flower','#f3e8c1'),flowerCore:mat('flower-core','#d2ad42'),
    foundation:mat('foundation','#8a8069',textures.ground||stoneMap),
  };
  const roofMaterials=roofMaps.map((map,i)=>textures.roof||i===0?m.roof:mat(`roof-variant-${i}`,p.roofColor,map));
  // Every shingle samples its corresponding part of one continuous roof-face
  // texture. A photograph containing many shingles is not repeated in full on
  // every modeled shingle. The caller's texture transform remains respected.
  if(textures.roof) {
    m.roof.userData.spriteRoofUv=true;
    m.roof.onBeforeCompile=shader=>{
      shader.vertexShader='attribute vec4 spriteUvTransform;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = (mapTransform * vec3(uv * spriteUvTransform.xy + spriteUvTransform.zw, 1.0)).xy;\n#endif');
    };
    m.roof.customProgramCacheKey=()=> 'procedural-roof-surface-uv-v1';
  }
  function instance(geometry,material,position,size,quaternion=qIdentity,tint=null,name='details',uvTransform=null) {
    if(size.some(v=>!Number.isFinite(v)||v<=0)||position.some(v=>!Number.isFinite(v))) return;
    const materialKey=Array.isArray(material)?material.map(x=>x.uuid).join('|'):material.uuid;
    const key=`${geometry.uuid}:${materialKey}:${name}`;
    let batch=batches.get(key);if(!batch){batch={geometry,material,name,matrices:[],colors:[],uvs:[]};batches.set(key,batch);}
    matrix.compose(new THREE.Vector3(...position),quaternion,new THREE.Vector3(...size));
    batch.matrices.push(matrix.clone());batch.colors.push(tint||new THREE.Color(1,1,1));batch.uvs.push(uvTransform||[1,1,0,0]);
  }
  function box(position,size,material=m.wood,quaternion=qIdentity,tint=null,name='carpentry') {
    const g=(material===m.stone||material===m.stoneAlt||material===m.brick||material===m.foundation)?stoneBox:(material===m.wood||material===m.woodLight)?(size[0]>size[1]*1.5?timberHorizontalBox:timberBox):unitBox;
    instance(g,material,position,size,quaternion,tint,name);
  }
  function beam(a,b,thickness=.14,depth=.14,material=m.wood,name='timber-frame') {
    const av=new THREE.Vector3(...a),bv=new THREE.Vector3(...b),delta=bv.clone().sub(av),length=delta.length();
    if(length<1e-6)return;const q=new THREE.Quaternion().setFromUnitVectors(UP,delta.clone().normalize());
    box(av.add(bv).multiplyScalar(.5).toArray(),[thickness,length,depth],material,q,null,name);
  }
  function mesh(geometry,material,position=[0,0,0],name='detail',rotation=null) {
    const item=new THREE.Mesh(geometry,material);item.position.set(...position);if(rotation)item.rotation.set(...rotation);item.castShadow=true;item.receiveShadow=true;item.name=name;group.add(item);return item;
  }
  const faces={front:{n:[0,0,1],t:[1,0,0],origin:[0,0,hd],angle:0,width:W},back:{n:[0,0,-1],t:[-1,0,0],origin:[0,0,-hd],angle:Math.PI,width:W},left:{n:[-1,0,0],t:[0,0,1],origin:[-hw,0,0],angle:-Math.PI/2,width:D},right:{n:[1,0,0],t:[0,0,-1],origin:[hw,0,0],angle:Math.PI/2,width:D}};
  function facePoint(face,u,y,offset=0) { const f=typeof face==='string'?faces[face]:face;return [f.origin[0]+f.t[0]*u+f.n[0]*offset,y,f.origin[2]+f.t[2]*u+f.n[2]*offset]; }
  function faceBox(face,u,y,offset,width,height,depth,material,tint=null,name='facade') {
    const f=typeof face==='string'?faces[face]:face;
    box(facePoint(f,u,y,offset),[width,height,depth],material,new THREE.Quaternion().setFromAxisAngle(UP,f.angle),tint,name);
  }
  function faceBeam(face,u1,y1,u2,y2,offset=.1,thick=.13,material=m.wood) {beam(facePoint(face,u1,y1,offset),facePoint(face,u2,y2,offset),thick,thick,material);}

  // Recessed openings are planned before masonry so blocks do not cross them.
  const openings={front:[],back:[],left:[],right:[]};
  const entrance=houseEntrance(p),doorX=entrance.door.x,doorW=entrance.door.width,doorH=entrance.door.height;
  openings.front.push({u:doorX,y:base+doorH/2,w:doorW+.2,h:doorH+.13,door:true});
  const windows=[];
  for(let floor=0;floor<p.floors;floor++) {
    const cy=base+floor*FH+FH*.55;
    let xs=floor===0?(preset==='source'?[0,hw*.46,hw*.88]:preset==='cottage'?[-hw*.64,hw*.64]:[-hw*.48]):(W>6?[-hw*.65,0,hw*.65]:[-hw*.5,hw*.5]);
    const ww=floor===0?.58:Math.min(.88,W*.18),wh=floor===0?FH*.50:FH*.52;
    if(preset==='source')xs=xs.map(x=>Math.min(hw-ww*.65,x));
    for(const x of xs)windows.push({face:'front',u:x,y:cy,w:ww,h:wh,floor,lattice:floor===0});
    for(const face of ['back','left','right']) {
      const width=faces[face].width,positions=width>6?[-width*.31,0,width*.31]:[-width*.25,width*.25];
      for(const u of positions)windows.push({face,u,y:cy,w:floor===0?.58:.82,h:wh,floor,lattice:floor===0});
    }
  }
  for(const w of windows)openings[w.face].push({u:w.u,y:w.y,w:w.w+.15,h:w.h+.16});
  const overlaps=(holes,u,y,w,h)=>holes.some(a=>Math.abs(a.u-u)<(a.w+w)/2+.025&&Math.abs(a.y-y)<(a.h+h)/2+.025);

  box([0,.07,0],[W+.14,.14,D+.14],m.foundation,qIdentity,null,'foundation');
  for(let floor=0;floor<p.floors;floor++) {
    const y0=base+floor*FH,y1=y0+FH;
    const plaster=p.wallKind==='plaster'||(p.timber&&floor>0);
    const boardInfill=preset==='village'&&floor>0;
    box([0,(y0+y1)/2,0],[W,FH,D],boardInfill?m.wood:plaster?m.plaster:m.mortar,qIdentity,null,'enclosed-walls');
    if(boardInfill)for(const f of Object.values(faces)){
      const count=Math.ceil(f.width/.48),step=f.width/count;
      for(let i=0;i<count;i++)faceBox(f,-f.width/2+(i+.5)*step,(y0+y1)/2,.025,step-.018,FH-.17,.055,m.woodLight,new THREE.Color().setScalar(.94+r()*.10),'wide-wall-boards');
    }
    if(!plaster) {
      for(const [name,f] of Object.entries(faces)) {
        const rows=Math.max(3,Math.round(FH/(p.wallKind==='brick'?.27:.43))),rh=FH/rows;
        const nominal=p.wallKind==='brick'?.56:.90;
        for(let row=0;row<rows;row++) {
          const shift=(row%2)*nominal*.5;let start=-f.width/2-shift;
          while(start<f.width/2-.02) {
            const end=Math.min(f.width/2,start+nominal*(.9+r()*.2)),lo=Math.max(-f.width/2,start);
            const cy=y0+(row+.5)*rh;let pieces=[[lo,end]];
            for(const opening of openings[name])if(Math.abs(opening.y-cy)<(opening.h+rh)/2+.01){
              const a=opening.u-opening.w/2-.025,b=opening.u+opening.w/2+.025,next=[];
              for(const [pl,pr]of pieces){if(b<=pl||a>=pr)next.push([pl,pr]);else{if(a>pl)next.push([pl,a]);if(b<pr)next.push([b,pr]);}}pieces=next;
            }
            for(const [pl,pr]of pieces)if(pr-pl>.12)faceBox(f,(pl+pr)/2,cy,.037,pr-pl-.022,rh-.024,.085,p.wallKind==='brick'?m.brick:r()>.5?m.stone:m.stoneAlt,new THREE.Color().setScalar(.91+r()*.16),'masonry');
            start=end+.013;
          }
        }
      }
    }
    // Chunky corner stones and a belt course remain visible with photo textures.
    if(!plaster)for(let row=0;row<Math.ceil(FH/.37);row++) {
      const yy=y0+.18+row*.37;if(yy>y1-.06)continue;
      for(const x of [-hw,hw])for(const z of [-hd,hd])box([x,yy,z],[row%2?.32:.42,.29,row%2?.42:.32],m.stone,qIdentity,new THREE.Color().setScalar(.88+r()*.21),'corner-stones');
    }
    if(p.timber)for(const [name,f] of Object.entries(faces)) {
      const edge=f.width/2-.055;
      faceBox(f,0,y0+.07,.10,f.width+.14,.17,.16,m.woodDark,null,'floor-bands');
      faceBox(f,0,y0+.105,.19,f.width+.12,.06,.045,m.woodLight,null,'floor-band-highlight');
      if(floor>0||p.wallKind==='plaster') {
        for(const u of [-edge,0,edge])faceBox(f,u,(y0+y1)/2,.105,.15,FH,.17,m.wood,null,'timber-posts');
        // Braces occupy the outer panel corners and stop below the window.
        faceBeam(f,-edge+.10,y0+.19,-edge+Math.min(.78,f.width*.18),y0+FH*.48,.105,.10,m.woodLight);
        faceBeam(f,edge-.10,y0+.19,edge-Math.min(.78,f.width*.18),y0+FH*.48,.105,.10,m.woodLight);
        // Sparse raised wooden infill strips add readable façade depth.
        // Broad quiet panels replace the old densely striped infill. The
        // modeled frame and its softened edge highlights carry the detail.
      }
    }
  }

  function window(w,faceOverride=null) {
    const f=faceOverride||w.face,u=w.u,y=w.y,ww=w.w,hh=w.h;
    faceBox(f,u,y,.086,ww+.16,hh+.18,.12,m.woodDark,null,'window-recess');
    faceBox(f,u,y,.157,ww-.015,hh-.015,.035,m.void,null,'window-shadow');
    if(w.lattice) {
      faceBox(f,u,y,.18,ww-.10,hh-.11,.025,m.glass,null,'window-glass');
      // Two visible diamonds, bounded inside the actual opening.
      const dx=ww*.28,dy=hh*.24;
      for(const cy of [y-hh*.19,y+hh*.19]) {
        faceBeam(f,u-dx,cy,u,cy+dy,.205,.027,m.lattice);faceBeam(f,u,cy+dy,u+dx,cy,.205,.027,m.lattice);
        faceBeam(f,u+dx,cy,u,cy-dy,.205,.027,m.lattice);faceBeam(f,u,cy-dy,u-dx,cy,.205,.027,m.lattice);
      }
    } else {
      for(const sx of [-1,1])for(const sy of [-1,1]){
        const px=u+sx*ww*.24,py=y+sy*hh*.23;
        faceBox(f,px,py,.182,ww*.43,hh*.40,.025,sx===-1&&sy===1?m.glassLight:m.glass,null,'window-panes');
        const frame=typeof f==='string'?faces[f]:f;
        instance(paneReflection,m.reflection,facePoint(frame,px,py,.199),[ww*.40,hh*.37,1],new THREE.Quaternion().setFromAxisAngle(UP,frame.angle),null,'glass-reflections');
      }
      faceBox(f,u,y,.22,.055,hh,.06,m.wood,null,'window-mullions');faceBox(f,u,y,.22,ww,.06,.06,m.wood,null,'window-mullions');
    }
    for(const sx of [-1,1])faceBox(f,u+sx*(ww/2+.027),y,.22,.10,hh+.16,.11,m.woodLight,null,'window-frame');
    for(const sy of [-1,1])faceBox(f,u,y+sy*(hh/2+.026),.22,ww+.18,.09,.11,m.woodLight,null,'window-frame');
    faceBox(f,u,y-hh/2-.10,.25,ww+.24,.10,.22,m.wood,null,'window-sills');
    if(p.shutters&&w.floor!==undefined)for(const side of [-1,1]) {
      const sw=Math.min(.28,ww*.40),su=u+side*(ww/2+sw/2+.12);
      const shutterMat=preset==='source'?m.roof: m.wood;
      faceBox(f,su,y,.12,sw,hh+.04,.09,m.woodDark,null,'shutters');
      for(let k=0;k<3;k++)faceBox(f,su+(k-1)*sw/3,y,.18,sw/3-.013,hh-.02,.07,shutterMat,null,'shutter-boards');
      for(const sy of [-1,1])faceBox(f,su,y+sy*hh*.30,.23,sw+.025,.055,.04,m.woodLight,null,'shutter-crossbars');
    }
  }
  windows.forEach(w=>window(w));

  // Boarded doorway, lintel, hinges, threshold, and a real ring handle.
  const doorCY=base+doorH/2;
  faceBox('front',doorX,doorCY,.08,doorW+.18,doorH+.1,.15,m.woodDark,null,'door-opening');
  for(let k=0;k<5;k++)faceBox('front',doorX-doorW/2+(k+.5)*doorW/5,doorCY,.18,doorW/5-.014,doorH-.04,.09,m.woodLight,new THREE.Color().setScalar(.81+r()*.22),'door-boards');
  for(const side of [-1,1])faceBox('front',doorX+side*(doorW/2+.065),doorCY,.21,.13,doorH+.15,.17,m.wood,null,'door-frame');
  faceBox('front',doorX,base+doorH+.07,.23,doorW+.31,.16,.19,m.woodLight,null,'door-lintel');
  for(const sy of [.25,.73])faceBox('front',doorX-doorW*.25,base+doorH*sy,.25,doorW*.42,.065,.04,m.metal,null,'door-hinges');
  {const step=entrance.doorStep;box([step.x,step.y,step.z],[step.width,step.height,step.depth],m.foundation,qIdentity,null,'door-step');}
  const ringGeo=new THREE.TorusGeometry(.095,.022,5,12);
  mesh(ringGeo,m.metal,[doorX+doorW*.26,base+doorH*.46,hd+.30],'door-ring');
  faceBox('front',doorX+doorW*.26,base+doorH*.51,.275,.11,.13,.04,m.metal,null,'door-handle-plate');

  const chimneyX=preset==='source'?hw*.78:-hw*.61,chimneyZ=preset==='source'?-hd*.58:-D*.12;
  const dormerBounds=p.dormer?{x:hw*.64,z:D*.09,w:1.0,d:1.18}:null;
  function roof(cx,cz,width,depth,eaveY,pitchDegrees,{mini=false,gableMat=m.plaster,bodyGable=true,name='main-roof',exclude=true}={}) {
    const pitch=THREE.MathUtils.degToRad(pitchDegrees),c=Math.cos(pitch),s=Math.sin(pitch),overhang=mini?.16:.31;
    const half=width/2,extent=half+overhang,peak=eaveY+half*Math.tan(pitch),length=depth+2*overhang,slope=extent/c;
    if(bodyGable)mesh(gableGeometry(width,depth,half*Math.tan(pitch)),gableMat,[cx,eaveY,cz],`${name}-enclosed-gable`);
    for(const side of [-1,1]) {
      const along=new THREE.Vector3(0,0,side),down=new THREE.Vector3(side*c,-s,0),normal=new THREE.Vector3(side*s,c,0);
      const orientation=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(along,down,normal));
      const center=[cx+side*slope*.5*c,peak-slope*.5*s,cz];
      box(center,[length,slope,.13],m.woodDark,orientation,null,`${name}-roof-deck`);
      const strideTarget=p.roofKind==='metal'?.90:p.roofKind==='thatch'?.48:(mini?.43:.58);
      const rows=Math.max(2,Math.ceil(slope/strideTarget)),stride=slope/rows;
      const tileWidth=p.roofKind==='metal'?.90:p.roofKind==='thatch'?.34:(mini?.52:.79);
      const columns=Math.max(2,Math.ceil(length/tileWidth)),step=length/columns;
      for(let row=0;row<rows;row++) {
        const distance=slope-(row+.50)*stride,overlap=p.roofKind==='thatch'?1.46:1.26;
        const stagger=(row%2)*step*.5;
        for(let col=-1;col<columns;col++) {
          const z0=Math.max(-length/2,-length/2+col*step+stagger),z1=Math.min(length/2,-length/2+(col+1)*step+stagger);
          if(z1-z0<.07)continue;
          const xx=cx+side*distance*c,zz=cz+(z0+z1)/2;
          const layer=.085+row*.011+(r()-.5)*.008;
          const position=[xx+normal.x*layer,peak-distance*s+normal.y*layer,zz];
          const shade=textures.roof?.isTexture ? .94+r()*.06 : .84+r()*.30;
          const tint=new THREE.Color().setScalar(shade);
          const variant=p.roofKind==='metal'?0:Math.floor(r()*4);
          const g=p.roofKind==='metal'?unitBox:tileGeometries[variant];
          const faceMaterial=roofMaterials[variant],material=p.roofKind==='metal'?m.roof:[faceMaterial,m.roofEdge,roofMaps[variant]?faceMaterial:m.roofWeathered];
          const tileLength=Math.min(stride*overlap,2*distance+.012);
          const uvTransform=[(z1-z0)/length,-tileLength/slope,
            (side>0?z0+length/2:length/2-z1)/length,(distance+tileLength/2)/slope];
          instance(g,material,position,[z1-z0-(p.roofKind==='thatch'?.009:.014),tileLength,.065+(p.roofKind==='thatch'?.02:0)],orientation,tint,`${name}-${p.roofKind}`,uvTransform);
          if(p.roofKind==='metal')box([position[0]+normal.x*.04,position[1]+normal.y*.04,zz+(z1-z0)*.44],[.025,stride*1.24,.055],m.roofRidge,orientation,null,`${name}-standing-seams`);
        }
      }
      // Dark end grain under the eaves and projecting rafter tails.
      box([cx+side*extent,peak-slope*s-.035,cz],[.16,.17,length+.05],m.woodDark,qIdentity,null,`${name}-eaves`);
      if(!mini&&p.exposedRafters)for(let z=-depth/2+.35;z<depth/2;z+=1.08)beam(
        [cx+side*(half-.10),eaveY+.10*Math.tan(pitch)-.18,cz+z],
        [cx+side*(extent+.015),eaveY-(overhang+.015)*Math.tan(pitch)-.18,cz+z],.13,.13,m.woodDark,'rafter-tails');
    }
    // The front and back fascia follow the real roof slopes.
    for(const zside of [-1,1])for(const side of [-1,1]) {
      const z=cz+zside*(length/2+.015);
      beam([cx,peak+.02,z],[cx+side*extent,peak-extent*Math.tan(pitch)+.02,z],mini?.10:.16,mini?.12:.20,m.woodDark,`${name}-fascia`);
      beam([cx,peak+.045,z+zside*.065],[cx+side*extent,peak-extent*Math.tan(pitch)+.045,z+zside*.065],mini?.045:.065,.055,m.woodLight,`${name}-fascia-highlight`);
    }
    // Individually overlapping ridge pieces, never one featureless cylinder.
    const capCount=Math.ceil(length/.54),capLength=length/capCount;
    box([cx,peak+.15,cz],[.23,.075,length],m.roofEdge,qIdentity,null,`${name}-ridge-underlay`);
    for(let i=0;i<capCount;i++)for(const side of [-1,1]) {
      const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),-side*pitch);
      box([cx+side*.068,peak+.22+(i%2)*.008,cz-length/2+(i+.5)*capLength],[.20,.075,capLength-.024],m.roofRidge,q,new THREE.Color().setScalar(.85+r()*.27),`${name}-ridge-caps`);
    }
    return {peak,eaveY,extent,length,rise:half*Math.tan(pitch)};
  }

  const gableMat=(p.wallKind==='stone'&&!p.timber)?m.mortar:preset==='village'?m.woodLight:m.plaster;
  const mainRoof=roof(0,0,W,D,wallTop,p.roofPitch,{gableMat});
  // Actual front and rear gable carpentry and a small attic window.
  for(const [name,f]of Object.entries(faces).filter(([name])=>name==='front'||name==='back')) {
    faceBox(f,0,wallTop+.015,.09,W+.05,.17,.15,m.woodDark,null,'gable-base-beam');
    faceBeam(f,-hw+.08,wallTop+.05,0,wallTop+roofRise-.06,.09,.14,m.wood);
    faceBeam(f,0,wallTop+roofRise-.06,hw-.08,wallTop+.05,.09,.14,m.wood);
    if(p.timber) {
      faceBeam(f,0,wallTop+.06,0,wallTop+roofRise-.08,.10,.13,m.wood);
      for(const side of [-1,1])faceBeam(f,side*W*.22,wallTop+.06,side*W*.22,wallTop+roofRise*.50,.10,.105,m.woodLight);
      for(let u=-hw+.27;u<hw;u+=.48) {
        const h=roofRise*(1-(Math.abs(u)+.23)/hw)-.12;
        if(h>.15&&Math.abs(u)>.44)faceBox(f,u,wallTop+h/2+.06,.035,.455,h,.035,m.woodLight,new THREE.Color().setScalar(.94+r()*.09),'gable-board-infill');
      }
    } else {
      const rows=Math.floor(roofRise/.27);
      for(let row=0;row<rows;row++) {
        const yy=wallTop+.14+row*.27,limit=hw*(1-(yy-wallTop+.14)/roofRise);
        for(let x=-limit+.2;x<limit-.1;x+=.5) {
          if(Math.abs(x)<.43&&Math.abs(yy-(wallTop+roofRise*.28))<.4)continue;
          faceBox(f,x,yy,.025,Math.min(.47,2*(limit-Math.abs(x))),.245,.06,m.stone,new THREE.Color().setScalar(.82+r()*.27),'gable-masonry');
        }
      }
    }
    if(roofRise>.8)window({face:name,u:0,y:wallTop+roofRise*.29,w:.54,h:Math.min(.56,roofRise*.32),lattice:true});
  }

  if(p.chimney) {
    const cw=preset==='source'?.42:.66,cd=preset==='source'?.46:.72;
    const localRoofY=wallTop+(hw-Math.abs(chimneyX))*Math.tan(THREE.MathUtils.degToRad(p.roofPitch));
    const bottom=localRoofY-(cw/2+.06)*Math.tan(THREE.MathUtils.degToRad(p.roofPitch))-.12,top=mainRoof.peak+(preset==='source'?.30:.50),height=top-bottom;
    box([chimneyX,bottom+height/2,chimneyZ],[cw,height,cd],m.mortar,qIdentity,null,'chimney-body');
    for(let row=0;row<Math.ceil(height/.23);row++) {
      const yy=bottom+.11+row*.23;if(yy>top-.03)continue;
      for(const side of [-1,1]) {
        for(let k=0;k<2;k++) {
          box([chimneyX+(k-.5)*cw/2,yy,chimneyZ+side*(cd/2+.012)],[cw/2-.025,.205,.045],m.stone,qIdentity,new THREE.Color().setScalar(.8+r()*.27),'chimney-stones');
          box([chimneyX+side*(cw/2+.012),yy,chimneyZ+(k-.5)*cd/2],[.045,.205,cd/2-.025],m.stone,qIdentity,new THREE.Color().setScalar(.8+r()*.27),'chimney-stones');
        }
      }
    }
    box([chimneyX,top+.045,chimneyZ],[cw+.16,.13,cd+.16],m.stone,qIdentity,null,'chimney-cap');
    box([chimneyX,top+.118,chimneyZ],[cw*.58,.018,cd*.58],m.void,qIdentity,null,'chimney-opening');
    for(const side of [-1,1]) {
      box([chimneyX+side*(cw/2+.025),top+.16,chimneyZ],[.11,.12,cd+.15],m.roofEdge,qIdentity,null,'chimney-rim');
      box([chimneyX,top+.16,chimneyZ+side*(cd/2+.025)],[cw+.15,.12,.11],m.roofEdge,qIdentity,null,'chimney-rim');
    }
  }

  if(p.sideWing) {
    const ww=Math.min(1.6,W*.33),wd=Math.min(2.8,D*.47),wx=-hw-ww*.43,wz=hd-wd/2-.38,wy=base+FH*(p.floors>1?1.52:.94);
    box([wx,base+(wy-base)/2,wz],[ww,wy-base,wd],m.mortar,qIdentity,null,'side-wing-walls');
    const wf={n:[0,0,1],t:[1,0,0],origin:[wx,0,wz+wd/2],angle:0,width:ww};
    const wingRows=Math.ceil((wy-base)/.42),wingCourse=(wy-base)/wingRows;
    for(let row=0;row<wingRows;row++)for(let col=0;col<3;col++)faceBox(wf,(col-1)*ww/3,base+(row+.5)*wingCourse,.03,ww/3-.025,wingCourse-.025,.07,row%2?m.stone:m.stoneAlt,new THREE.Color().setScalar(.91+r()*.15),'side-wing-stones');
    roof(wx,wz,ww,wd,wy,p.roofPitch,{mini:true,gableMat:m.mortar,name:'side-wing-roof',exclude:false});
    window({u:0,y:base+FH*.55,w:.48,h:.74,lattice:true},wf);
    if(p.floors>1)window({u:0,y:base+FH*1.22,w:.43,h:.57,lattice:true},wf);
    // Fully enclosed outer wall with projecting stone courses.
    for(let row=0;row<wingRows;row++)for(let col=0;col<4;col++)box([wx-ww/2-.02,base+(row+.5)*wingCourse,wz-wd/2+(col+.5)*wd/4],[.07,wingCourse-.025,wd/4-.03],row%2?m.stone:m.stoneAlt,qIdentity,new THREE.Color().setScalar(.91+r()*.16),'side-wing-stones');
  }

  if(p.dormer) {
    // A solid side-facing dormer with its own gabled roof and glass recess.
    const dx=hw*.64,dz=D*.09,dw=1.04,dd=.85;
    const y=wallTop+(hw-(dx+dd/2))*Math.tan(THREE.MathUtils.degToRad(p.roofPitch))+.015;
    box([dx,y+.36,dz],[dd,.72,dw],m.plaster,qIdentity,null,'dormer-body');
    // Local roof assembled as a group, then turned 90 degrees around Y.
    const before=new Set(group.children),oldBatches=new Set(batches.keys());
    const marker='dormer-roof';
    roof(0,0,dw,dd,y+.72,42,{mini:true,gableMat:m.plaster,name:marker,exclude:false});
    // Transform both direct gable geometry and queued instance matrices.
    const turn=new THREE.Matrix4().makeRotationY(Math.PI/2);turn.setPosition(dx,0,dz);
    for(const child of group.children)if(!before.has(child)){child.applyMatrix4(turn);}
    for(const [key,b]of batches)if(!oldBatches.has(key)&&b.name.startsWith(marker))for(const mtx of b.matrices)mtx.premultiply(turn);
    const df={n:[1,0,0],t:[0,0,-1],origin:[dx+dd/2,0,dz],angle:Math.PI/2,width:dw};
    window({u:0,y:y+.39,w:.58,h:.48,lattice:false},df);
    faceBox(df,0,y+.04,.12,dw+.10,.10,.13,m.wood,null,'dormer-sill');
  }

  if(p.porch) {
    const {width:pw,depth:pd,z:pz,roofY:py,deck,step}=entrance.porch;
    for(const side of [-1,1])box([doorX+side*(pw/2-.10),py/2,pz+pd/2-.10],[.15,py,.15],m.wood,qIdentity,null,'porch-posts');
    box([doorX,py-.10,pz+pd/2-.10],[pw,.18,.18],m.woodDark,qIdentity,null,'porch-crossbeam');
    roof(doorX,pz,pw,pd,py,30,{mini:true,gableMat:m.wood,name:'porch-roof',exclude:false});
    box([deck.x,deck.y,deck.z],[deck.width,deck.height,deck.depth],m.wood,qIdentity,null,'porch-deck');
    box([step.x,step.y,step.z],[step.width,step.height,step.depth],m.foundation,qIdentity,null,'porch-step');
  }

  function barrel(x,z,scale=1) {
    const y=base+.36*scale;
    mesh(new THREE.CylinderGeometry(.27*scale,.27*scale,.70*scale,12,1,false),m.wood,[x,y,z],'barrel-staves');
    mesh(new THREE.CylinderGeometry(.29*scale,.29*scale,.08*scale,12),m.woodLight,[x,y+.35*scale,z],'barrel-lid');
    const bandGeo=new THREE.TorusGeometry(.283*scale,.035*scale,6,16);
    for(const yy of [-.23,.23])mesh(bandGeo,m.barrelBand,[x,y+yy*scale,z],'barrel-bands',[Math.PI/2,0,0]);
    for(let i=0;i<12;i++) {
      const a=i*Math.PI/6,q=new THREE.Quaternion().setFromAxisAngle(UP,a);
      box([x+Math.sin(a)*.273*scale,y,z+Math.cos(a)*.273*scale],[.013*scale,.66*scale,.018*scale],m.woodDark,q,null,'barrel-joints');
    }
  }
  if(p.planters) {
    const planterX=preset==='cottage'?-hw*.64:-hw*.48,pw=Math.min(1.45,W*.30),pz=hd+.39;
    box([planterX,.23,pz],[pw,.35,.53],m.woodDark,qIdentity,null,'planter-box');
    box([planterX,.405,pz],[pw-.13,.025,.39],m.soil,qIdentity,null,'planter-soil');
    for(let i=0;i<Math.ceil(pw/.19);i++)box([planterX-pw/2+(i+.5)*pw/Math.ceil(pw/.19),.24,pz+.285],[pw/Math.ceil(pw/.19)-.014,.31,.065],m.woodLight,qIdentity,null,'planter-boards');
    for(const side of [-1,1])box([planterX+side*pw/2,.25,pz],[.07,.40,.62],m.wood,qIdentity,null,'planter-corners');
    const leafGeo=new THREE.IcosahedronGeometry(1,1),flowerGeo=new THREE.IcosahedronGeometry(1,1);
    for(let i=0;i<24;i++) {
      const x=planterX+(r()-.5)*pw*.9,z=pz+(r()-.5)*.35,y=.45+r()*.13;
      const lh=.08+r()*.055;
      instance(leafGeo,i%3?m.leafLight:m.leaf,[x,y,z],[.105+r()*.055,lh,.105+r()*.06],qIdentity,new THREE.Color().setScalar(.86+r()*.22),'planter-foliage');
      if(i%3===0){
        for(let j=0;j<5;j++){const a=j*Math.PI*2/5;instance(flowerGeo,m.flower,[x+Math.cos(a)*.034,y+lh+.027,z+Math.sin(a)*.034],[.030,.014,.030],qIdentity,null,'planter-flowers');}
        instance(flowerGeo,m.flowerCore,[x,y+lh+.035,z],[.019,.016,.019],qIdentity,null,'flower-centres');
      }
    }
    // Barrel is deliberately beside the façade, clear of the doorway path.
    barrel(-hw-.35,hd-.05,.95);
  }

  let instanceCount=0;
  for(const batch of batches.values()) {
    const materialList=Array.isArray(batch.material)?batch.material:[batch.material];
    let geometry=batch.geometry;
    if(materialList.some(material=>material.userData.spriteRoofUv)) {
      geometry=geometry.clone();geometry.setAttribute('spriteUvTransform',new THREE.InstancedBufferAttribute(new Float32Array(batch.uvs.flat()),4));
    }
    const item=new THREE.InstancedMesh(geometry,batch.material,batch.matrices.length);item.name=batch.name;
    for(let i=0;i<batch.matrices.length;i++){item.setMatrixAt(i,batch.matrices[i]);item.setColorAt(i,batch.colors[i]);}
    item.instanceMatrix.needsUpdate=true;if(item.instanceColor)item.instanceColor.needsUpdate=true;
    item.castShadow=true;item.receiveShadow=true;item.computeBoundingSphere();group.add(item);instanceCount+=batch.matrices.length;
  }
  group.updateMatrixWorld(true);
  const bounds=new THREE.Box3().setFromObject(group),size=bounds.getSize(new THREE.Vector3());
  group.userData={params:p,preset,parts:group.children.length,instances:instanceCount,entrance,
    bounds:{min:bounds.min.toArray(),max:bounds.max.toArray(),size:size.toArray()},
    frontage:'+Z',ridgeAxis:'Z',geometry:'enclosed procedural 3D house',
    textureContract:'Textures stay caller-owned; mapped materials use white tint.',
  };
  Object.defineProperty(group.userData,'ownedTextures',{value:[...ownedTextures],enumerable:false});
  return group;
}

/** Release this house's geometry/materials, retaining caller-owned textures. */
export function disposeHouse(group) {
  if(!group)return;const geometries=new Set(),materials=new Set(),ownedTextures=new Set();
  group.traverse(object=>{if(object.geometry)geometries.add(object.geometry);const list=Array.isArray(object.material)?object.material:[object.material];for(const m of list)if(m)materials.add(m);for(const texture of object.userData?.ownedTextures||[])ownedTextures.add(texture);if(object.isInstancedMesh)object.dispose();});
  for(const geometry of geometries)geometry.dispose();for(const material of materials)material.dispose();
  for(const texture of ownedTextures)texture.dispose();
  group.removeFromParent();group.clear();
}
