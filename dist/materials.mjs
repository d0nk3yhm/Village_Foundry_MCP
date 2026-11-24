/** New painted material tiles, generated entirely from deterministic drawing code. */
const material = (id, label, category, kind, color, palette) =>
  Object.freeze({ id, label, category, kind, color, palette, source: 'procedural' });

export const MATERIAL_CATALOG = Object.freeze([
  material('roof_weathered', 'Warm weathered slate', 'roof', 'shingles', '#94918b', ['#625b51','#7c7a74','#969590','#b4b2aa']),
  material('roof_red', 'Muted terracotta tiles', 'roof', 'tiles', '#a6654e', ['#704b3c','#98604a','#b98061','#ceaa81']),
  material('roof_brown', 'Earth-brown shingles', 'roof', 'shingles', '#927356', ['#5c4737','#80634b','#a98b67','#c0aa83']),
  material('roof_slate', 'Soft gray-blue slate', 'roof', 'shingles', '#858a8d', ['#50585b','#727c80','#959e9d','#b9bfba']),
  material('roof_teal', 'Muted teal slate', 'roof', 'shingles', '#6f8b82', ['#425a53','#607a70','#8ba397','#b0bdae']),
  material('roof_thatch', 'Warm bundled thatch', 'roof', 'thatch', '#b79e68', ['#78633f','#a18854','#c8b17b','#e0cfa2']),
  material('roof_blue', 'Blue-gray village slate', 'roof', 'shingles', '#73818f', ['#495460','#657788','#8d9da9','#bac3c4']),
  material('roof_moss', 'Dark aged slate', 'roof', 'shingles', '#77776c', ['#4c4b42','#68695d','#898b7b','#aaa995']),
  material('roof_copper', 'Soft copper tiles', 'roof', 'tiles', '#ab8264', ['#715442','#957054','#ba9877','#d1bb96']),
  material('wall_stone', 'Warm cut stone', 'wall', 'stone', '#afa592', ['#7e7564','#a39a86','#bcb4a1','#d5cebc']),
  material('wall_brick', 'Weathered red brick', 'wall', 'brick', '#ad8067', ['#775847','#a07158','#be9479','#d3b49a']),
  material('wall_plaster', 'Warm lime plaster', 'wall', 'plaster', '#dfcda8', ['#b3a083','#d0bb98','#e1d0ae','#efe4cc']),
  material('wall_aged_stone', 'Weathered warm stone', 'wall', 'stone', '#aaa697', ['#756f62','#949082','#b2ae9e','#ccc8b8']),
  material('wall_limestone', 'Pale limestone', 'wall', 'stone', '#c2b9a4', ['#8b8170','#b3a88f','#cdc4ad','#e4ddc9']),
  material('wall_cream', 'Soft cream plaster', 'wall', 'plaster', '#e6d7b7', ['#c0af8d','#dac9a7','#e8dcbe','#f3ecd8']),
  material('wood_oak', 'Honey oak', 'wood', 'wood', '#a17f50', ['#665039','#927045','#b28f5b','#d0b786']),
  material('wood_weathered', 'Weathered oak', 'wood', 'wood', '#9b927e', ['#665f50','#8b816c','#aca38c','#c9c1aa']),
  material('wood_dark', 'Dark warm timber', 'wood', 'wood', '#6c5036', ['#40372c','#624a33','#876746','#ab8a5e']),
  material('wood_grey_planks', 'Soft gray timber', 'wood', 'wood', '#a5a294', ['#6b6c61','#8f9184','#b2b3a5','#cfcec0']),
  material('ground_pale_cobble', 'Pale village cobble', 'ground', 'stone', '#bcb49b', ['#897d65','#ada28a','#c6bda4','#ded5bc']),
  material('ground_warm_cobble', 'Warm village cobble', 'ground', 'stone', '#b5a07c', ['#7e684e','#a08b69','#c3af8a','#dfc9a1']),
  material('ground_grass', 'Soft olive grass', 'ground', 'grass', '#919b49', ['#697b39','#849143','#9da652','#b2b76c']),
  material('ground_thatch', 'Scattered straw', 'ground', 'thatch', '#b9a36b', ['#887044','#a48c54','#c8b37d','#ded0a1']),
  material('ground_foliage', 'Soft leafy ground', 'ground', 'foliage', '#738b55', ['#4a663c','#647d48','#849b61','#a4b67e']),
  material('ground_basalt', 'Warm dark paving', 'ground', 'stone', '#817b70', ['#57534c','#716b60','#918b7e','#b1a897']),
  material('ground_wood', 'Weathered boardwalk', 'ground', 'wood', '#a18e6d', ['#695740','#8c7656','#b09b76','#cbbc99']),
  material('ground_meadow', 'Quiet meadow', 'ground', 'grass', '#919a53', ['#6c7a43','#849149','#9ea65e','#b8bb7a']),
]);

