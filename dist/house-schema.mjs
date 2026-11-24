export const PRESETS = Object.freeze({
  source: { label: 'Red-roof stone house', width: 4.8, depth: 4.8, floors: 1, floorHeight: 1.8, roofPitch: 45, roofColor: '#a8472c', wallColor: '#a29b88', woodColor: '#73502f', roofKind: 'tiles', wallKind: 'stone', timber: false, chimney: true, dormer: false, porch: false, shutters: true, planters: false, sideWing: false },
  village: { label: 'Village merchant house', width: 4.8, depth: 6, floors: 2, floorHeight: 1.8, roofPitch: 47, roofColor: '#878984', wallColor: '#ddc69b', woodColor: '#a17f50', roofKind: 'shingles', wallKind: 'stone', timber: true, chimney: true, dormer: false, porch: false, shutters: false, planters: true, sideWing: true },
  inn: { label: 'Timber village inn', width: 6.3, depth: 7.4, floors: 3, floorHeight: 1.7, roofPitch: 43, roofColor: '#99513a', wallColor: '#e4d2a8', woodColor: '#67482d', roofKind: 'tiles', wallKind: 'plaster', timber: true, chimney: true, dormer: true, porch: true, shutters: true, planters: true, sideWing: false },
  manor: { label: 'Stone guild manor', width: 6.1, depth: 7, floors: 3, floorHeight: 1.8, roofPitch: 49, roofColor: '#496b65', wallColor: '#ada58d', woodColor: '#53432f', roofKind: 'shingles', wallKind: 'stone', timber: false, chimney: true, dormer: true, porch: false, shutters: false, planters: true, sideWing: false },
  cottage: { label: 'Thatched cottage', width: 4.4, depth: 5.1, floors: 1, floorHeight: 1.8, roofPitch: 53, roofColor: '#b79a50', wallColor: '#d8c49b', woodColor: '#725331', roofKind: 'thatch', wallKind: 'plaster', timber: true, chimney: true, dormer: false, porch: false, shutters: true, planters: true, sideWing: false },
  longhouse: { label: 'Farm longhouse', width: 4.3, depth: 8.6, floors: 1, floorHeight: 1.75, roofPitch: 48, roofColor: '#858a8d', wallColor: '#c6bda6', woodColor: '#83745c', roofKind: 'shingles', wallKind: 'stone', timber: true, chimney: true, dormer: false, porch: true, shutters: false, planters: false, sideWing: false, doorFace: 'right', doorPosition: 'center' },
  gatehouse: { label: 'Stone gatehouse', width: 6.6, depth: 4.4, floors: 2, floorHeight: 1.95, roofPitch: 46, roofColor: '#637e76', wallColor: '#b5ae9b', woodColor: '#6e5a42', roofKind: 'shingles', wallKind: 'stone', timber: false, chimney: false, dormer: true, porch: false, shutters: false, planters: false, sideWing: false, doorPosition: 'center', roofRotation: 90 },
  weaver: { label: 'Weaver’s townhouse', width: 3.8, depth: 5.6, floors: 3, floorHeight: 1.65, roofPitch: 56, roofColor: '#927356', wallColor: '#c2a080', woodColor: '#644b35', roofKind: 'shingles', wallKind: 'brick', timber: true, chimney: true, dormer: true, porch: false, shutters: true, planters: true, sideWing: false, doorPosition: 'left' },
});

export const HOUSE_FACES = Object.freeze(['front', 'back', 'left', 'right']);
export const HOUSE_DOOR_POSITIONS = Object.freeze(['auto', 'left', 'center', 'right']);
export const HOUSE_ROOF_ROTATIONS = Object.freeze([0, 90]);
export const HOUSE_WINDOW_ALIGNMENTS = Object.freeze(['even', 'left', 'right']);
export const MAX_WINDOWS_PER_WALL = 3;
export const HOUSE_MATERIAL_FAMILIES = Object.freeze({
  village: 'village', cottage: 'cottage', source: 'townhouse', inn: 'townhouse',
  manor: 'manor', longhouse: 'northern', gatehouse: 'manor', weaver: 'merchant',
});

