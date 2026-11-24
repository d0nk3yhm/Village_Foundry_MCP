import * as THREE from './vendor/three.module.js';
import {createPaintedSurface} from './painted-surfaces.mjs';
import {INTERIOR_PRESETS,normalizeInterior} from './interior-schema.mjs';
import {planInterior} from './interior-floorplan.mjs';
import {buildCharacter} from './character-model.mjs';
export {INTERIOR_PRESETS,normalizeInterior};

const dimensions={table:[1.24,.92],chair:[.51,.55],barrel:[.74,.74],shelf:[1.42,.40],bed:[1.28,2.18],chest:[.96,.56],plant:[.60,.60],rug:[2.05,1.48]};
function random(seed){let a=seed||1;return()=>{a+=0x6D2B79F5;let t=Math.imul(a^a>>>15,1|a);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296;};}
const intersects=(a,b,gap=0)=>Math.abs(a.x-b.x)<(a.width+b.width)/2+gap&&Math.abs(a.z-b.z)<(a.depth+b.depth)/2+gap;

/** Open-front, cutaway interior with real furniture and a collision-aware plan. */
export function buildInterior(raw={},textures={}) {
  const c=normalizeInterior(raw),layout=planInterior(c),r=random(c.seed),W=c.width,D=c.depth,hw=W/2,hd=D/2,Y=.10;
  if(!c.useTextures)textures={};
  const group=new THREE.Group();group.name=`${c.preset}-interior`;
  const geo={sphere:new THREE.SphereGeometry(1,16,10),box:new THREE.BoxGeometry(1,1,1),cylinder:new THREE.CylinderGeometry(1,1,1,10),bottle:new THREE.CylinderGeometry(1,1,1,7),cone:new THREE.ConeGeometry(1,1,7),leaf:new THREE.IcosahedronGeometry(1,0),ring:new THREE.TorusGeometry(1,.18,4,10)};
  geo.plank=geo.box.clone();
  {const pos=geo.plank.getAttribute('position'),normal=geo.plank.getAttribute('normal'),uv=geo.plank.getAttribute('uv');for(let i=0;i<pos.count;i++)if(Math.abs(normal.getY(i))>.5)uv.setXY(i,pos.getZ(i)+.5,pos.getX(i)+.5);}
  const ownedTextures=new Set(),paintCache=new Map();
  const paint=(kind,base,variant=0)=>{if(!c.usePaintedSurfaces)return null;const hex=base?.getHexString?`#${base.getHexString()}`:base,key=`${kind}:${hex}:${variant}`;if(!paintCache.has(key)){const map=createPaintedSurface(THREE,kind,hex,{seed:c.seed,variant});paintCache.set(key,map);if(map)ownedTextures.add(map);}return paintCache.get(key);};
  const material=(hex,map=null,extra={})=>new THREE.MeshStandardMaterial({color:map?'#ffffff':hex,map,roughness:1,metalness:0,flatShading:true,...extra});
  const m={wood:material(c.woodColor,textures.wood||paint('wood',c.woodColor,0)),woodLight:material(new THREE.Color(c.woodColor).multiplyScalar(1.12),textures.wood||paint('wood',new THREE.Color(c.woodColor).multiplyScalar(1.12),1)),woodFrame:material(new THREE.Color(c.woodColor).multiplyScalar(.78)),woodDark:material(new THREE.Color(c.woodColor).multiplyScalar(.52)),
    floor:material(c.floorColor,textures.wood||paint('wood',c.floorColor,0)),floorAlt:material(c.floorColor,textures.wood||paint('wood',c.floorColor,1)),wall:material(c.wallColor,textures.wall||paint('plaster',c.wallColor,0)),stone:material('#aaa697',textures.wall||paint('stone','#aaa697',0)),mortar:material('#6f6754'),iron:material('#3e3b31'),void:material('#24231d'),
    fabric:material(c.accentColor),fabricLight:material(new THREE.Color(c.accentColor).multiplyScalar(1.25)),cream:material('#e5d5a9'),plate:material('#b8b69a'),green:material('#526e47'),amber:material('#98622e'),red:material('#773e32'),leaf:material('#748846'),leafLight:material('#a4ab55'),
    water:material('#6d8c8e'),copper:material('#9c6946'),flame:material('#e7a54b',null,{emissive:'#b84e12',emissiveIntensity:.8}),fireCore:material('#f5d486',null,{emissive:'#ef9c34',emissiveIntensity:.65}),soil:material('#51452f')};
  const batches=new Map(),matrix=new THREE.Matrix4(),up=new THREE.Vector3(0,1,0),identity=new THREE.Quaternion();
  function shape(g,mat,position,size,rotation=identity,tint=null,name='details') {
    const key=`${g.uuid}:${mat.uuid}:${name}`;let batch=batches.get(key);if(!batch){batch={g,mat,name,matrices:[],colors:[]};batches.set(key,batch);}
    matrix.compose(new THREE.Vector3(...position),rotation,new THREE.Vector3(...size));batch.matrices.push(matrix.clone());batch.colors.push(tint||new THREE.Color(1,1,1));
  }
  const box=(position,size,mat=m.wood,rotation=identity,tint=null,name='carpentry')=>shape(name==='oak-floorboards'?geo.plank:geo.box,mat,position,size,rotation,tint,name);
  const cylinder=(position,radius,height,mat=m.wood,rotation=identity,name='round-details')=>shape(geo.cylinder,mat,position,[radius,height,radius],rotation,null,name);
  function local(item,x,y,z,size,mat=m.wood,name='furniture',tint=null,g=geo.box,extraRotation=null) {
    const a=THREE.MathUtils.degToRad(item.rotation||0),co=Math.cos(a),si=Math.sin(a),s=item.scale||1;
    const q=new THREE.Quaternion().setFromAxisAngle(up,a);if(extraRotation)q.multiply(extraRotation);
    shape(name==='table-planks'?geo.plank:g,mat,[item.x+(co*x+si*z)*s,Y+y*s,item.z+(-si*x+co*z)*s],size.map(v=>v*s),q,tint,name);
  }
  const shade=(low=.85,range=.27)=>new THREE.Color().setScalar(low+r()*range);


  const holes=c.floorIndex>0?layout.stairs.map(s=>({minX:s.x-s.width/2,maxX:s.x+s.width/2,minZ:s.z-s.depth/2,maxZ:s.z+s.depth/2})):[];
  function cutRect(b,h){const x0=Math.max(b.minX,h.minX),x1=Math.min(b.maxX,h.maxX),z0=Math.max(b.minZ,h.minZ),z1=Math.min(b.maxZ,h.maxZ);if(x1<=x0||z1<=z0)return[b];const out=[];if(x0>b.minX)out.push({...b,maxX:x0});if(x1<b.maxX)out.push({...b,minX:x1});if(z0>b.minZ)out.push({minX:x0,maxX:x1,minZ:b.minZ,maxZ:z0});if(z1<b.maxZ)out.push({minX:x0,maxX:x1,minZ:z1,maxZ:b.maxZ});return out;}
  function floorPiece(b,y,height,mat,tint,name){let parts=[b];for(const h of holes)parts=parts.flatMap(p=>cutRect(p,h));for(const p of parts)if(p.maxX-p.minX>.015&&p.maxZ-p.minZ>.015)box([(p.minX+p.maxX)/2,y,(p.minZ+p.maxZ)/2],[p.maxX-p.minX,height,p.maxZ-p.minZ],mat,identity,tint,name);}
  floorPiece({minX:-hw-.10,maxX:hw+.10,minZ:-hd-.10,maxZ:hd+.10},.025,.05,m.woodDark,null,'floor-base');
  for(const room of layout.rooms){
    const b=room.bounds,stone=['kitchen','store','pantry','workroom','linen'].includes(room.type);
    if(stone){const rows=Math.ceil((b.maxZ-b.minZ)/.62),depth=(b.maxZ-b.minZ)/rows;for(let iz=0;iz<rows;iz++){const nominal=.68,offset=(iz%2)*nominal/2;for(let x=b.minX-offset;x<b.maxX;x+=nominal){const lo=Math.max(b.minX,x),hi=Math.min(b.maxX,x+nominal);floorPiece({minX:lo+.012,maxX:hi-.012,minZ:b.minZ+iz*depth+.012,maxZ:b.minZ+(iz+1)*depth-.012},.08,.10,m.stone,shade(.86,.16),'service-room-flagstones');}}}
    else{const rows=Math.ceil((b.maxZ-b.minZ)/.49),depth=(b.maxZ-b.minZ)/rows;for(let row=0;row<rows;row++){const nominal=2.25,offset=(row%3)*nominal/3;for(let x=b.minX-offset;x<b.maxX;x+=nominal){const lo=Math.max(b.minX,x),hi=Math.min(b.maxX,x+nominal);floorPiece({minX:lo+.008,maxX:hi-.008,minZ:b.minZ+row*depth+.009,maxZ:b.minZ+(row+1)*depth-.009},.075,.10,row%2?m.floor:m.floorAlt,shade(.96,.08),'oak-floorboards');}}}
  }
  // Cutaway exterior walls and low internal partitions reveal every room.
  box([0,c.wallHeight/2,-hd-.085],[W+.26,c.wallHeight,.17],m.wall,identity,null,'back-wall');
  for(const side of [-1,1]){box([side*(hw+.085),.27,0],[.17,.54,D+.17],m.stone,identity,null,'cutaway-side-walls');box([side*(hw+.085),.57,0],[.22,.09,D+.19],m.woodFrame,identity,null,'cutaway-caps');const seg=(W-1.45)/2;box([side*(.725+seg/2),.18,hd+.085],[seg,.36,.17],m.stone,identity,null,'front-wall-edges');box([side*(hw-.02),c.wallHeight/2,-hd+.03],[.15,c.wallHeight,.15],m.woodFrame,identity,null,'corner-posts');}
  if(c.floorIndex===0)box([0,.12,hd+.10],[1.45,.12,.34],m.woodLight,identity,null,'entrance-threshold');else box([0,.18,hd+.085],[1.45,.36,.17],m.stone,identity,null,'upper-front-wall');
  box([0,c.wallHeight-.06,-hd+.035],[W,.14,.14],m.woodFrame,identity,null,'back-wall-top-beam');
  for(const segment of layout.walls){box([segment.x,.55,segment.z],[segment.width,1.10,segment.depth],m.wall,identity,null,'room-partitions');box([segment.x,.15,segment.z],[segment.width+.02,.15,segment.depth+.02],m.woodFrame,identity,null,'partition-baseboards');box([segment.x,1.13,segment.z],[segment.width+.025,.10,segment.depth+.025],m.wood,identity,null,'partition-caps');}
  for(const door of layout.connections){const acrossX=door.axis==='x';for(const sign of [-1,1])box([door.x+(acrossX?sign*(door.width/2+.045):0),.91,door.z+(acrossX?0:sign*(door.width/2+.045))],[acrossX?.09:.20,1.82,acrossX?.20:.09],m.woodFrame,identity,null,'interior-doorposts');box([door.x,1.81,door.z],[acrossX?door.width+.18:.20,.13,acrossX?.20:door.width+.18],m.woodLight,identity,null,'interior-door-lintels');box([door.x,.135,door.z],[acrossX?door.width:.22,.045,acrossX?.22:door.width],m.woodLight,identity,null,'doorway-thresholds');}
  for(const room of layout.rooms.filter(v=>Math.abs(v.bounds.minZ+hd)<.01)){
    const x=(room.bounds.minX+room.bounds.maxX)/2;
    box([x,1.60,-hd+.105],[.80,.77,.06],m.woodDark,identity,null,'room-window-recess');box([x,1.60,-hd+.145],[.65,.62,.035],m.water,identity,null,'room-window-glass');
    for(const xx of [-.39,.39])box([x+xx,1.60,-hd+.19],[.075,.87,.075],m.woodLight,identity,null,'room-window-frames');for(const yy of [1.20,1.60,2.00])box([x,yy,-hd+.19],[.82,.06,.075],m.woodLight,identity,null,'room-window-frames');box([x,1.60,-hd+.20],[.055,.77,.06],m.woodLight,identity,null,'window-mullion');
  }
  function beamBetween(a,b,width,mat,name){const av=new THREE.Vector3(...a),bv=new THREE.Vector3(...b),delta=bv.clone().sub(av),q=new THREE.Quaternion().setFromUnitVectors(up,delta.clone().normalize());box(av.add(bv).multiplyScalar(.5).toArray(),[width,delta.length(),width],mat,q,null,name);}
  for(const stair of layout.stairs){
    const count=9,tread=stair.depth/count,rise=c.wallHeight-.22,front=stair.z+stair.depth/2;
    if(stair.up!==null){for(let i=0;i<count;i++){const h=(i+1)*rise/count;box([stair.x,Y+h/2,front-(i+.5)*tread],[1.12,h,tread+.012],m.woodFrame,identity,null,'stair-risers');box([stair.x,Y+h+.018,front-(i+.5)*tread],[1.17,.055,tread+.025],m.woodLight,identity,null,'stair-treads');}}
    else{box([stair.x,-.68,stair.z],[stair.width,.06,stair.depth],m.void,identity,null,'stairwell-shadow');for(let i=0;i<5;i++)box([stair.x,.10-i*.16,front-(i+.5)*tread],[1.12,.09,tread+.02],m.woodLight,identity,null,'descending-stair-treads');}
    const side=stair.x<0?-1:1,railX=stair.x+side*.59;
    if(stair.up!==null){for(const k of [0,3,6,8]){const h=(k+1)*rise/count,z=front-(k+.5)*tread;box([railX,Y+h+.37,z],[.065,.74,.065],m.wood,identity,null,'stair-balusters');}beamBetween([railX,Y+rise/count+.74,front-tread/2],[railX,Y+rise+.74,front-(count-.5)*tread],.09,m.woodLight,'stair-handrail');}
    else{for(const sign of [-1,1]){box([stair.x+sign*.62,.53,stair.z],[.075,.86,stair.depth],m.woodDark,identity,null,'stairwell-balustrade-base');box([stair.x+sign*.62,.98,stair.z],[.10,.09,stair.depth+.05],m.woodLight,identity,null,'stairwell-rails');}}
  }

  function mug(item,x,z,tableY=.91){
    local(item,x,tableY+.075,z,[.070,.14,.070],m.amber,'mugs',null,geo.cylinder);
    local(item,x,tableY+.15,z,[.065,.025,.065],m.cream,'beer-foam',null,geo.cylinder);
    local(item,x+.092,tableY+.075,z,[.044,.044,.044],m.woodLight,'mug-handles',null,geo.ring);
  }
  function bottle(item,x,y,z,mat=m.green){local(item,x,y+.105,z,[.048,.21,.048],mat,'bottles',null,geo.bottle);local(item,x,y+.25,z,[.024,.09,.024],mat,'bottle-necks',null,geo.bottle);local(item,x,y+.30,z,[.026,.025,.026],m.woodLight,'bottle-corks',null,geo.bottle);}
  function furniture(item){
    if(item.type==='table'||item.type==='round_table'){
      for(const x of [-.48,.48])for(const z of [-.32,.32])local(item,x,.37,z,[.12,.74,.12],m.woodDark,'table-legs');
      for(const z of [-.35,.35])local(item,0,.66,z,[1.16,.17,.10],m.woodFrame,'table-aprons');
      if(item.type==='round_table'){local(item,0,.81,0,[.625,.14,.625],m.woodLight,'round-tabletop',null,geo.cylinder);local(item,0,.40,0,[.12,.78,.12],m.wood,'table-pedestal');}else for(let i=0;i<5;i++)local(item,0,.81,(i-2)*.184,[1.24,.14,.171],m.woodLight,'table-planks',shade(.93,.12));
      mug(item,-.32,.19);mug(item,.31,-.19);
      local(item,.02,.901,0,[.145,.025,.145],m.plate,'table-plates',null,geo.cylinder);
      local(item,.02,.94,0,[.14,.065,.10],m.cream,'table-bread');
    }else if(item.type==='chair'){
      for(const x of [-.19,.19])for(const z of [-.18,.18])local(item,x,.23,z,[.075,.46,.075],m.woodDark,'chair-legs');
      local(item,0,.47,0,[.51,.10,.49],m.woodLight,'chair-seats');
      for(const x of [-.195,.195])local(item,x,.72,.205,[.075,.60,.075],m.wood,'chair-back-posts');
      for(const yy of [.70,.91])local(item,0,yy,.205,[.45,.11,.065],m.woodLight,'chair-back-rails');
    }else if(item.type==='barrel'){
      local(item,0,.37,0,[.30,.72,.30],m.wood,'barrel-staves',null,geo.cylinder);
      local(item,0,.755,0,[.29,.055,.29],m.woodLight,'barrel-lids',null,geo.cylinder);
      const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),Math.PI/2);
      for(const yy of [.15,.59])local(item,0,yy,0,[.307,.307,.307],m.iron,'barrel-hoops',null,geo.ring,q);
    }else if(item.type==='shelf'){
      for(const x of [-.66,.66])local(item,x,.89,.10,[.10,1.78,.26],m.woodDark,'shelf-posts');
      for(const yy of [.12,.66,1.20,1.75]){local(item,0,yy,0,[1.42,.09,.40],m.woodLight,'shelf-boards');if(yy<1.7)for(let j=0;j<6;j++)bottle(item,-.52+j*.20,yy+.06,(j%2)*.04,j%3===0?m.amber:j%3===1?m.green:m.red);}
    }else if(item.type==='bed'){
      for(const x of [-.54,.54])for(const z of [-.94,.94])local(item,x,.30,z,[.13,.60,.13],m.woodDark,'bed-posts');
      local(item,0,.40,0,[1.28,.20,2.15],m.wood,'bed-frame');local(item,0,.56,0,[1.12,.22,1.99],m.cream,'bed-mattress');
      local(item,0,.705,.35,[1.13,.10,1.25],m.fabric,'bed-blanket');local(item,0,.77,-.63,[.92,.18,.43],m.cream,'bed-pillow');
      local(item,0,.91,-1.03,[1.28,.66,.12],m.woodLight,'bed-headboard');
      for(const xx of [-.40,0,.40])local(item,xx,.92,-.952,[.045,.56,.035],m.woodDark,'headboard-inlay');
      local(item,0,.75,-.23,[1.14,.07,.12],m.fabricLight,'blanket-fold');
    }else if(item.type==='chest'){
      local(item,0,.28,0,[.96,.56,.56],m.wood,'chest-box');local(item,0,.60,0,[.99,.12,.60],m.woodLight,'chest-lid');
      for(const xx of [-.32,.32])local(item,xx,.32,.29,[.065,.56,.045],m.iron,'chest-straps');local(item,0,.48,.32,[.13,.16,.04],m.iron,'chest-lock');
    }else if(item.type==='plant'){
      local(item,0,.19,0,[.20,.38,.20],m.amber,'plant-pots',null,geo.cylinder);local(item,0,.39,0,[.19,.035,.19],m.soil,'plant-soil',null,geo.cylinder);
      for(let i=0;i<6;i++)local(item,(r()-.5)*.28,.46+r()*.18,(r()-.5)*.28,[.15,.15,.15],i%2?m.leaf:m.leafLight,'potted-leaves',null,geo.leaf);
    }else if(item.type==='rug'){
      local(item,0,.028,0,[2.05,.035,1.48],m.fabric,'woven-rugs');local(item,0,.049,0,[1.76,.013,1.18],m.fabricLight,'rug-center');
      for(const z of [-.55,.55])local(item,0,.059,z,[1.78,.012,.055],m.cream,'rug-border');
      for(const x of [-.84,.84])local(item,x,.059,0,[.045,.012,1.15],m.cream,'rug-border');
      for(let j=-4;j<=4;j++)for(const z of [-.77,.77])local(item,j*.20,.033,z,[.07,.025,.10],m.cream,'rug-fringe');

    }else if(item.type==='bench'){
      for(const x of [-.62,.62])for(const z of [-.15,.15])local(item,x,.24,z,[.085,.48,.085],m.woodDark,'bench-legs');
      for(const z of [-.12,.12])local(item,0,.49,z,[1.70,.10,.21],m.woodLight,'bench-seat');
      for(const x of [-.70,.70])local(item,x,.70,.19,[.08,.56,.08],m.wood,'bench-back-posts');
      local(item,0,.88,.19,[1.66,.22,.07],m.woodLight,'bench-back');
    }else if(item.type==='stool'){
      for(const x of [-.13,.13])for(const z of [-.13,.13])local(item,x,.25,z,[.055,.50,.055],m.woodDark,'stool-legs');
      local(item,0,.51,0,[.22,.09,.22],m.woodLight,'stool-seat',null,geo.cylinder);
    }else if(item.type==='bar'){
      const length=item.length||2.60;
      local(item,0,.54,0,[length,1.08,.72],m.woodDark,'bar-body');
      for(let i=0;i<6;i++)local(item,-length/2+(i+.5)*length/6,.55,.38,[length/6-.025,.91,.06],m.woodLight,'bar-panels',shade(.91,.13));
      local(item,0,1.12,0,[length+.12,.16,.82],m.woodLight,'bar-countertop');
      local(item,0,.16,.44,[length,.09,.08],m.woodFrame,'bar-foot-rail');
      for(const x of [-length*.28,length*.28]){mug(item,x,.12,1.20);bottle(item,x-.18,1.20,-.18,m.green);}
    }else if(item.type==='counter'||item.type==='sink'){
      const width=item.type==='sink'?1.10:1.60;
      local(item,0,.43,0,[width,.86,.60],m.woodDark,'kitchen-cabinet');
      for(const x of [-width*.25,width*.25]){local(item,x,.47,.31,[width*.46,.70,.055],m.woodLight,'cabinet-door');local(item,x+width*.12,.48,.35,[.05,.09,.035],m.iron,'cupboard-handle');}
      local(item,0,.91,0,[width+.05,.14,.64],item.type==='sink'?m.stone:m.woodLight,'kitchen-worktop');
      if(item.type==='sink'){
        local(item,0,1.01,0,[.36,.13,.24],m.stone,'stone-sink',null,geo.cylinder);local(item,0,1.082,0,[.29,.018,.18],m.water,'sink-water',null,geo.cylinder);
        local(item,.39,1.11,-.12,[.07,.23,.07],m.copper,'water-jug',null,geo.cylinder);
      }else{
        local(item,-.34,1.005,.05,[.52,.035,.32],m.cream,'cutting-board');
        for(let i=0;i<3;i++)local(item,-.46+i*.10,1.05,.05,[.055,.055,.11],i===1?m.red:m.green,'kitchen-produce',null,geo.sphere);
        local(item,.41,1.09,-.03,[.13,.18,.13],m.copper,'kitchen-pot',null,geo.cylinder);local(item,.41,1.19,-.03,[.15,.035,.15],m.iron,'pot-lid',null,geo.cylinder);
      }
    }else if(item.type==='stove'){
      local(item,0,.43,0,[1.43,.86,.96],m.mortar,'masonry-oven');
      for(let row=0;row<3;row++)for(let col=0;col<4;col++)local(item,(col-1.5)*.35,.17+row*.27,.49,[.32,.23,.055],m.stone,'oven-face-stones',shade(.9,.16));
      local(item,-.22,.42,.527,[.64,.48,.026],m.void,'oven-mouth');
      local(item,-.22,.18,.55,[.71,.09,.12],m.stone,'oven-sill');
      local(item,0,.94,0,[1.49,.15,1.00],m.iron,'stove-top');
      for(const x of [-.36,.36]){local(item,x,1.03,0,[.21,.025,.21],m.void,'stove-ring',null,geo.cylinder);local(item,x,1.16,0,[.16,.27,.16],m.copper,'stew-pot',null,geo.cylinder);local(item,x,1.31,0,[.18,.04,.18],m.iron,'stew-pot-lid',null,geo.cylinder);}
      local(item,0,1.70,-.31,[.92,.20,.51],m.stone,'oven-hood');local(item,0,2.04,-.34,[.51,.54,.40],m.mortar,'oven-flue');
      for(let i=0;i<3;i++)local(item,-.35+i*.12,.28,.55,[.07,.18,.045],i%2?m.flame:m.fireCore,'oven-fire',null,geo.cone);
    }else if(item.type==='workbench'){
      for(const x of [-.70,.70])for(const z of [-.28,.28])local(item,x,.43,z,[.14,.86,.14],m.woodDark,'workbench-legs');
      for(const z of [-.26,0,.26])local(item,0,.91,z,[1.80,.19,.25],m.woodLight,'workbench-top');
      local(item,-.55,1.04,.26,[.29,.18,.25],m.iron,'bench-vise');local(item,-.55,1.16,.26,[.32,.08,.25],m.iron,'vise-jaws');
      local(item,.40,1.05,0,[.48,.09,.21],m.woodFrame,'workpiece');local(item,.04,1.03,-.16,[.035,.055,.48],m.iron,'woodworking-tools');
      local(item,0,1.34,-.37,[1.66,.67,.06],m.woodDark,'tool-rack');
      for(let i=0;i<5;i++){local(item,-.60+i*.30,1.40,-.31,[.035,.31,.035],m.woodLight,'tool-handles');local(item,-.60+i*.30,1.57,-.31,[.14,.06,.055],m.iron,'tool-heads');}
    }else if(item.type==='crate'){
      local(item,0,.33,0,[.64,.64,.64],m.woodDark,'crate-body');
      for(let i=0;i<4;i++){for(const z of [-.33,.33])local(item,(i-1.5)*.16,.33,z,[.145,.60,.035],m.woodLight,'crate-slats',shade(.93,.12));local(item,(i-1.5)*.16,.67,0,[.145,.04,.64],m.woodLight,'crate-lid');}
      for(const yy of [.11,.56])for(const z of [-.35,.35])local(item,0,yy,z,[.70,.075,.045],m.woodFrame,'crate-rails');
    }else if(item.type==='sack'){
      local(item,0,.31,0,[.22,.32,.22],m.cream,'grain-sack',null,geo.sphere);local(item,0,.61,0,[.075,.08,.075],m.woodLight,'sack-tie',null,geo.cylinder);
    }else if(item.type==='cupboard'||item.type==='wardrobe'){
      const width=item.type==='wardrobe'?1.22:1.10,height=item.type==='wardrobe'?1.83:1.64;
      local(item,0,height/2,0,[width,height,.58],m.woodDark,'storage-cabinet');
      for(const side of [-1,1]){local(item,side*width*.245,height/2,.31,[width*.46,height-.16,.055],m.woodLight,'cabinet-panels');local(item,side*.075,height*.51,.36,[.035,.12,.035],m.iron,'cabinet-handles');}
      for(const yy of [.06,height-.045])local(item,0,yy,.02,[width+.06,.11,.66],m.woodFrame,'cabinet-cornice');
      if(item.type==='cupboard')for(let i=0;i<3;i++)bottle(item,(i-1)*.22,height+.01,.03,i%2?m.red:m.green);
    }else if(item.type==='washbasin'){
      for(const x of [-.22,.22])for(const z of [-.20,.20])local(item,x,.36,z,[.06,.72,.06],m.woodDark,'washstand-legs');
      local(item,0,.76,0,[.66,.11,.62],m.woodLight,'washstand');local(item,0,.89,0,[.25,.18,.23],m.plate,'wash-bowl',null,geo.cylinder);local(item,0,.985,0,[.20,.015,.18],m.water,'wash-water',null,geo.cylinder);
    }else if(item.type==='fireplace'){
      local(item,0,.08,.06,[1.65,.16,1.13],m.stone,'hearth-slab');local(item,0,.61,-.22,[1.40,1.10,.54],m.void,'hearth-recess');
      for(const side of [-1,1])for(let row=0;row<4;row++)local(item,side*.60,.18+row*.27,.10,[.25,.25,.76],m.stone,'hearth-pillars',shade(.9,.15));
      local(item,0,1.24,.10,[1.61,.25,.88],m.stone,'hearth-lintel');local(item,0,1.85,-.10,[1.05,.99,.62],m.mortar,'hearth-hood');
      for(let row=0;row<4;row++)for(let col=0;col<3;col++)local(item,(col-1)*.33,1.49+row*.23,.24,[.31,.21,.055],m.stone,'hearth-hood-stones',shade(.9,.14));
      for(let i=0;i<4;i++)local(item,(i-1.5)*.14,.40,.10,[.09,.27+(i%2)*.10,.08],i%2?m.flame:m.fireCore,'hearth-fire',null,geo.cone);
    }
  }

  for(const item of layout.items)furniture(item);
  // Candle sconces are placed against the full rear wall, above service work.
  for(const x of [-W*.32,W*.32]){box([x,1.83,-hd+.13],[.13,.27,.10],m.iron,identity,null,'sconce-brackets');cylinder([x,1.92,-hd+.27],.05,.19,m.cream,identity,'wall-candles');shape(geo.cone,m.flame,[x,2.06,-hd+.27],[.04,.10,.04],identity,null,'candle-flames');}
  let instanceCount=0;
  for(const b of batches.values()){const object=new THREE.InstancedMesh(b.g,b.mat,b.matrices.length);object.name=b.name;for(let i=0;i<b.matrices.length;i++){object.setMatrixAt(i,b.matrices[i]);object.setColorAt(i,b.colors[i]);}object.instanceMatrix.needsUpdate=true;object.instanceColor.needsUpdate=true;object.castShadow=true;object.receiveShadow=true;object.computeBoundingSphere();group.add(object);instanceCount+=b.matrices.length;}
  for(const [index,occupant]of layout.occupants.entries()){const actor=buildCharacter({preset:occupant.preset,seed:c.seed+index*17,height:1.62,direction:occupant.rotation,animation:'idle'});actor.position.set(occupant.x,.125,occupant.z);actor.name=occupant.id;group.add(actor);}
  group.updateMatrixWorld(true);const bounds=new THREE.Box3().setFromObject(group);
  const {config,...publicLayout}=layout;
  group.userData={kind:'interior',config:c,parts:group.children.length,instances:instanceCount,
    bounds:{min:bounds.min.toArray(),max:bounds.max.toArray(),size:bounds.getSize(new THREE.Vector3()).toArray()},
    layout:publicLayout,warnings:layout.warnings};
  Object.defineProperty(group.userData,'ownedTextures',{value:[...ownedTextures],enumerable:false});
  return group;
}