export const MATERIAL_FAMILIES = Object.freeze([
  { id:'village',label:'Weathered village',roof:'roof_weathered',wall:'wall_aged_stone',wood:'wood_oak',ground:'ground_warm_cobble' },
  { id:'cottage',label:'Golden country cottage',roof:'roof_thatch',wall:'wall_plaster',wood:'wood_oak',ground:'ground_meadow' },
  { id:'townhouse',label:'Terracotta townhouse',roof:'roof_red',wall:'wall_stone',wood:'wood_dark',ground:'ground_pale_cobble' },
  { id:'merchant',label:'Brick merchant house',roof:'roof_brown',wall:'wall_brick',wood:'wood_oak',ground:'ground_warm_cobble' },
  { id:'manor',label:'Teal-roofed manor',roof:'roof_teal',wall:'wall_limestone',wood:'wood_weathered',ground:'ground_pale_cobble' },
  { id:'northern',label:'Northern slate house',roof:'roof_slate',wall:'wall_stone',wood:'wood_weathered',ground:'ground_basalt' },
].map(Object.freeze));

const byId = new Map(MATERIAL_CATALOG.map(entry=>[entry.id,entry]));
function randomFor(seed,id) {
  let state=2166136261;
  for(const character of `${seed}:${id}`)state=Math.imul(state^character.codePointAt(0),16777619);
  return()=>{state=(state+0x6d2b79f5)|0;let v=Math.imul(state^(state>>>15),1|state);v^=v+Math.imul(v^(v>>>7),61|v);return((v^(v>>>14))>>>0)/4294967296;};
}
function makeCanvas(width=256,height=256) {
  const output=typeof document!=='undefined'?document.createElement('canvas'):new OffscreenCanvas(width,height);
  output.width=width;output.height=height;
  const context=output.getContext('2d');
  if(!context)throw new Error('Material painting requires a 2D canvas.');
  context.imageSmoothingEnabled=true;
  return{output,context};
}
function roundedPolygon(ctx,points,radius=2) {
  ctx.beginPath();
  for(let i=0;i<points.length;i++){
    const before=points[(i+points.length-1)%points.length],point=points[i],after=points[(i+1)%points.length];
    const la=Math.hypot(before[0]-point[0],before[1]-point[1]),lb=Math.hypot(after[0]-point[0],after[1]-point[1]);
    const ra=Math.min(radius,la*.15),rb=Math.min(radius,lb*.15);
    const a=[point[0]+(before[0]-point[0])*ra/la,point[1]+(before[1]-point[1])*ra/la];
    const b=[point[0]+(after[0]-point[0])*rb/lb,point[1]+(after[1]-point[1])*rb/lb];
    if(i===0)ctx.moveTo(...a);else ctx.lineTo(...a);
    ctx.quadraticCurveTo(point[0],point[1],...b);
  }
  ctx.closePath();
}
function paintTile(entry,seed) {
  const{output,context:ctx}=makeCanvas(),size=256,p=entry.palette,r=randomFor(seed,entry.id);
  const wrap=(draw)=>{for(const dx of[-size,0,size])for(const dy of[-size,0,size]){ctx.save();ctx.translate(dx,dy);draw();ctx.restore();}};
  ctx.fillStyle=p[1];ctx.fillRect(0,0,size,size);
  const stone=(x,y,w,h,roof=false)=>{
    const slant=(r()-.5)*5,chip=3+r()*4;
    const points=roof?[[x+2,y+2],[x+w-3,y+slant],[x+w-1,y+h-chip],[x+w*.73,y+h-1],[x+w*.34,y+h+slant],[x+2,y+h-2]]:
      [[x+3,y+2],[x+w-4,y+1+slant],[x+w-1,y+h-5],[x+w-5,y+h-2],[x+4,y+h-1],[x+1,y+h-5]];
    const tone=r()<.45?p[1]:p[2],highlight=r();
    wrap(()=>{
      const g=ctx.createLinearGradient(x,y,x+w*.3,y+h);g.addColorStop(0,p[3]);g.addColorStop(.10,tone);g.addColorStop(.82,tone);g.addColorStop(1,p[1]);
      roundedPolygon(ctx,points,roof?1.8:3.5);ctx.fillStyle=g;ctx.fill();
      ctx.strokeStyle=p[0];ctx.lineWidth=roof?1.5:1.25;ctx.stroke();
      ctx.save();roundedPolygon(ctx,points,2);ctx.clip();
      ctx.globalAlpha=.08;ctx.fillStyle=p[3];ctx.beginPath();ctx.ellipse(x+w*.35,y+h*.35,w*.24,h*.19,-.1,0,Math.PI*2);ctx.fill();
      if(highlight<.35){ctx.globalAlpha=.15;ctx.strokeStyle=p[3];ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x+w*.2,y+h*.26);ctx.quadraticCurveTo(x+w*.37,y+h*.23,x+w*.54,y+h*.30);ctx.stroke();}
      ctx.restore();
    });
  };
  if(entry.kind==='shingles'||entry.kind==='tiles'){
    ctx.fillStyle=p[0];ctx.fillRect(0,0,size,size);
    for(let row=0;row<8;row++)for(let col=0;col<4;col++)stone(col*64+(row%2)*32,row*32,63,35,true);
  }else if(entry.kind==='stone'||entry.kind==='brick'){
    ctx.fillStyle=p[0];ctx.fillRect(0,0,size,size);
    const ground=entry.category==='ground',w=ground?51.2:64,h=entry.kind==='brick'?25.6:ground?51.2:42.6666667;
    const rows=Math.round(size/h),cols=Math.round(size/w);
    for(let row=0;row<rows;row++)for(let col=0;col<cols;col++)stone(col*w+(row%2)*w/2,row*h,w-2,h-2,false);
  }else if(entry.kind==='wood'){
    for(let plank=0;plank<4;plank++){
      const x=plank*64,g=ctx.createLinearGradient(x,0,x+64,0);
      g.addColorStop(0,p[0]);g.addColorStop(.04,p[2]);g.addColorStop(.18,p[2]);g.addColorStop(.72,p[1]);g.addColorStop(.98,p[1]);g.addColorStop(1,p[0]);
      ctx.fillStyle=g;ctx.fillRect(x,0,64,size);
      for(let line=0;line<5;line++){
        const gx=x+9+line*10+(r()-.5)*3,phase=r()*Math.PI*2;
        ctx.strokeStyle=line%2?p[3]:p[0];ctx.globalAlpha=line%2?.13:.15;ctx.lineWidth=1+r()*.7;ctx.beginPath();
        for(let y=0;y<=size;y+=8){const xx=gx+Math.sin(y/size*Math.PI*2+phase)*1.7;if(y===0)ctx.moveTo(xx,y);else ctx.lineTo(xx,y);}ctx.stroke();ctx.globalAlpha=1;
      }
    }
  }else if(entry.kind==='plaster'){
    const g=ctx.createLinearGradient(0,0,size,size);g.addColorStop(0,p[3]);g.addColorStop(.5,p[2]);g.addColorStop(1,p[1]);ctx.fillStyle=g;ctx.fillRect(0,0,size,size);
    for(let patch=0;patch<14;patch++){
      const x=r()*size,y=r()*size,rad=20+r()*35;wrap(()=>{const wash=ctx.createRadialGradient(x,y,0,x,y,rad);wash.addColorStop(0,p[patch%2?1:3]+'18');wash.addColorStop(1,p[patch%2?1:3]+'00');ctx.fillStyle=wash;ctx.fillRect(x-rad,y-rad,rad*2,rad*2);});
    }
  }else if(entry.kind==='thatch'){
    ctx.fillStyle=p[1];ctx.fillRect(0,0,size,size);
    for(let row=0;row<8;row++)for(let strand=0;strand<24;strand++){
      const x=strand*(size/24)+(row%2)*5,y=row*32,lean=(r()-.5)*4;
      wrap(()=>{ctx.strokeStyle=r()<.5?p[2]:p[3];ctx.lineWidth=3+r()*2;ctx.globalAlpha=.7;ctx.beginPath();ctx.moveTo(x,y-2);ctx.quadraticCurveTo(x+lean,y+16,x+lean*.5,y+35);ctx.stroke();ctx.globalAlpha=1;});
    }
  }else{
    ctx.fillStyle=p[1];ctx.fillRect(0,0,size,size);
    for(let patch=0;patch<28;patch++){
      const x=r()*size,y=r()*size,rad=12+r()*30;
      wrap(()=>{const g=ctx.createRadialGradient(x,y,0,x,y,rad);g.addColorStop(0,p[patch%2?2:0]+'55');g.addColorStop(1,p[patch%2?2:0]+'00');ctx.fillStyle=g;ctx.fillRect(x-rad,y-rad,rad*2,rad*2);});
    }
    const count=entry.kind==='foliage'?85:28;
    for(let leaf=0;leaf<count;leaf++){
      const x=r()*size,y=r()*size,angle=r()*Math.PI;
      wrap(()=>{ctx.fillStyle=leaf%3?p[2]:p[3];ctx.globalAlpha=.34;ctx.beginPath();ctx.ellipse(x,y,entry.kind==='foliage'?5:1.2,entry.kind==='foliage'?2.4:3,angle,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;});
    }
  }
  return output;
}

