export const PRESETS = Object.freeze({
  source: { label: 'Red-roof stone house', width: 4.8, depth: 4.8, floors: 1, floorHeight: 1.8, roofPitch: 45, roofColor: '#a8472c', wallColor: '#a29b88', woodColor: '#73502f', roofKind: 'tiles', wallKind: 'stone', timber: false, chimney: true, dormer: false, porch: false, shutters: true, planters: false, sideWing: false },
  village: { label: 'Village merchant house', width: 4.8, depth: 6, floors: 2, floorHeight: 1.8, roofPitch: 47, roofColor: '#878984', wallColor: '#ddc69b', woodColor: '#a17f50', roofKind: 'shingles', wallKind: 'stone', timber: true, chimney: true, dormer: false, porch: false, shutters: false, planters: true, sideWing: true },
  inn: { label: 'Timber village inn', width: 6.3, depth: 7.4, floors: 3, floorHeight: 1.7, roofPitch: 43, roofColor: '#99513a', wallColor: '#e4d2a8', woodColor: '#67482d', roofKind: 'tiles', wallKind: 'plaster', timber: true, chimney: true, dormer: true, porch: true, shutters: true, planters: true, sideWing: false },
  manor: { label: 'Stone guild manor', width: 6.1, depth: 7, floors: 3, floorHeight: 1.8, roofPitch: 49, roofColor: '#496b65', wallColor: '#ada58d', woodColor: '#53432f', roofKind: 'shingles', wallKind: 'stone', timber: false, chimney: true, dormer: true, porch: false, shutters: false, planters: true, sideWing: false },
  cottage: { label: 'Thatched cottage', width: 4.4, depth: 5.1, floors: 1, floorHeight: 1.8, roofPitch: 53, roofColor: '#b79a50', wallColor: '#d8c49b', woodColor: '#725331', roofKind: 'thatch', wallKind: 'plaster', timber: true, chimney: true, dormer: false, porch: false, shutters: true, planters: true, sideWing: false },
});

export const DEFAULT_PARAMS = Object.freeze({ preset: 'village', ...PRESETS.village, stoneColor:'#a69d88', useTextures:false, usePaintedSurfaces:true, exposedRafters:false, seed: 1847 });


export const HOUSE_PRESETS=PRESETS;
const safeNumber=(n,f)=>Number.isFinite(Number(n))?Number(n):f;
const clampNumber=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));
const safeColor=(v,f)=>typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v)?v:f;
/** Shared browser/service normalization; model-free and DOM-free. */
export function normalizeHouse(raw={}) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('House configuration must be an object.');
  const preset=Object.hasOwn(PRESETS,raw.preset)?raw.preset:'village',base={...DEFAULT_PARAMS,...PRESETS[preset],preset};
  const out={...base,width:clampNumber(safeNumber(raw.width,base.width),3,8),depth:clampNumber(safeNumber(raw.depth,base.depth),3,10),
    floors:Math.round(clampNumber(safeNumber(raw.floors,base.floors),1,3)),floorHeight:clampNumber(safeNumber(raw.floorHeight,base.floorHeight),1.45,2.25),
    roofPitch:clampNumber(safeNumber(raw.roofPitch,base.roofPitch),25,65),seed:safeNumber(raw.seed,base.seed)>>>0};
  out.paintSeed=safeNumber(raw.paintSeed,out.seed)>>>0;
  for(const key of ['roofColor','wallColor','woodColor'])out[key]=safeColor(raw[key],base[key]);
  out.stoneColor=safeColor(raw.stoneColor,preset==='source'?out.wallColor:'#a69d88');
  for(const key of ['chimney','dormer','porch','shutters','planters','sideWing','timber','useTextures','usePaintedSurfaces','exposedRafters'])out[key]=typeof raw[key]==='boolean'?raw[key]:Boolean(base[key]);
  out.roofKind=['tiles','shingles','thatch','metal'].includes(raw.roofKind)?raw.roofKind:base.roofKind;
  out.wallKind=['stone','brick','plaster'].includes(raw.wallKind)?raw.wallKind:base.wallKind;
  for(const name of ['materials','tints','paletteBase'])if(raw[name]&&typeof raw[name]==='object'&&!Array.isArray(raw[name])){
    out[name]={};for(const key of ['roof','wall','wood','ground']){const value=raw[name][key];if(name==='materials'?typeof value==='string'&&/^[a-z0-9_-]{1,80}$/i.test(value):typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value))out[name][key]=value;}
  }
  return out;
}

/**
 * Canonical local entrance geometry. X is right; +Z is the house frontage.
 * The returned x/z/width describe a ground path whose end overlaps the outer
 * stone step by 0.30 world units. Transform these with the house's translation
 * and Y rotation. door and thresholdZ identify the actual door-leaf face.
 */
export function houseEntrance(raw={}){
  const p=normalizeHouse(raw),halfWidth=p.width/2,front=p.depth/2;
  const x=p.preset==='source'?-halfWidth*.72:p.preset==='cottage'?0:halfWidth*.53;
  const doorWidth=Math.min(.98,p.width*.22),doorHeight=p.floorHeight*.83;
  const door={x,y:.14+doorHeight/2,z:front+.225,width:doorWidth,height:doorHeight};
  const doorStep={x,y:.11,z:front+.33,width:doorWidth+.42,height:.22,depth:.62};
  let porch=null;
  if(p.porch){
    const width=Math.min(2,p.width*.46),depth=1.05,z=front+depth/2+.10;
    porch={x,z,width,depth,roofY:.14+p.floorHeight*.98,
      deck:{x,y:.08,z,width:width+.16,height:.16,depth:depth+.26},
      step:{x,y:.06,z:z+depth/2+.24,width:doorWidth+.40,height:.12,depth:.36}};
  }
  const step=porch?.step||doorStep,outerStepZ=step.z+step.depth/2,overlap=.30,width=Math.min(1.18,step.width-.10);
  const z=outerStepZ-overlap,clearanceWidth=Math.max(1.20,step.width+.20);
  return{x,z,width,thresholdZ:door.z,outerStepZ,overlap,door,doorStep,porch,
    approach:{x,z:outerStepZ+.65},direction:[0,1],
    clearance:{minX:x-clearanceWidth/2,maxX:x+clearanceWidth/2,minZ:z,maxZ:outerStepZ+1.20,width:clearanceWidth}};
}
