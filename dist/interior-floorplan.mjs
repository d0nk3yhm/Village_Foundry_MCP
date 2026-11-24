import {normalizeInterior} from './interior-schema.mjs';

export const FURNITURE_DIMENSIONS=Object.freeze({table:[1.24,.92],round_table:[1.25,1.25],chair:[.51,.55],bench:[1.70,.48],stool:[.44,.44],barrel:[.74,.74],shelf:[1.42,.40],bed:[1.28,2.18],chest:[.96,.56],plant:[.60,.60],rug:[2.05,1.48],bar:[2.60,.82],counter:[1.60,.64],stove:[1.45,.98],sink:[1.10,.65],workbench:[1.80,.86],crate:[.70,.70],sack:[.48,.48],cupboard:[1.10,.58],wardrobe:[1.22,.62],washbasin:[.66,.66],fireplace:[1.65,1.13]});
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),round=v=>Math.round(v*1e4)/1e4;
function random(seed){let s=seed||1;return()=>{s+=0x6D2B79F5;let t=Math.imul(s^s>>>15,1|s);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296;};}
export const rectanglesOverlap=(a,b,gap=0)=>Math.abs(a.x-b.x)<(a.width+b.width)/2+gap&&Math.abs(a.z-b.z)<(a.depth+b.depth)/2+gap;
const center=b=>({x:(b.minX+b.maxX)/2,z:(b.minZ+b.maxZ)/2});
function rect(b){return{...center(b),width:b.maxX-b.minX,depth:b.maxZ-b.minZ};}
export function furnitureFootprint(item){const [w,d]=FURNITURE_DIMENSIONS[item.type]||[.5,.5],s=item.scale||1,a=(item.rotation||0)*Math.PI/180;return{id:item.id,x:item.x,z:item.z,width:(Math.abs(Math.cos(a))*(item.length||w)+Math.abs(Math.sin(a))*d)*s,depth:(Math.abs(Math.sin(a))*(item.length||w)+Math.abs(Math.cos(a))*d)*s};}
const roomLabels={taproom:'Public taproom',snug:'Fireside snug',living:'Living room',dining:'Dining room',common:'Common room',reception:'Reception',kitchen:'Kitchen',store:'Storeroom',pantry:'Pantry',shop:'Shop',workroom:'Workroom',bedroom:'Bedroom',guestroom:'Guest room',hall:'Hallway',foyer:'Stair lobby',linen:'Linen and wash room'};

