/** Shared, DOM-free configuration schema for the browser and MCP service. */
export const INTERIOR_PRESETS = Object.freeze({
  tavern: {label:'Village tavern and service rooms',width:10,depth:9,tables:4,beds:0,bedrooms:2,floorCount:2,kitchen:true,bar:true,barSide:'back',fireplace:true,shelves:true,barrels:true,rug:true,clearCenter:true,woodColor:'#a17f50',floorColor:'#9a805b',wallColor:'#d0bc98',accentColor:'#7b4031'},
  cottage: {label:'Cottage living quarters',width:7,depth:7,tables:1,beds:1,bedrooms:1,floorCount:1,kitchen:true,bar:false,barSide:'back',fireplace:true,shelves:true,barrels:false,rug:true,clearCenter:false,woodColor:'#84603a',floorColor:'#aa8652',wallColor:'#d7c5a0',accentColor:'#6d8059'},
  inn: {label:'Inn common rooms and guest floors',width:10,depth:9,tables:3,beds:0,bedrooms:4,floorCount:3,kitchen:true,bar:false,barSide:'back',fireplace:true,shelves:true,barrels:true,rug:true,clearCenter:true,woodColor:'#745031',floorColor:'#8f6b43',wallColor:'#cbbb96',accentColor:'#8b4f41'},
  workshop: {label:'Workshop, shop and private quarters',width:9,depth:8,tables:1,beds:1,bedrooms:1,floorCount:2,kitchen:false,bar:false,barSide:'left',fireplace:true,shelves:true,barrels:true,rug:false,clearCenter:true,woodColor:'#745b3e',floorColor:'#97805a',wallColor:'#aaa18b',accentColor:'#576c64'},
});
export const INTERIOR_ITEM_TYPES=Object.freeze(['table','round_table','chair','bench','stool','barrel','shelf','bed','chest','plant','rug','bar','counter','stove','sink','workbench','crate','sack','cupboard','wardrobe','washbasin','fireplace']);
export const INTERIOR_LIMITS=Object.freeze({width:[6,20],depth:[6,20],tables:[0,12],beds:[0,12],bedrooms:[0,6],floorIndex:[0,2],floorCount:[1,3],wallHeight:[1.8,3.2],aisleWidth:1.2,maxExplicitItems:100});
const finite=(value,fallback)=>Number.isFinite(Number(value))?Number(value):fallback;
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const hex=(v,f)=>typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v)?v:f;
const safeId=(v,f)=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(v)?v:f;

export function normalizeInterior(raw={}) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Interior configuration must be an object.');
  const preset=Object.hasOwn(INTERIOR_PRESETS,raw.preset)?raw.preset:'tavern',base=INTERIOR_PRESETS[preset];
  const floorCount=Math.round(clamp(finite(raw.floorCount,base.floorCount),1,3));
  const out={preset,label:base.label,width:clamp(finite(raw.width,base.width),6,20),depth:clamp(finite(raw.depth,base.depth),6,20),
    wallHeight:clamp(finite(raw.wallHeight,2.4),1.8,3.2),seed:finite(raw.seed,31415)>>>0,
    tables:Math.round(clamp(finite(raw.tables,base.tables),0,12)),beds:Math.round(clamp(finite(raw.beds,base.beds),0,12)),
    bedrooms:Math.round(clamp(finite(raw.bedrooms,base.bedrooms),0,6)),floorCount,floorIndex:Math.round(clamp(finite(raw.floorIndex,0),0,floorCount-1)),
    layoutVariant:raw.layoutVariant===undefined||raw.layoutVariant==='auto'?'auto':Math.round(clamp(finite(raw.layoutVariant,0),0,5)),
    kitchen:typeof raw.kitchen==='boolean'?raw.kitchen:base.kitchen,stairs:floorCount>1&&raw.stairs!==false,occupants:raw.occupants===true,
    barSide:['back','left','right'].includes(raw.barSide)?raw.barSide:base.barSide,
    items:[],excludeIds:[],normalizationWarnings:[],useTextures:raw.useTextures===true,usePaintedSurfaces:raw.usePaintedSurfaces!==false,schemaVersion:2};
  for(const key of ['bar','fireplace','shelves','barrels','rug','clearCenter'])out[key]=typeof raw[key]==='boolean'?raw[key]:base[key];
  for(const key of ['woodColor','floorColor','wallColor','accentColor'])out[key]=hex(raw[key],base[key]);
  out.excludeIds=[...new Set((Array.isArray(raw.excludeIds)?raw.excludeIds:[]).slice(0,300).filter(x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(x)))];
  const ids=new Set();
  for(const [i,item]of (Array.isArray(raw.items)?raw.items:[]).slice(0,100).entries()) {
    if(!item||typeof item!=='object'||!INTERIOR_ITEM_TYPES.includes(item.type)||!Number.isFinite(Number(item.x))||!Number.isFinite(Number(item.z))){out.normalizationWarnings.push(`Custom item ${i+1} was skipped: choose a supported type and finite x/z coordinates.`);continue;}
    const id=safeId(item.id,`custom-${i+1}`);if(ids.has(id)){out.normalizationWarnings.push(`Duplicate custom item '${id}' was skipped.`);continue;}ids.add(id);
    out.items.push({id,type:item.type,x:Number(item.x),z:Number(item.z),rotation:((finite(item.rotation,0)%360)+360)%360,scale:clamp(finite(item.scale,1),.7,1.5)});
  }
  if(Array.isArray(raw.items)&&raw.items.length>100)out.normalizationWarnings.push('Only the first 100 custom items were considered.');
  return out;
}