/** Fresh, opaque 256px tile; a fixed seed reproduces the same painted material. */
export async function materialCanvas(id,{seed=742}={}) {
  const entry=byId.get(id);if(!entry)throw new RangeError(`Unknown material: ${id}`);
  return paintTile(entry,seed);
}
export async function loadMaterialTexture(THREE,id,{seed=742,crisp=false}={}) {
  const texture=new THREE.CanvasTexture(await materialCanvas(id,{seed}));
  texture.name=id;texture.colorSpace=THREE.SRGBColorSpace;
  texture.magFilter=texture.minFilter=crisp?THREE.NearestFilter:THREE.LinearFilter;
  texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.generateMipmaps=false;texture.anisotropy=1;
  texture.userData={materialId:id,source:'procedural',seed};texture.needsUpdate=true;return texture;
}

/** Palette suggestions only; this does not infer geometry or sample textures. */
export function inferPalette(imageData){
  if(!imageData?.data||!imageData.width||!imageData.height)throw new TypeError('inferPalette expects RGBA ImageData.');
  const{data,width,height}=imageData,groups={roof:new Map(),wall:new Map(),wood:new Map(),all:new Map()};
  const step=Math.max(1,Math.ceil(Math.sqrt(width*height/40000))),add=(g,k)=>g.set(k,(g.get(k)||0)+1);
  for(let y=0;y<height;y+=step)for(let x=0;x<width;x+=step){
    const i=(y*width+x)*4;if(data[i+3]<128)continue;
    const r=data[i],g=data[i+1],b=data[i+2],light=.2126*r+.7152*g+.0722*b;
    const q=c=>Math.min(255,Math.floor(c/16)*16+8),key='#'+[q(r),q(g),q(b)].map(v=>v.toString(16).padStart(2,'0')).join('');
    add(groups.all,key);if(light>35&&light<240){if(y/height<.42)add(groups.roof,key);if(y/height>.48)add(groups.wall,key);}if(light>25&&light<140&&r>g*1.1&&g>b*1.08)add(groups.wood,key);
  }
  const sorted=g=>[...g].sort((a,b)=>b[1]-a[1]).map(([color])=>color);
  return{roof:sorted(groups.roof)[0]||'#928778',wall:sorted(groups.wall)[0]||'#a69d88',wood:sorted(groups.wood)[0]||'#a17f50',dominant:sorted(groups.all).slice(0,8),note:'Colours estimated from regions; geometry and materials are generated independently.'};
}