/** Connected rectangular floorplans, circulation first, then real furniture. */
export function planInterior(raw={}){
  const c=normalizeInterior(raw),r=random(c.seed^0x47a9),W=c.width,D=c.depth,hw=W/2,hd=D/2;
  const variant=c.layoutVariant==='auto'?((c.seed^(c.seed>>>4))>>>0)%6:c.layoutVariant,mirror=variant%2===1;
  const rooms=[],connections=[],partitions=[],warnings=[...c.normalizationWarnings],items=[],occupied=[],reserved=[],stairs=[];
  const excluded=new Set(c.excludeIds),customIds=new Set(c.items.map(v=>v.id));
  const suppressed=id=>excluded.has(id)||customIds.has(id);
  const room=(id,type,minX,maxX,minZ,maxZ)=>{const v={id,type,label:roomLabels[type]||type,bounds:{minX,maxX,minZ,maxZ},doors:[]};rooms.push(v);return v;};
  const mainType={tavern:'taproom',cottage:'living',inn:'common',workshop:'shop'}[c.preset];
  let mainRoom;
  if(c.floorIndex>0){
    const foyerZ=hd-3.8,corridor=1.50;
    mainRoom=room('stair-lobby','foyer',-hw,hw,foyerZ,hd);
    if(D<6.8){
      room(c.bedrooms?'bedroom-1':'linen-1',c.bedrooms?(c.preset==='inn'?'guestroom':'bedroom'):'linen',-hw,hw,-hd,foyerZ);
      if(c.bedrooms>1)warnings.push(`This short upper floor fits one private bedroom with usable stair access; ${c.bedrooms} were requested.`);
    }else{
    room('hall','hall',-corridor/2,corridor/2,-hd,foyerZ);
    const maxRows=Math.max(1,Math.floor((D-3.8)/2.2)),wanted=Math.min(c.bedrooms,maxRows*2),counts=[Math.ceil(wanted/2),Math.floor(wanted/2)];
    if(wanted<c.bedrooms)warnings.push(`This footprint fits ${wanted} private bedrooms with clear doors; ${c.bedrooms} were requested.`);
    let bedIndex=0;
    for(let side=0;side<2;side++){
      const n=Math.max(1,counts[side]),lo=side===0?-hw:corridor/2,hi=side===0?-corridor/2:hw;
      for(let i=0;i<n;i++){const a=-hd+i*(D-3.8)/n,b=-hd+(i+1)*(D-3.8)/n,isBed=i<counts[side];room(isBed?`bedroom-${++bedIndex}`:`linen-${side+1}`,isBed?(c.preset==='inn'?'guestroom':'bedroom'):'linen',lo,hi,a,b);}
    }
    }
  }else{
    let topology=Math.floor(variant/2);if(W<7&&topology===2){topology=0;warnings.push('This compact footprint uses a rear service band so room doors and stairs stay connected.');}
    const backDepth=Math.min(D-3.8,Math.max(2.20,D*(.31+r()*.06))),cutZ=-hd+backDepth;
    let services=c.preset==='cottage'?['bedroom',c.kitchen?'kitchen':'store']:c.preset==='workshop'?(W<7.2&&c.floorCount>1?['workroom',c.kitchen?'kitchen':'store']:['workroom',c.kitchen?'kitchen':'store','bedroom']):[c.kitchen?'kitchen':'pantry','store'];
    if(c.preset==='cottage'&&c.bedrooms>1){const count=Math.min(c.bedrooms,Math.max(1,Math.floor(W/2.1)-1));services=[...Array.from({length:count},()=> 'bedroom'),c.kitchen?'kitchen':'store'];if(count<c.bedrooms)warnings.push(`The ground floor fits ${count} private bedroom${count===1?'':'s'}; additional bedrooms can be placed upstairs.`);}
    if(c.bedrooms===0)services=services.map(t=>t==='bedroom'?'store':t);
    if(topology===0){
      mainRoom=room('main',mainType,-hw,hw,cutZ,hd);
      let cursor=-hw,bedIndex=0;
      const weights=services.map(t=>t==='kitchen'||t==='workroom'?1.25:1),sum=weights.reduce((a,b)=>a+b,0);
      services.forEach((type,i)=>{const end=i===services.length-1?hw:cursor+W*weights[i]/sum;room(type==='bedroom'?`bedroom-${++bedIndex}`:`${type}-${i+1}`,type,cursor,end,-hd,cutZ);cursor=end;});
    }else if(topology===1){
      const wing=Math.min(hw-.82,Math.max(2.2,W*(.31+r()*.05))),cutX=hw-wing;
      mainRoom=room('main',mainType,-hw,cutX,-hd,hd);
      // A service wing changes the public room's orientation and circulation.
      const n=services.length;
      services.forEach((type,i)=>room(type==='bedroom'?`bedroom-${i+1}`:`${type}-${i+1}`,type,cutX,hw,-hd+i*D/n,-hd+(i+1)*D/n));
    }else{
      const frontSplit=Math.max(.80,W*.13),backSplit=(r()-.5)*W*.13;
      mainRoom=room('main',mainType,-hw,frontSplit,cutZ,hd);
      const aux=c.preset==='workshop'?(c.bedrooms?'bedroom':'store'):c.preset==='inn'?'reception':c.preset==='cottage'?'dining':'snug';
      room(aux==='bedroom'?'bedroom-1':'front-annex',aux,frontSplit,hw,cutZ,hd);
      const left=c.preset==='workshop'?'workroom':c.kitchen?'kitchen':'pantry',right=c.preset==='cottage'?(c.bedrooms?'bedroom':'store'):c.preset==='workshop'&&c.kitchen?'kitchen':'store';
      room('back-left',left,-hw,backSplit,-hd,cutZ);room(right==='bedroom'?'bedroom-1':'back-right',right,backSplit,hw,-hd,cutZ);
    }
    if(mirror)for(const v of rooms){const a=v.bounds.minX;v.bounds.minX=-v.bounds.maxX;v.bounds.maxX=-a;}
  }
  // Stair footprint is intentionally independent of floorIndex and program.
  // A building exports each floor with the same seed and therefore one shaft.
  if(c.stairs){
    const s={id:'main-stair',x:(mirror?1:-1)*(hw-.86),z:hd-2.40,width:1.30,depth:2.10,rotation:0,
      floorIndex:c.floorIndex,down:c.floorIndex>0?c.floorIndex-1:null,up:c.floorIndex<c.floorCount-1?c.floorIndex+1:null,
      landing:{x:(mirror?1:-1)*(hw-.86),z:hd-.65,width:1.30,depth:1.10}};
    stairs.push(s);occupied.push({...s,id:'stairs'});reserved.push({id:'stair-landing',...s.landing,kind:'stairs-clearance'});
  }
  const navStep=.20,navX=-hw+.65,navZ=-hd+.65;
  const snapX=x=>navX+Math.round((x-navX)/navStep)*navStep,snapZ=z=>navZ+Math.round((z-navZ)/navStep)*navStep;
  function shared(a,b){
    const A=a.bounds,B=b.bounds,eps=1e-5;
    if(Math.abs(A.maxZ-B.minZ)<eps||Math.abs(B.maxZ-A.minZ)<eps){const lo=Math.max(A.minX,B.minX),hi=Math.min(A.maxX,B.maxX);if(hi-lo>.45)return{axis:'x',at:Math.abs(A.maxZ-B.minZ)<eps?A.maxZ:B.maxZ,lo,hi};}
    if(Math.abs(A.maxX-B.minX)<eps||Math.abs(B.maxX-A.minX)<eps){const lo=Math.max(A.minZ,B.minZ),hi=Math.min(A.maxZ,B.maxZ);if(hi-lo>.45)return{axis:'z',at:Math.abs(A.maxX-B.minX)<eps?A.maxX:B.maxX,lo,hi};}
    return null;
  }
  const edges=[];for(let i=0;i<rooms.length;i++)for(let j=i+1;j<rooms.length;j++){const wall=shared(rooms[i],rooms[j]);if(wall)edges.push({a:rooms[i],b:rooms[j],wall,connected:false});}
  function doorFor(edge){
    const {a,b,wall}=edge,width=wall.hi-wall.lo<1.68?wall.hi-wall.lo-.02:Math.min(1.40,wall.hi-wall.lo-.28);
    let u=wall.axis==='x'?clamp(0,wall.lo+.85,wall.hi-.85):wall.hi-.86;
    u=wall.hi-wall.lo<1.68?(wall.lo+wall.hi)/2:clamp(wall.axis==='x'?snapX(u):snapZ(u),wall.lo+width/2+.06,wall.hi-width/2-.06);
    return{a:a.id,b:b.id,x:wall.axis==='x'?u:wall.at,z:wall.axis==='x'?wall.at:u,width,axis:wall.axis};
  }
  function doorBlocked(edge){const d=doorFor(edge),clear=d.axis==='x'?{x:d.x,z:d.z,width:d.width,depth:2.60}:{x:d.x,z:d.z,width:2.60,depth:d.width};return stairs.some(s=>rectanglesOverlap(clear,s,.03));}
  function connect(edge){
    if(edge.connected)return;const {a,b}=edge,door={id:`door-${connections.length+1}`,...doorFor(edge)};
    connections.push(door);a.doors.push(door.id);b.doors.push(door.id);edge.connected=true;edge.door=door;
  }
  const connected=new Set([mainRoom.id]);
  while(connected.size<rooms.length){const available=edges.filter(e=>(connected.has(e.a.id)!==connected.has(e.b.id))&&e.wall.hi-e.wall.lo>=1.40&&!doorBlocked(e)).sort((a,b)=>((b.a.id===mainRoom.id||b.b.id===mainRoom.id)?1:0)-((a.a.id===mainRoom.id||a.b.id===mainRoom.id)?1:0)||(b.wall.hi-b.wall.lo)-(a.wall.hi-a.wall.lo));if(!available.length)throw new Error('Interior rooms could not be connected with usable door widths.');const e=available[0];connect(e);connected.add(e.a.id);connected.add(e.b.id);}
  if(variant>=4)for(const e of edges)if(!e.connected&&e.wall.hi-e.wall.lo>2.4&&!doorBlocked(e)&&connections.length<rooms.length+1)connect(e);
  const walls=[];
  for(const e of edges){
    const w={id:`partition-${partitions.length+1}`,axis:e.wall.axis,at:e.wall.at,from:e.wall.lo,to:e.wall.hi,rooms:[e.a.id,e.b.id],doors:e.door?[e.door]:[]};partitions.push(w);
    const limits=e.door?[w.from,(w.axis==='x'?e.door.x:e.door.z)-e.door.width/2,(w.axis==='x'?e.door.x:e.door.z)+e.door.width/2,w.to]:[w.from,w.to];
    for(let i=0;i<limits.length;i+=2){const lo=limits[i],hi=limits[i+1];if(hi-lo>.03)walls.push(w.axis==='x'?{id:w.id,x:(lo+hi)/2,z:w.at,width:hi-lo,depth:.14}:{id:w.id,x:w.at,z:(lo+hi)/2,width:.14,depth:hi-lo});}
  }
  const upperEntry=c.floorIndex>0&&stairs.length?stairs[0].landing:null;
  const entrance=upperEntry?{...upperEntry,kind:'stairs',faces:'+Z',roomId:mainRoom.id}:{x:0,z:hd,width:1.45,depth:.66,kind:'exterior-door',faces:'+Z',roomId:mainRoom.id};
  // Mandatory beds precede circulation routing. Routes then pass beside them,
  // rather than reserving the center of a small bedroom and leaving it empty.
  const sleepingRooms=rooms.filter(v=>['bedroom','guestroom'].includes(v.type));
  for(const [index,v]of sleepingRooms.entries()){
    const id=`bed-${index+1}`;if(suppressed(id))continue;const b=v.bounds,doors=connections.filter(d=>d.a===v.id||d.b===v.id);let chosen=null;
    for(const scale of [1,.90,.82,.76]){
      const candidates=[];
      for(const rotation of [0,90,180,270]){
        const f=furnitureFootprint({type:'bed',scale,rotation,x:0,z:0});
        if(f.width>b.maxX-b.minX-.24||f.depth>b.maxZ-b.minZ-.24||Math.max(b.maxX-b.minX-f.width-.14,b.maxZ-b.minZ-f.depth-.14)<1.18)continue;
        for(const x of [b.minX+f.width/2+.13,b.maxX-f.width/2-.13])for(const z of [b.minZ+f.depth/2+.13,b.maxZ-f.depth/2-.13]){
          const candidate={id,type:'bed',x,z,rotation,scale},box=furnitureFootprint(candidate);
          const nearDoor=doors.some(d=>rectanglesOverlap(box,d.axis==='x'?{x:d.x,z:d.z,width:d.width+.08,depth:2.40}:{x:d.x,z:d.z,width:2.40,depth:d.width+.08},.03));
          if(nearDoor||occupied.some(o=>rectanglesOverlap(box,o,.06)))continue;
          candidates.push({candidate,box,rank:Math.min(...doors.map(d=>Math.hypot(x-d.x,z-d.z)))-z*.04});
        }
      }
      candidates.sort((a,b)=>b.rank-a.rank);if(candidates.length){chosen=candidates[0];break;}
    }
    if(chosen){items.push({...chosen.candidate,width:chosen.box.width,depth:chosen.box.depth,roomId:v.id,blocking:true});occupied.push(chosen.box);v.furnished=true;}
    else{v.furnished=false;warnings.push(`The bedroom ${v.id} is too compact for a bed and a usable doorway.`);}
  }
  const navNX=Math.max(1,Math.floor((W-1.3)/navStep)+1),navNZ=Math.max(1,Math.floor((D-1.3)/navStep)+1),count=navNX*navNZ,blocked=new Uint8Array(count),parent=new Int32Array(count).fill(-2);
  const navPoint=index=>({x:navX+(index%navNX)*navStep,z:navZ+Math.floor(index/navNX)*navStep});
  const obstacles=[...walls,...occupied];
  for(let i=0;i<count;i++){const p=navPoint(i);if(obstacles.some(o=>Math.abs(p.x-o.x)<o.width/2+.60&&Math.abs(p.z-o.z)<o.depth/2+.60))blocked[i]=1;}
  const nearestFree=(point,bounds=null)=>{let best=-1,distance=Infinity;for(let i=0;i<count;i++)if(!blocked[i]){const p=navPoint(i);if(bounds&&(p.x<bounds.minX+.10||p.x>bounds.maxX-.10||p.z<bounds.minZ+.10||p.z>bounds.maxZ-.10))continue;const d=(p.x-point.x)**2+(p.z-point.z)**2;if(d<distance){distance=d;best=i;}}return best;};
  const start=nearestFree(upperEntry||{x:0,z:hd-.65}),queue=new Int32Array(count);let head=0,tail=0;if(start>=0){queue[tail++]=start;parent[start]=-1;}
  while(head<tail){const at=queue[head++],x=at%navNX,z=Math.floor(at/navNX);for(const n of [x>0?at-1:-1,x<navNX-1?at+1:-1,z>0?at-navNX:-1,z<navNZ-1?at+navNX:-1])if(n>=0&&!blocked[n]&&parent[n]===-2){parent[n]=at;queue[tail++]=n;}}
  const routes=[];
  function reserveRoute(id,point,roomId=null){
    let target=nearestFree(point,roomId?rooms.find(v=>v.id===roomId)?.bounds:null);if(target<0||parent[target]===-2){warnings.push(`${id} has no safe 1.2-unit route to the entrance.`);return false;}
    const chain=[];while(target>=0){chain.push(navPoint(target));target=parent[target];}chain.reverse();
    const compressed=[];for(let i=0;i<chain.length;i++){if(i>0&&i<chain.length-1){const a=chain[i-1],b=chain[i],d=chain[i+1];if(Math.abs((b.x-a.x)*(d.z-b.z)-(b.z-a.z)*(d.x-b.x))<1e-8)continue;}compressed.push(chain[i]);}
    for(let i=1;i<compressed.length;i++){const a=compressed[i-1],b=compressed[i];reserved.push({id:`${id}-${i}`,x:(a.x+b.x)/2,z:(a.z+b.z)/2,width:Math.abs(a.x-b.x)+1.2,depth:Math.abs(a.z-b.z)+1.2,kind:'walkway'});}
    routes.push({id,roomId,width:1.2,points:compressed.map(p=>[round(p.x),round(p.z)])});return true;
  }
  reserved.push({id:'entrance-clearance',x:entrance.x,z:upperEntry?entrance.z:hd-.55,width:entrance.width,depth:1.1,kind:'entrance'});
  for(const v of rooms){
    if(v.id===mainRoom.id)continue;
    const door=connections.find(d=>d.a===v.id||d.b===v.id),mid=center(v.bounds),point={x:door.x,z:door.z};
    if(door.axis==='x')point.z+=Math.sign(mid.z-door.z)*.72;else point.x+=Math.sign(mid.x-door.x)*.72;
    v.walkPoint=point;reserveRoute(`access-${v.id}`,point,v.id);
  }
  for(const s of stairs)reserveRoute('stairs-access',s.landing,mainRoom.id);
  let centralAisle=null;
  if(c.clearCenter){
    const b=mainRoom.bounds,z=(b.minZ+b.maxZ)/2,depth=Math.max(.4,b.maxZ-b.minZ-1.2);
    for(const x of [(b.minX+b.maxX)/2,b.maxX-.75,b.minX+.75,0]){
      const strip={id:'central-public-aisle',x,z,width:1.2,depth,kind:'central-aisle',roomId:mainRoom.id};
      if(x-.6<b.minX+.10||x+.6>b.maxX-.10||stairs.some(s=>rectanglesOverlap(strip,s,.06)))continue;
      centralAisle=strip;reserved.push(strip);break;
    }
    if(!centralAisle)warnings.push('A separate central strip could not fit around the stair; the essential door routes remain reserved.');
  }
  const contains=(v,b,margin=.11)=>b.x-b.width/2>=v.bounds.minX+margin&&b.x+b.width/2<=v.bounds.maxX-margin&&b.z-b.depth/2>=v.bounds.minZ+margin&&b.z+b.depth/2<=v.bounds.maxZ-margin;
  const roomFor=b=>rooms.find(v=>contains(v,b));
  function canPlace(item,{ignoreRoutes=false}={}){const b=furnitureFootprint(item),v=roomFor(b);return v&&!occupied.some(o=>rectanglesOverlap(b,o,.07))&&(ignoreRoutes||!reserved.some(o=>rectanglesOverlap(b,o,.025)))?{b,room:v}:null;}
  function place(item,{custom=false,quiet=false}={}){
    if(!custom&&suppressed(item.id))return false;
    const nonBlocking=item.type==='rug',result=canPlace(item,{ignoreRoutes:nonBlocking});
    let staff=null;if(result&&custom&&item.type==='bar'){staff=barStaff(item);if(!contains(result.room,staff)||occupied.some(o=>rectanglesOverlap(staff,o,.03))||reserved.some(o=>rectanglesOverlap(staff,o,.025))){if(!quiet)warnings.push(`${item.id} was skipped because its staff side would block a wall, doorway, or reserved route.`);return false;}}
    if(!result){if(!quiet)warnings.push(`${item.id} was skipped because it crosses a room wall, doorway, stair clearance, or another furnishing.`);return false;}
    const placed={...item,width:result.b.width,depth:result.b.depth,roomId:result.room.id,blocking:!nonBlocking};items.push(placed);if(!nonBlocking)occupied.push({...result.b,id:item.id});if(staff)reserved.push(staff);return placed;
  }
  function candidates(v,type,scale=1){
    const b=v.bounds,out=[],step=.36;
    for(const rotation of [0,90,180,270]){
      const proto={type,scale,rotation,x:0,z:0},f=furnitureFootprint(proto);
      for(let z=b.minZ+f.depth/2+.16;z<=b.maxZ-f.depth/2-.15;z+=step)for(let x=b.minX+f.width/2+.16;x<=b.maxX-f.width/2-.15;x+=step){
        const wall=Math.min(x-f.width/2-b.minX,b.maxX-x-f.width/2,z-f.depth/2-b.minZ,b.maxZ-z-f.depth/2),facing=rotation===0?(z-b.minZ):rotation===180?(b.maxZ-z):rotation===90?(x-b.minX):(b.maxX-x);
        out.push({x:round(x),z:round(z),rotation,scale,rank:wall*2+facing*.10+r()*.12});
      }
    }
    out.sort((a,b)=>a.rank-b.rank);return out;
  }
  function barStaff(item){const a=item.rotation*Math.PI/180,s=item.scale,offset=.90*s;return{id:'bar-staff-space',x:item.x-Math.sin(a)*offset,z:item.z-Math.cos(a)*offset,width:(Math.abs(Math.cos(a))*2.6+Math.abs(Math.sin(a))*.85)*s,depth:(Math.abs(Math.sin(a))*2.6+Math.abs(Math.cos(a))*.85)*s,kind:'staff-only-clearance'};}
  function fitItem(id,type,v,{scales=[1,.9,.82],quiet=true}={}){
    if(suppressed(id))return null;
    for(const pass of type==='bar'?[0,1]:[0])for(const scale of scales){let spots=candidates(v,type,scale);if(type==='bar'){const preferred=c.barSide==='back'?0:c.barSide==='left'?90:270;spots=spots.filter(s=>pass===0?s.rotation===preferred:s.rotation!==preferred);}
      for(const spot of spots){const item={id,type,...spot};if(type==='bar'){const staff=barStaff(item);if(!contains(v,staff)||occupied.some(o=>rectanglesOverlap(staff,o,.03))||reserved.some(o=>rectanglesOverlap(staff,o,.025)))continue;}
        const result=place(item,{quiet:true});if(result){if(type==='bar')reserved.push(barStaff(item));return result;}}
    }
    if(!quiet)warnings.push(`${id} could not fit in ${v.label.toLowerCase()} while keeping its door and walking route clear.`);return null;
  }
  // Bedrooms are furnished first and each receives a bed independently of the
  // optional extra-bed count. A room is never advertised as furnished when empty.
  const sleeping=sleepingRooms;let bedNumber=0;
  for(const v of sleeping){bedNumber++;if(v.furnished){fitItem(`bedroom-chest-${bedNumber}`,'chest',v,{scales:[.90,.76]});if(c.shelves)fitItem(`wardrobe-${bedNumber}`,'wardrobe',v,{scales:[.86,.76]});}}
  for(let i=bedNumber;i<c.beds&&sleeping.length;i++)fitItem(`bed-${i+1}`,'bed',sleeping[i%sleeping.length],{scales:[.90,.82,.76],quiet:false});
  // Kitchens, stores and workshops have distinct working furniture families.
  for(const v of rooms){
    if(v.type==='kitchen'){
      fitItem(`stove-${v.id}`,'stove',v,{scales:[1,.86,.76],quiet:false});fitItem(`prep-${v.id}`,'counter',v,{scales:[1,.86,.76],quiet:false});fitItem(`sink-${v.id}`,'sink',v,{scales:[.90,.76]});if(c.shelves)fitItem(`cupboard-${v.id}`,'cupboard',v,{scales:[.9,.76]});
    }else if(['store','pantry','linen'].includes(v.type)){
      if(c.shelves)fitItem(`storage-shelf-${v.id}`,'shelf',v,{scales:[1,.86]});
      for(let i=0;i<3;i++)fitItem(`supplies-${v.id}-${i+1}`,v.type==='linen'?(i?'chest':'washbasin'):i===1?'sack':c.barrels?'barrel':'crate',v,{scales:[1,.86]});
    }else if(v.type==='workroom'){
      for(let i=0;i<(W*D>75?2:1);i++)fitItem(`workbench-${i+1}`,'workbench',v,{scales:[1,.86],quiet:false});fitItem('materials-crate','crate',v);if(c.shelves)fitItem('tool-cupboard','cupboard',v,{scales:[1,.86]});
    }
  }
  const publicRooms=rooms.filter(v=>['taproom','living','common','shop','reception','snug','dining','foyer'].includes(v.type));
  if(c.floorIndex===0&&c.bar){
    let bar=null;for(const v of publicRooms){bar=fitItem('bar','bar',v,{scales:[1,.86,.76],quiet:false});if(bar)break;}
    if(bar){const preferred=c.barSide==='back'?0:c.barSide==='left'?90:270;if(bar.rotation!==preferred)warnings.push(`The ${c.barSide} bar position could not keep staff access clear; this floorplan uses another wall.`);}
  }
  if(c.fireplace&&c.floorIndex===0){for(const v of publicRooms)if(fitItem('fireplace','fireplace',v,{scales:[1,.86,.76]}))break;}
  // Dining arrangements vary between rectangular tables, round tables, and
  // benches. Their full seating footprint is checked before placing the set.
  let placedTables=0;
  for(let index=0;index<c.tables;index++){
    const id=`table-${index+1}`;if(suppressed(id))continue;const type=(variant+index)%3===1?'round_table':'table';let chosen=null;
    for(const v of [...publicRooms].sort((a,b)=>(b.bounds.maxX-b.bounds.minX)*(b.bounds.maxZ-b.bounds.minZ)-(a.bounds.maxX-a.bounds.minX)*(a.bounds.maxZ-a.bounds.minZ))){
      for(const scale of [1,.88]){
        const spots=candidates(v,type,scale).sort((a,b)=>a.rank-b.rank);
        for(const spot of spots){
          const table={id,type,...spot};if(!canPlace(table))continue;
          const a=spot.rotation*Math.PI/180,co=Math.cos(a),si=Math.sin(a),offset=type==='round_table'?1.02:.83;
          const seat=(sign)=>({id:`${id}-chair-${sign<0?'back':'front'}`,type:'chair',x:spot.x+si*offset*sign*scale,z:spot.z+co*offset*sign*scale,rotation:spot.rotation+(sign<0?180:0),scale});
          const seats=[seat(-1),seat(1)].filter(s=>canPlace(s));if(!seats.length)continue;
          const p=place(table,{quiet:true});if(!p)continue;for(const s of seats)place(s,{quiet:true});chosen=p;break;
        }if(chosen)break;
      }if(chosen)break;
    }
    if(chosen)placedTables++;else warnings.push(`${id} was omitted so the room doors, stairs, and 1.2-unit routes remain usable.`);
  }
  for(const v of publicRooms){
    if(v.type==='reception'||v.type==='shop')fitItem(`${v.id}-counter`,v.type==='shop'?'workbench':'counter',v,{scales:[1,.86]});
    if(['snug','living','foyer'].includes(v.type))fitItem(`${v.id}-bench`,'bench',v,{scales:[1,.86]});
    if(c.rug){const b=v.bounds,p=center(b);place({id:`rug-${v.id}`,type:'rug',x:p.x,z:p.z,rotation:variant%2?90:0,scale:Math.min(1,(b.maxX-b.minX-.3)/2.05,(b.maxZ-b.minZ-.3)/1.48)},{quiet:true});}
    if(c.shelves&&v.type!=='foyer')fitItem(`public-shelf-${v.id}`,'shelf',v,{scales:[1,.86]});
    if(c.barrels&&v.type==='taproom')fitItem(`spare-keg-${v.id}`,'barrel',v);
    if(v.type!=='shop')fitItem(`plant-${v.id}`,'plant',v,{scales:[.9]});
  }
  for(const custom of c.items)place(custom,{custom:true});
  for(const v of sleeping)v.furnished=items.some(item=>item.type==='bed'&&item.roomId===v.id);
  const occupants=[];
  if(c.occupants){
    const staffedBar=items.find(item=>item.type==='bar'),staff=reserved.find(area=>area.kind==='staff-only-clearance');
    if(staffedBar&&staff){const a=staffedBar.rotation*Math.PI/180,body={x:staff.x,z:staff.z,width:Math.abs(Math.cos(a))*.72+Math.abs(Math.sin(a))*.58,depth:Math.abs(Math.sin(a))*.72+Math.abs(Math.cos(a))*.58};
      if(roomFor(body)&&!occupied.some(o=>rectanglesOverlap(body,o,.025))&&!reserved.some(o=>o!==staff&&rectanglesOverlap(body,o,.025))){occupants.push({id:'occupant-1',x:staff.x,z:staff.z,rotation:staffedBar.rotation,preset:'innkeeper',roomId:staffedBar.roomId,role:'bar staff'});occupied.push({...body,id:'occupant-1'});}}
    for(const v of publicRooms.slice(0,3))for(const spot of candidates(v,'stool',1.7)){const candidate={id:`occupant-${occupants.length+1}`,type:'stool',...spot};const test=canPlace(candidate);if(test){occupants.push({id:candidate.id,x:spot.x,z:spot.z,rotation:spot.rotation,preset:c.preset==='workshop'?'blacksmith':c.preset==='tavern'?'innkeeper':'villager',roomId:v.id});occupied.push({...test.b,id:candidate.id});break;}}
    if(!occupants.length)warnings.push('No occupant fits outside the reserved routes. Reduce optional furniture or turn off the extra central aisle.');
  }
  const bedroomTarget=c.floorIndex>0||['cottage','workshop'].includes(c.preset)?c.bedrooms:0;
  if(sleeping.length<bedroomTarget&&!warnings.some(w=>w.includes('private bedroom')))warnings.push(`This floorplan contains ${sleeping.length} of ${bedroomTarget} requested bedrooms; use a larger footprint or another floor for the remainder.`);
  return{config:c,variant,floorIndex:c.floorIndex,floorCount:c.floorCount,rooms,connections,partitions,walls,stairs,items,occupants,entrance,reserved,
    walkable:{mainAisleWidth:1.2,mainAisleClear:true,centralAisleReserved:Boolean(centralAisle),centralAisle,connectedRooms:routes.length===rooms.length-1+stairs.length,roomGraphConnected:connected.size===rooms.length,staffSpaceReserved:reserved.some(v=>v.kind==='staff-only-clearance'),routes,method:'connected door graph and obstacle-aware grid paths reserved before furniture'},
    warnings,requestedTables:c.tables,placedTables,requestedBedrooms:c.bedrooms,bedroomTarget,plannedBedrooms:sleeping.length,furnishedBedrooms:sleeping.filter(v=>v.furnished).length};
}