/** Weighted template choice for mixed sprite batches. Supply one seeded roll in [0, 1). */
export function pickHousePreset(roll) {
  if (roll < .32) return 'village';
  if (roll < .50) return 'cottage';
  if (roll < .62) return 'inn';
  if (roll < .70) return 'manor';
  if (roll < .76) return 'source';
  if (roll < .86) return 'longhouse';
  if (roll < .93) return 'gatehouse';
  return 'weaver';
}

export const DEFAULT_PARAMS = Object.freeze({ preset: 'village', ...PRESETS.village, stoneColor:'#a69d88', useTextures:false, usePaintedSurfaces:true, exposedRafters:false, seed: 1847,
  doorFace: 'front', doorPosition: 'auto', roofRotation: 0, windowAlignment: 'even', windowCounts: Object.freeze({}) });


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
  out.doorFace=HOUSE_FACES.includes(raw.doorFace)?raw.doorFace:base.doorFace;
  out.doorPosition=HOUSE_DOOR_POSITIONS.includes(raw.doorPosition)?raw.doorPosition:base.doorPosition;
  out.roofRotation=HOUSE_ROOF_ROTATIONS.includes(raw.roofRotation)?raw.roofRotation:base.roofRotation;
  out.windowAlignment=HOUSE_WINDOW_ALIGNMENTS.includes(raw.windowAlignment)?raw.windowAlignment:base.windowAlignment;
  out.windowCounts={};
  for (const face of HOUSE_FACES) {
    const count=raw.windowCounts?.[face];
    if (Number.isInteger(count)) out.windowCounts[face]=clampNumber(count,0,MAX_WINDOWS_PER_WALL);
  }
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
 * Coordinates are house-local. The path overlaps the outer step by 0.30 units.
 * Widths follow the selected wall; depths and direction point out of the house.
 */
export function houseEntrance(raw={}){
  const p=normalizeHouse(raw), face=p.doorFace;
  const side=face==='left'||face==='right', span=side?p.depth:p.width;
  const half=span/2, wallDistance=(side?p.width:p.depth)/2;
  const direction={front:[0,1],right:[1,0],back:[0,-1],left:[-1,0]}[face];
  const [nx,nz]=direction;
  const doorWidth=Math.min(.98,span*.22),doorHeight=p.floorHeight*.83;
  const porchWidth=Math.min(2,span*.46);
  const position=p.doorPosition==='auto'?PRESETS[p.preset].doorPosition:p.doorPosition;
  const maxOffset=Math.max(0,half-(p.porch?porchWidth/2+.08:doorWidth/2+.18));
  const offset=Math.min(half*.56,maxOffset);
  const u=position==='center'?0:position==='left'?-offset:position==='right'?offset:
    p.preset==='source'?-half*.72:p.preset==='cottage'?0:half*.53;
  const point=(distance,along=u)=>({x:nz*along+nx*distance,z:-nx*along+nz*distance});
  const door={...point(wallDistance+.225),y:.14+doorHeight/2,width:doorWidth,height:doorHeight};
  const doorStep={...point(wallDistance+.33),y:.11,width:doorWidth+.42,height:.22,depth:.62};
  let porch=null;
  let stepDistance=wallDistance+.33;
  if(p.porch){
    const depth=1.05, center=point(wallDistance+depth/2+.10);
    stepDistance=wallDistance+depth+.34;
    porch={...center,width:porchWidth,depth,roofY:.14+p.floorHeight*.98,
      deck:{...center,y:.08,width:porchWidth+.16,height:.16,depth:depth+.26},
      step:{...point(stepDistance),y:.06,width:doorWidth+.40,height:.12,depth:.36}};
  }
  const step=porch?.step||doorStep,outer=stepDistance+step.depth/2,overlap=.30,width=Math.min(1.18,step.width-.10);
  const outerStep=point(outer),clearanceWidth=Math.max(1.20,step.width+.20);
  const a=point(outer-overlap,u-clearanceWidth/2),b=point(outer+1.20,u+clearanceWidth/2);
  return{...point(outer-overlap),face,u,width,thresholdX:door.x,thresholdZ:door.z,outerStepX:outerStep.x,outerStepZ:outerStep.z,
    overlap,door,doorStep,porch,approach:point(outer+.65),direction,
    clearance:{minX:Math.min(a.x,b.x),maxX:Math.max(a.x,b.x),minZ:Math.min(a.z,b.z),maxZ:Math.max(a.z,b.z),width:clearanceWidth}};
}
