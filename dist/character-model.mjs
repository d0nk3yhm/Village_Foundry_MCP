import * as THREE from './vendor/three.module.js';
import {createPaintedSurface} from './painted-surfaces.mjs';
import {CHARACTER_PRESETS,CHARACTER_ANIMATIONS,CHARACTER_ANIMATION_DURATIONS,CHARACTER_DURATIONS,normalizeCharacter} from './character-schema.mjs';
export {CHARACTER_PRESETS,CHARACTER_ANIMATIONS,CHARACTER_ANIMATION_DURATIONS,CHARACTER_DURATIONS,normalizeCharacter};

const DOWN=new THREE.Vector3(0,-1,0),UP=new THREE.Vector3(0,1,0);
const TAU=Math.PI*2,clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function random(seed){let a=seed||1;return()=>{a+=0x6D2B79F5;let t=Math.imul(a^a>>>15,1|a);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296;};}
const blend=(a,b,t)=>new THREE.Color(a).lerp(new THREE.Color(b),t);

/** Smooth elliptical ring meshes give heads, bodies and limbs tailored shapes. */
function profileGeometry(profile,segments=24){
  const positions=[],uv=[],index=[];const lo=profile[0][0],span=profile.at(-1)[0]-lo;
  for(const [y,rx,rz]of profile)for(let j=0;j<=segments;j++){const a=j/segments*TAU+Math.PI;positions.push(Math.sin(a)*rx,y,Math.cos(a)*rz);uv.push(j/segments,(y-lo)/span);}
  for(let k=0;k<profile.length-1;k++)for(let j=0;j<segments;j++){const a=k*(segments+1)+j,b=a+1,c=a+segments+1,d=c+1;index.push(a,b,c,b,d,c);}
  for(const [k,reverse]of [[0,true],[profile.length-1,false]]){const center=positions.length/3;positions.push(0,profile[k][0],0);uv.push(.5,.5);for(let j=0;j<segments;j++){const a=k*(segments+1)+j,b=a+1;index.push(center,...(reverse?[b,a]:[a,b]));}}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(index);g.computeVertexNormals();return g;
}

function shapedPanel(points,depth,thickness=.012){
  // Subdivide the face before bending it: a polygon bent only at its corners
  // becomes a rigid plate and intersects the curved torso below it.
  const positions=[],uv=[],indices=[],vertices=new Map(),xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  const xmin=Math.min(...xs),ymin=Math.min(...ys),dx=Math.max(...xs)-xmin||1,dy=Math.max(...ys)-ymin||1;
  const z=(x,y)=>typeof depth==='function'?depth(x,y):depth;
  const vertex=(x,y,front)=>{const key=`${Math.round(x*1e7)},${Math.round(y*1e7)},${front}`;if(vertices.has(key))return vertices.get(key);const i=positions.length/3;positions.push(x,y,z(x,y)+(front?thickness:0));uv.push((x-xmin)/dx,(y-ymin)/dy);vertices.set(key,i);return i;};
  const triangle=(a,b,c,front)=>{let ids=[vertex(...a,front),vertex(...b,front),vertex(...c,front)];if(((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])>0)!==front)ids.reverse();indices.push(...ids);};
  const triangles=THREE.ShapeUtils.triangulateShape(points.map(p=>new THREE.Vector2(...p)),[]),steps=6;
  for(const [ia,ib,ic]of triangles){const a=points[ia],b=points[ib],c=points[ic],p=(i,j)=>[a[0]+(b[0]-a[0])*i/steps+(c[0]-a[0])*j/steps,a[1]+(b[1]-a[1])*i/steps+(c[1]-a[1])*j/steps];for(let i=0;i<steps;i++)for(let j=0;j<steps-i;j++)for(const front of [true,false]){triangle(p(i,j),p(i+1,j),p(i,j+1),front);if(i+j<steps-1)triangle(p(i+1,j),p(i+1,j+1),p(i,j+1),front);}}
  const clockwise=THREE.ShapeUtils.isClockWise(points.map(p=>new THREE.Vector2(...p)));
  for(let i=0;i<points.length;i++)for(let j=0;j<steps;j++){const a=points[i],b=points[(i+1)%points.length],p=t=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t],v=p(j/steps),w=p((j+1)/steps);const q=[vertex(...v,false),vertex(...w,false),vertex(...v,true),vertex(...w,true)];indices.push(...(clockwise?[q[0],q[2],q[1],q[1],q[2],q[3]]:[q[0],q[1],q[2],q[1],q[3],q[2]]));}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(indices);g.computeVertexNormals();return g;
}

const skirtProfile=build=>[[-.43,.285*build,.218],[-.37,.282*build,.211],[-.25,.263*build,.195],[-.11,.229*build,.165],[.012,.188*build,.128]];
function skirtGeometry(build=1){
  const rings=skirtProfile(build),segments=48,positions=[],uv=[],index=[];
  for(let k=0;k<rings.length;k++){const[y,rx,rz]=rings[k],gather=1-k/(rings.length-1);for(let i=0;i<=segments;i++){const a=i/segments*TAU,fold=1+.038*Math.cos(a*12)*gather;positions.push(Math.sin(a)*rx*fold,y+.004*Math.cos(a*6)*gather,Math.cos(a)*rz*fold);uv.push(i/segments,k/(rings.length-1));}}
  for(let k=0;k<rings.length-1;k++)for(let i=0;i<segments;i++){const a=k*(segments+1)+i,b=a+1,c=a+segments+1,d=c+1;index.push(a,b,c,b,d,c);}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(index);g.computeVertexNormals();return g;
}

function hairLockGeometry(points,width=.035){
  const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),segments=10,radial=8,frames=curve.computeFrenetFrames(segments,false),pos=[],uv=[],idx=[];
  for(let i=0;i<=segments;i++){const t=i/segments,center=curve.getPoint(t),radius=width*(.65+.45*Math.sin(t*Math.PI))*(1-.87*t*t);for(let j=0;j<=radial;j++){const a=j/radial*TAU,v=center.clone().addScaledVector(frames.normals[i],Math.cos(a)*radius).addScaledVector(frames.binormals[i],Math.sin(a)*radius);pos.push(...v.toArray());uv.push(j/radial,t);}}
  for(let i=0;i<segments;i++)for(let j=0;j<radial;j++){const a=i*(radial+1)+j,b=a+1,c=a+radial+1,d=c+1;idx.push(a,b,c,b,d,c);}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(idx);g.computeVertexNormals();return g;
}

/** A two-bone solver in the coordinate frame shared by the shoulder/hip. */
function solveLimb(limb,target,preferred=[0,0,1],endRotation=null){
  const s=limb.upper.position.clone(),t=new THREE.Vector3(...target),delta=t.clone().sub(s),distance=clamp(delta.length(),.035,limb.l1+limb.l2-.0001),direction=delta.normalize();
  const along=(limb.l1*limb.l1-limb.l2*limb.l2+distance*distance)/(2*distance),height=Math.sqrt(Math.max(0,limb.l1*limb.l1-along*along));
  let bend=new THREE.Vector3(...preferred).addScaledVector(direction,-new THREE.Vector3(...preferred).dot(direction));
  if(bend.lengthSq()<1e-8)bend=new THREE.Vector3(1,0,0).addScaledVector(direction,-direction.x);bend.normalize();
  const elbow=s.clone().addScaledVector(direction,along).addScaledVector(bend,height),actual=s.clone().addScaledVector(direction,distance);
  const upperQ=new THREE.Quaternion().setFromUnitVectors(DOWN,elbow.clone().sub(s).normalize()),lowerQ=new THREE.Quaternion().setFromUnitVectors(DOWN,actual.clone().sub(elbow).normalize());
  limb.upper.quaternion.copy(upperQ);limb.lower.quaternion.copy(upperQ.clone().invert().multiply(lowerQ));
  if(limb.end)limb.end.quaternion.copy(lowerQ.clone().invert().multiply(endRotation||new THREE.Quaternion()));
}

export function buildCharacter(raw={}){
  const c=normalizeCharacter(raw),r=random(c.seed),scale=c.height/1.80,sturdy=c.build==='sturdy',slim=c.build==='slim',build=sturdy?1.14:slim?.88:1;
  const female=c.gender==='female',child=c.age==='child',skirted=female&&c.preset!=='ranger',waist=(female?.181:.198)*build,shoulderWidth=(female?.205:.218)*build;
  const group=new THREE.Group();group.name=`${c.preset}-character`;group.scale.setScalar(scale);
  const body=new THREE.Group();body.name='body-motion';group.add(body);
  const torso=new THREE.Group();torso.name='spine';torso.position.y=.84;body.add(torso);
  const ownedTextures=new Set(),paintCache=new Map();
  function paint(kind,col,variant=0){const key=`${kind}:${col}:${variant}`;if(!paintCache.has(key)){const t=createPaintedSurface(THREE,kind,col,{seed:c.seed,variant});paintCache.set(key,t);if(t)ownedTextures.add(t);}return paintCache.get(key);}
  function material(col,{map=null,roughness=.95}={}){return new THREE.MeshStandardMaterial({color:map?'#ffffff':col,map,roughness,metalness:0,flatShading:false});}
  const m={skin:material(c.skinColor),skinLight:material(blend(c.skinColor,'#efd0ac',.13)),skinShade:material(blend(c.skinColor,'#8f5845',.23)),cheek:material(blend(c.skinColor,'#c47e67',.20)),
    hair:material(c.hairColor,{roughness:.87}),hairLight:material(blend(c.hairColor,'#f2dfad',.19)),hairDark:material(blend(c.hairColor,'#483c2e',.25)),
    tunic:material(c.tunicColor,{map:paint('plaster',c.tunicColor,0)}),clothShade:material(blend(c.tunicColor,'#4b4030',.25)),accent:material(c.accentColor,{map:paint('plaster',c.accentColor,1)}),
    linen:material('#e4d3ad',{map:paint('plaster','#e4d3ad',2)}),pants:material(c.trouserColor,{map:paint('plaster',c.trouserColor,3)}),pantsDark:material(blend(c.trouserColor,'#39332c',.25)),
    leather:material(c.leatherColor,{map:paint('plaster',c.leatherColor,4)}),leatherLight:material(blend(c.leatherColor,'#c8aa78',.20)),leatherDark:material(blend(c.leatherColor,'#352d26',.35)),
    brass:material('#b89b61'),iron:material('#5a5950'),eyeWhite:material('#e9dfca'),iris:material(c.preset.startsWith('blonde_')?'#6d8d91':c.preset==='ranger'?'#697453':'#675442'),pupil:material('#282522'),spark:material('#faf3dc'),lash:material(blend(c.hairColor,'#4e4035',.65)),
    lips:material(blend(c.skinColor,'#9d5c50',.40)),mouth:material('#54382e'),tongue:material('#ba806c'),foam:material('#eee1b8'),cup:material('#b19562')};
  const sphere=new THREE.SphereGeometry(1,20,12),smallSphere=new THREE.SphereGeometry(1,12,8),boxGeometry=new THREE.BoxGeometry(1,1,1);
  const vec=(x,y,z)=>new THREE.Vector3(x,y,z);
  function mesh(parent,g,mat,pos=[0,0,0],size=[1,1,1],name='detail',rotation=null){const o=new THREE.Mesh(g,mat);o.name=name;o.position.set(...pos);o.scale.set(...size);if(rotation)o.rotation.set(...rotation);o.castShadow=true;o.receiveShadow=true;parent.add(o);return o;}
  const ellipsoid=(parent,mat,pos,size,name='sculpted-form')=>mesh(parent,sphere,mat,pos,size,name);
  const box=(parent,mat,pos,size,name='tailoring')=>mesh(parent,boxGeometry,mat,pos,size,name);
  function line(parent,points,radius,mat,name='seam'){return mesh(parent,new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p=>vec(...p))),Math.max(6,points.length*3),radius,5,false),mat,[0,0,0],[1,1,1],name);}
  function strap(parent,a,b,width,mat,thick=.009){const av=vec(...a),bv=vec(...b),o=box(parent,mat,av.clone().add(bv).multiplyScalar(.5).toArray(),[width,av.distanceTo(bv),thick],'tailored-strap');o.quaternion.setFromUnitVectors(UP,bv.sub(av).normalize());return o;}
  const torsoProfile=[[-.15,(female?.211:.205)*build,.118],[-.09,(female?.211:.218)*build,.132],[.015,waist,.127],[.12,(female?.194:sturdy?.227:.207)*build,.137],[.27,shoulderWidth,.133],[.35,(female?.188:.199)*build,.112],[.40,.099,.075],[.42,.074,.063]];
  mesh(torso,profileGeometry(torsoProfile),m.tunic,[0,0,0],[1,1,1],'tailored-tunic');
  const frontDepth=(x,y)=>{let lo=torsoProfile[0],hi=torsoProfile.at(-1);for(let i=0;i<torsoProfile.length-1;i++)if(y>=torsoProfile[i][0]&&y<=torsoProfile[i+1][0]){lo=torsoProfile[i];hi=torsoProfile[i+1];break;}const t=clamp((y-lo[0])/(hi[0]-lo[0]||1),0,1),rx=lo[1]+(hi[1]-lo[1])*t,rz=lo[2]+(hi[2]-lo[2])*t;return rz*Math.sqrt(Math.max(.04,1-(x/rx)**2))+.010;};
  const panel=(parent,points,mat,depth=frontDepth,name='garment-panel')=>mesh(parent,shapedPanel(points,depth),mat,[0,0,0],[1,1,1],name);
  ellipsoid(body,m.pants,[0,.745,0],[.195*build,.125,.119],'tailored-trousers-hips');
  // Cloth collar, garment edges, fastening, and soft folds.
  panel(torso,[[-.07,.40],[-.13,.33],[-.035,.265],[-.012,.36]],c.preset==='ranger'?m.accent:m.linen,frontDepth,'left-collar');
  panel(torso,[[.07,.40],[.13,.33],[.035,.265],[.012,.36]],c.preset==='ranger'?m.accent:m.linen,frontDepth,'right-collar');
  for(const side of [-1,1])line(torso,[[side*.17,.27,frontDepth(side*.17,.27)+.004],[side*.15,.08,frontDepth(side*.15,.08)+.006],[side*.18,-.09,frontDepth(side*.18,-.09)+.004]],.004,m.clothShade,'soft-fabric-fold');
  if(c.preset==='innkeeper'){
    panel(torso,[[-.065,.355],[.065,.355],[.053,.025],[-.053,.025]],m.linen,(x,y)=>frontDepth(x,y)+.008,'linen-shirt-front');
    for(const side of [-1,1])strap(torso,[side*.071,.34,frontDepth(side*.071,.34)+.020],[side*.065,.045,frontDepth(side*.065,.045)+.020],.018,m.clothShade);
  }
  if(c.preset==='villager'||c.preset==='blonde_man'||c.preset==='blonde_boy')for(const y of [.23,.13,.065])ellipsoid(torso,m.brass,[.015,y,frontDepth(.015,y)+.018],[.007,.007,.004],'tunic-buttons');
  if(skirted){
    panel(torso,[[-.062,.345],[.062,.345],[.056,.27],[-.056,.27]],m.linen,(x,y)=>frontDepth(x,y)+.006,'soft-blouse-neckline');
    for(const side of [-1,1])line(torso,[[side*.065,.305,frontDepth(side*.065,.305)+.023],[side*.050,.17,frontDepth(side*.050,.17)+.023],[side*.037,.068,frontDepth(side*.037,.068)+.023]],.003,m.accent,'bodice-edging');
    for(let i=0;i<3;i++){const y=.11+i*.047;line(torso,[[-.045,y+.020,frontDepth(-.045,y+.020)+.027],[.046,y-.010,frontDepth(.046,y-.010)+.027]],.0025,m.leatherLight,'bodice-lacing');line(torso,[[.045,y+.020,frontDepth(.045,y+.020)+.027],[-.046,y-.010,frontDepth(-.046,y-.010)+.027]],.0025,m.leatherLight,'bodice-lacing');}
  }
  const belt=mesh(torso,new THREE.CylinderGeometry(waist+.009,waist+.012,.048,32,1,true),m.leatherDark,[0,.024,0],[1,1,.135/(waist+.009)],'waist-belt');
  for(const x of [-.028,.028])box(torso,m.brass,[x,.024,.151],[.008,.046,.013],'belt-buckle');
  for(const y of [.002,.046])box(torso,m.brass,[0,y,.151],[.061,.008,.013],'belt-buckle');
  box(torso,m.brass,[.005,.024,.163],[.035,.006,.006],'buckle-tongue');
  const pouch=new THREE.Group();pouch.position.set(.215*build,-.05,.075);pouch.rotation.z=-.08;torso.add(pouch);
  ellipsoid(pouch,m.leather,[0,-.035,0],[.065,.082,.044],'belt-pouch');
  panel(pouch,[[-.060,.012],[.060,.012],[.055,-.038],[0,-.065],[-.055,-.038]],m.leatherLight,.038,'pouch-flap');
  ellipsoid(pouch,m.brass,[0,-.045,.052],[.008,.008,.005],'pouch-clasp');
  // The old flat apron was a board-shaped silhouette in front of the legs.
  // Waistcoats now follow the body; any skirt is an enclosed, gathered surface.
  const garment=new THREE.Group();garment.name='soft-clothing';torso.add(garment);
  if(c.preset==='innkeeper'||c.preset==='blacksmith'){
    const smith=c.preset==='blacksmith',vest=smith?m.leather:m.tunic,edge=smith?m.leatherDark:m.clothShade;
    for(const side of [-1,1]){
      const p=[[-.064,.335],[-.168,.354],[-.205,.27],[-.199,.125],[-.175,-.07],[-.055,-.09],[-.046,.24]].map(([x,y])=>[x*side*build,y]);
      panel(torso,p,vest,(x,y)=>frontDepth(x,y)+.008,'fitted-waistcoat');
      line(torso,[[side*.065*build,.33,frontDepth(side*.065*build,.33)+.024],[side*.048*build,.21,frontDepth(side*.048*build,.21)+.024],[side*.052*build,-.08,frontDepth(side*.052*build,-.08)+.024]],.0038,edge,'waistcoat-piping');
      line(torso,[[side*.080*build,.105,frontDepth(side*.080*build,.105)+.025],[side*.145*build,.108,frontDepth(side*.145*build,.108)+.025]],.006,edge,'waistcoat-pocket-welt');
    }
    for(const y of [.205,.135,.075])ellipsoid(torso,m.brass,[.052*build,y,frontDepth(.052*build,y)+.030],[.007,.007,.004],'waistcoat-buttons');
  }
  if(skirted){
    const skirtMaterial=m.tunic.clone();skirtMaterial.side=THREE.DoubleSide;
    mesh(garment,skirtGeometry(build),skirtMaterial,[0,0,0],[1,1,1],'gathered-skirt');
    const hem=[];for(let i=0;i<=48;i++){const a=i/48*TAU,fold=1+.038*Math.cos(a*12);hem.push([Math.sin(a)*.285*build*fold,-.422+.004*Math.cos(a*6),Math.cos(a)*.218*fold]);}line(garment,hem,.006,m.accent,'curved-skirt-hem');
  }else{
    for(const side of [-1,1])line(torso,[[side*.035,-.145,.120],[side*.10,-.147,frontDepth(side*.10,-.147)],[side*.175*build,-.145,frontDepth(side*.175*build,-.145)]],.004,m.clothShade,'soft-tunic-hem');
  }
  if(c.preset==='ranger'){
    strap(torso,[-.18,.34,.105],[.17,-.035,.158],.043,m.leatherDark);
    const pos=[],uv=[],index=[],cols=10,rows=12;
    for(let iy=0;iy<=rows;iy++)for(let ix=0;ix<=cols;ix++){const v=iy/rows,u=ix/cols,x=(u-.5)*(.40+v*.21);pos.push(x,.36-v*.68,-.13-v*.10-.016*Math.cos(u*Math.PI*8)*Math.sin(v*Math.PI));uv.push(u,1-v);}
    for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const a=y*(cols+1)+x,b=a+1,d=a+cols+1,e=d+1;index.push(a,d,b,b,d,e);}
    const capeGeo=new THREE.BufferGeometry();capeGeo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));capeGeo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));capeGeo.setIndex(index);capeGeo.computeVertexNormals();
    const capeMat=material(blend(c.tunicColor,'#403d2c',.18),{map:paint('plaster',`#${blend(c.tunicColor,'#403d2c',.18).getHexString()}`,5)});capeMat.side=THREE.DoubleSide;mesh(torso,capeGeo,capeMat,[0,0,0],[1,1,1],'sculpted-travel-cloak');
    const quiver=new THREE.Group();quiver.position.set(-.15,.18,-.16);quiver.rotation.z=.22;torso.add(quiver);
    mesh(quiver,new THREE.CylinderGeometry(.052,.042,.39,14),m.leather,[0,.06,0],[1,1,1],'quiver');
    for(let i=0;i<3;i++){const x=(i-1)*.022;mesh(quiver,new THREE.CylinderGeometry(.003,.003,.49,6),m.leatherLight,[x,.26,0],[1,1,1],'arrow-shafts');panel(quiver,[[x-.019,.39],[x,.45],[x+.019,.39],[x,.34]],i%2?m.accent:m.linen,.003,'arrow-fletching');}
  }
  if(c.preset==='blacksmith'){
    const hammer=new THREE.Group();hammer.position.set(-.22*build,-.09,.055);hammer.rotation.z=-.19;torso.add(hammer);
    mesh(hammer,new THREE.CylinderGeometry(.014,.017,.25,10),m.leatherLight,[0,-.08,0],[1,1,1],'hammer-handle');
    ellipsoid(hammer,m.iron,[0,.06,0],[.075,.036,.043],'forged-hammer-head');
  }

  // Head, neck and a readable sculpted face.
  const head=new THREE.Group();head.name='head';head.position.set(0,.46,0);torso.add(head);
  mesh(head,new THREE.CylinderGeometry(.066,.073,.13,24),m.skin,[0,.029,0],[1,1,1],'neck');
  const face=new THREE.Group();face.name='identity-face';face.position.y=.22;head.add(face);
  face.scale.setScalar(child?1.11:1);
  const faceWide=(sturdy?1.04:slim?.96:1)*(female?.94:1),jaw=female?.90:child?.94:1;
  const headProfile=[[-.187,.052*jaw,.060],[-.159,.098*jaw,.091],[-.115,.132*jaw,.111],[-.058,.151,.123],[.018,.157,.130],[.084,.149,.123],[.139,.125,.106],[.177,.075,.067],[.190,.019,.018]].map(([y,x,z])=>[y,x*faceWide,z]);
  mesh(face,profileGeometry(headProfile,32),m.skin,[0,0,0],[1,1,1],'sculpted-head');
  for(const side of [-1,1]){
    ellipsoid(face,m.skin,[side*.158*faceWide,-.018,-.003],[.030,.050,.029],'ear');
    ellipsoid(face,m.skinShade,[side*.178*faceWide,-.019,.009],[.010,.030,.014],'inner-ear');
    ellipsoid(face,m.cheek,[side*.092*faceWide,-.041,.107],[.029,.014,.0045],'subtle-cheek');
  }
  ellipsoid(face,m.skinLight,[0,-.007,.137],[female||child?.018:.021,female||child?.031:.036,female||child?.029:.033],'nose-bridge-and-tip');
  for(const side of [-1,1])ellipsoid(face,m.skinShade,[side*.009,-.028,.157],[.0037,.0028,.0023],'nostril');
  const eyes=[];
  for(const side of [-1,1]){
    const eye=new THREE.Group();eye.name=side<0?'right-eye':'left-eye';eye.position.set(side*.057*faceWide,.034,.122);eye.scale.x=female||child?1.06:1;face.add(eye);eyes.push(eye);
    ellipsoid(eye,m.skinShade,[0,0,-.001],[.030,.018,.009],'eye-socket');
    ellipsoid(eye,m.eyeWhite,[0,0,.004],[.026,.0128,.0065],'eye-white');
    ellipsoid(eye,m.iris,[side*.001,0,.0108],[.009,.0103,.003],'iris');
    ellipsoid(eye,m.pupil,[side*.001,0,.0133],[.0045,.007,.0018],'pupil');
    mesh(eye,smallSphere,m.spark,[-.0035,.004,.0152],[.0024,.0024,.0014],'eye-catchlight');
    const ex=side*.057*faceWide;
    line(face,[[ex-.027,.038,.132],[ex,.049,.137],[ex+.027,.038,.132]],female?.0037:.0032,m.lash,'upper-eyelid');
    line(face,[[ex-.027,.067,.127],[ex,.075+(side<0?.002:0),.137],[ex+.027,.067,.127]],female||child?.0038:.005,m.hairDark,'eyebrow');
  }
  const closedMouth=new THREE.Group();closedMouth.name='closed-mouth';face.add(closedMouth);
  line(closedMouth,[[-.031,-.076,.124],[0,-.081,.132],[.031,-.076,.124]],.0031,m.lips,'mouth-line');
  line(closedMouth,[[-.020,-.085,.125],[0,-.088,.130],[.020,-.085,.125]],.0028,m.skinLight,'lower-lip-highlight');
  const openMouth=new THREE.Group();openMouth.name='speaking-mouth';openMouth.position.set(0,-.080,.129);face.add(openMouth);
  ellipsoid(openMouth,m.lips,[0,0,-.002],[.031,.019,.007],'lip-rim');
  ellipsoid(openMouth,m.mouth,[0,0,.003],[.026,.014,.005],'mouth-interior');
  ellipsoid(openMouth,m.eyeWhite,[0,.007,.006],[.021,.004,.002],'upper-teeth');
  ellipsoid(openMouth,m.tongue,[0,-.007,.007],[.016,.004,.002],'tongue');
  // A smooth hair cap plus independently sculpted broad locks and highlights.
  mesh(face,new THREE.SphereGeometry(1,24,12,0,TAU,0,Math.PI/2),m.hair,[0,.086,-.006],[.166*faceWide,.168,.145],'hair-crown');
  ellipsoid(face,m.hair,[0,.047,-.073],[.157*faceWide,.133,.083],'back-hair');
  for(const side of [-1,1])ellipsoid(face,m.hair,[side*.143*faceWide,.025,-.010],[.024,.074,.050],'sideburn-hair');
  const locks=c.hair==='short'?6:8;
  for(let i=0;i<locks;i++){
    const x=-.138+i*.276/(locks-1),offset=c.hair==='swept'?.055:c.hair==='short'?.012:.025;
    const points=[[x*.70-.014,.235+(r()-.5)*.009,.005],[x+.005,.190,.120],[clamp(x+offset,-.14,.14),.078+(i%3)*.011,.151]];
    mesh(face,hairLockGeometry(points,c.hair==='short'?.023:.028),i%4===0?m.hairLight:m.hair,[0,0,0],[1,1,1],'sculpted-fringe');
    if(i%3===0)line(face,points.map(([x,y,z])=>[x-.004,y+.012,z+.006]),.0018,m.hairLight,'soft-hair-highlight');
  }
  if(c.hair==='bob')for(const side of [-1,1])for(let i=0;i<4;i++)mesh(face,hairLockGeometry([[side*.12*faceWide,.13,-.064+i*.024],[side*.166*faceWide,-.035,-.047+i*.026],[side*.136*faceWide,female?-.185:-.151,-.035+i*.023]],.032),i===1?m.hairLight:m.hair,[0,0,0],[1,1,1],'sculpted-bob');
  if(c.hair==='braid'){
    for(const side of [-1,1])mesh(face,hairLockGeometry([[side*.13,.15,-.04],[side*.169,-.025,.032],[side*.143,-.16,.064]],.029),m.hair,[0,0,0],[1,1,1],'loose-face-framing-lock');
    for(let i=0;i<8;i++){const t=i/7,x=female?.155+.030*Math.sin(t*Math.PI):.08,z=female?-.070+.19*t:-.122,o=ellipsoid(face,i%3===0?m.hairLight:m.hair,[x+(i%2?-.012:.012),-.08-i*.037,z],[.030-.0017*i,.032,.027],'braid-section');o.rotation.z=(i%2?-.3:.3);}
    mesh(face,new THREE.TorusGeometry(.016,.006,6,12),m.accent,[female?.155:.08,-.351,female?.12:-.122],[1,1,1],'braid-tie',[Math.PI/2,0,0]);
    mesh(face,hairLockGeometry([[female?.155:.08,-.35,female?.12:-.122],[female?.154:.08,-.374,female?.125:-.122],[female?.163:.09,-.400,female?.132:-.121]],.020),m.hairLight,[0,0,0],[1,1,1],'braid-tail');
  }
  if(female&&child){const bow=new THREE.Group();bow.position.set(-.151,.064,.065);face.add(bow);for(const side of [-1,1]){const loop=ellipsoid(bow,m.accent,[side*.020,0,0],[.025,.014,.010],'hair-ribbon-loop');loop.rotation.z=side*.22;}ellipsoid(bow,m.tunic,[0,0,.003],[.010,.012,.010],'hair-ribbon-knot');}
  if(c.beard!=='none'){
    const beardMaterial=c.beard==='stubble'?material(blend(c.skinColor,c.hairColor,.34)):m.hair;
    for(const side of [-1,1])ellipsoid(face,beardMaterial,[side*.106,-.103,.064],[.035,.071,.047],'beard-side');
    ellipsoid(face,beardMaterial,[0,c.beard==='short'?-.163:-.149,.061],[.105,c.beard==='short'?.072:.045,.071],'shaped-beard');
    if(c.beard==='short')for(const side of [-1,1]){const mustache=ellipsoid(face,m.hair,[side*.026,-.056,.142],[.035,.012,.013],'mustache');mustache.rotation.z=side*.14;}
  }

  function makeHand(parent,side){
    const hand=new THREE.Group();hand.name=side<0?'right-hand':'left-hand';parent.add(hand);
    hand.scale.setScalar(female?.91:child?.94:1);
    ellipsoid(hand,m.skin,[0,-.047,.005],[.047,.064,.032],'shaped-palm');
    const fingers=[];
    for(let i=0;i<4;i++){
      const finger=new THREE.Group();finger.position.set((i-1.5)*.020,-.087,.007);hand.add(finger);
      mesh(finger,new THREE.CapsuleGeometry(.0105,.028+(i===1?.010:0),3,8),m.skin,[0,-.021,0],[1,1,1],'rounded-finger');finger.rotation.x=.12;fingers.push(finger);
    }
    const thumb=ellipsoid(hand,m.skin,[-side*.048,-.052,.016],[.016,.036,.018],'opposable-thumb');thumb.rotation.z=-side*.48;
    return{group:hand,fingers};
  }
  const arms={};
  for(const side of [-1,1]){
    const upper=new THREE.Group();upper.name=side<0?'right-upper-arm':'left-upper-arm';upper.position.set(side*(female?.208:.223)*build,.329,0);torso.add(upper);
    const sleeveMat=c.preset==='innkeeper'||c.preset==='blacksmith'?m.linen:m.tunic;
    const armWidth=female?.90:child?.94:1;
    mesh(upper,profileGeometry([[-.239,.052,.048],[-.218,.057,.052],[-.16,.067,.058],[-.070,.078,.068],[-.005,.074,.065],[.031,.045,.046]],24),sleeveMat,[0,0,0],[armWidth,1,armWidth],'soft-tailored-sleeve');
    mesh(upper,new THREE.TorusGeometry(.054,.009,8,24),m.accent,[0,-.223,0],[armWidth,1,armWidth*.92],'rolled-sleeve-cuff',[Math.PI/2,0,0]);
    line(upper,[[-.035,-.20,.044],[-.044,-.15,.048],[-.047,-.08,.053]],.0028,c.preset==='innkeeper'||c.preset==='blacksmith'?m.accent:m.clothShade,'sleeve-fold');
    const lower=new THREE.Group();lower.name=side<0?'right-elbow':'left-elbow';lower.position.y=-.25;upper.add(lower);
    mesh(lower,profileGeometry([[-.24,.041,.035],[-.205,.046,.039],[-.09,.057,.049],[.008,.058,.048]],20),m.skin,[0,0,0],[1,1,1],'shaped-forearm');
    if(c.preset==='ranger')mesh(lower,profileGeometry([[-.19,.049,.043],[-.10,.060,.053],[-.045,.061,.054]],20),m.leather,[0,0,0],[1,1,1],'leather-bracer');
    const wrist=new THREE.Group();wrist.name=side<0?'right-wrist':'left-wrist';wrist.position.y=-.24;lower.add(wrist);
    const hand=makeHand(wrist,side);arms[side<0?'right':'left']={upper,lower,end:wrist,l1:.25,l2:.24,hand:hand.group,fingers:hand.fingers,side};
  }
  const legs={};
  for(const side of [-1,1]){
    const upper=new THREE.Group();upper.name=side<0?'right-hip':'left-hip';upper.position.set(side*.103*build,.75,0);body.add(upper);
    mesh(upper,profileGeometry([[-.33,.069,.067],[-.26,.081,.078],[-.12,.092*build,.083],[.018,.089*build,.082]],20),m.pants,[0,0,0],[1,1,1],'shaped-trouser-thigh');
    const lower=new THREE.Group();lower.name=side<0?'right-knee':'left-knee';lower.position.y=-.33;upper.add(lower);
    mesh(lower,profileGeometry([[-.32,.049,.046],[-.24,.055,.052],[-.11,.067,.060],[.015,.069,.067]],20),m.pants,[0,0,0],[1,1,1],'trouser-calf');
    const ankle=new THREE.Group();ankle.name=side<0?'right-ankle':'left-ankle';ankle.position.y=-.32;lower.add(ankle);
    ellipsoid(ankle,m.leatherDark,[0,-.080,.043],[.087,.021,.141],'boot-sole');
    ellipsoid(ankle,m.leather,[0,-.025,.045],[.082,.070,.135],'sculpted-boot-upper');
    mesh(ankle,profileGeometry([[0,.067,.060],[.06,.072,.065],[.15,.066,.060],[.18,.070,.064]],20),m.leather,[0,0,0],[1,1,1],'boot-shaft');
    for(const yy of [.035,.080,.125])line(ankle,[[-.032,yy,.064],[.010,yy+.016,.074],[.032,yy,.064]],.003,m.leatherLight,'boot-lacing');
    legs[side<0?'right':'left']={upper,lower,end:ankle,l1:.33,l2:.32,side};
  }
  // The cup belongs to the right hand throughout the drinking animation.
  const cup=new THREE.Group();cup.name='hand-attached-cup';cup.position.set(.020,-.055,.065);arms.right.hand.add(cup);
  mesh(cup,new THREE.CylinderGeometry(.073,.063,.16,20,1,true),m.cup,[0,0,0],[1,1,1],'tankard-body');
  mesh(cup,new THREE.TorusGeometry(.073,.009,8,20),m.brass,[0,.080,0],[1,1,1],'tankard-rim',[Math.PI/2,0,0]);
  mesh(cup,new THREE.CylinderGeometry(.063,.063,.007,20),m.foam,[0,.066,0],[1,1,1],'tankard-foam');
  mesh(cup,new THREE.TorusGeometry(.045,.012,8,16),m.cup,[.089,-.002,0],[1,1,1],'tankard-handle');
  mesh(cup,new THREE.CylinderGeometry(.065,.065,.012,20),m.brass,[0,-.078,0],[1,1,1],'tankard-base');
  // A soft wrap moves as a complete garment; no front-only apron geometry.
  const garmentSurfaces=[];garment.traverse(object=>{if(object.geometry){const positions=object.geometry.getAttribute('position');garmentSurfaces.push({geometry:object.geometry,rest:positions.array.slice()});}});
  const rig={body,torso,head,eyes,closedMouth,openMouth,arms,legs,cup,garment,garmentSurfaces,scale,build};
  group.userData={kind:'character',config:c,preset:c.preset,rigInfo:{articulated:true,bones:['spine','head','right-upper-arm','right-elbow','right-wrist','left-upper-arm','left-elbow','left-wrist','right-hip','right-knee','right-ankle','left-hip','left-knee','left-ankle'],animations:[...CHARACTER_ANIMATIONS],durations:{...CHARACTER_ANIMATION_DURATIONS}},
    frameBounds:{min:[-.70*scale,-.035*scale,-.70*scale],max:[.70*scale,1.90*scale,.70*scale]},frontage:'+Z',identityStableAcrossPoses:true};
  Object.defineProperty(group.userData,'rig',{value:rig,enumerable:false});Object.defineProperty(group.userData,'ownedTextures',{value:[...ownedTextures],enumerable:false});
  applyCharacterPose(group,c);return group;
}

/** Pose existing joints only: identity, clothing and prop geometry are retained. */
export function applyCharacterPose(group,options={}){
  const rig=group?.userData?.rig;if(!rig)throw new Error('This group is not an articulated Village Foundry character.');
  const current=group.userData.config,pose={};for(const key of ['animation','time','direction','mouth'])if(options[key]!==undefined)pose[key]=options[key];
  const c=normalizeCharacter({...current,...pose}),duration=CHARACTER_ANIMATION_DURATIONS[c.animation],phase=(c.time%duration)/duration,a=phase*TAU;
  group.rotation.y=THREE.MathUtils.degToRad(c.direction);rig.body.position.y=0;rig.torso.rotation.set(0,0,0);rig.head.rotation.set(0,0,0);rig.garment.rotation.set(0,0,0);
  const smooth=x=>{x=clamp(x,0,1);return x*x*(3-2*x);};
  const gesture=smooth(phase/.22)*(1-smooth((phase-.78)/.22));
  for(const limb of [...Object.values(rig.arms),...Object.values(rig.legs)]){limb.upper.rotation.set(0,0,0);limb.lower.rotation.set(0,0,0);limb.end.rotation.set(0,0,0);}
  for(const arm of Object.values(rig.arms)){
    arm.upper.rotation.z=arm.side*.075;arm.lower.rotation.x=-.055;for(const finger of arm.fingers)finger.rotation.x=.12;
  }
  rig.cup.visible=c.animation==='drink';rig.cup.rotation.set(0,0,0);
  let mouthShape=c.mouth;
  if(c.animation==='walk'){
    rig.body.position.y=-.024+.005*Math.cos(a*2);rig.torso.rotation.y=.035*Math.sin(a);rig.head.rotation.y=-.020*Math.sin(a);
    for(const [key,leg]of Object.entries(rig.legs)){
      const p=a+(key==='left'?Math.PI:0),lift=.085*Math.max(0,-Math.sin(p)),z=.16*Math.cos(p),ankleY=.10+lift-rig.body.position.y;
      solveLimb(leg,[leg.side*.103*(c.build==='sturdy'?1.14:c.build==='slim'?.88:1),ankleY,z],[0,0,1]);
      rig.arms[key].upper.rotation.x=.34*Math.cos(p);rig.arms[key].lower.rotation.x=-.13-Math.max(0,-Math.cos(p))*.22;
    }
  }else{
    rig.body.position.y=.005*Math.sin(a);rig.torso.rotation.z=.008*Math.sin(a);rig.head.rotation.x=.012*Math.sin(a+.5);
    for(const leg of Object.values(rig.legs))solveLimb(leg,[leg.upper.position.x,.10-rig.body.position.y,0],[0,0,1]);
    if(c.animation==='talk'){
      rig.head.rotation.y=.06*Math.sin(a);rig.head.rotation.x=.035*Math.sin(a*2);rig.arms.right.upper.rotation.x=-.26-.20*Math.sin(a*2);rig.arms.left.upper.rotation.x=-.18+.12*Math.sin(a*2);
      rig.arms.right.lower.rotation.x=-.95-.20*Math.sin(a*2+.5);rig.arms.left.lower.rotation.x=-.70;
    }else if(c.animation==='drink'){
      const arm=rig.arms.right,start=[arm.upper.position.x,arm.upper.position.y-arm.l1-arm.l2,0],target=[-.020,.590,.145],wrist=start.map((v,i)=>v+(target[i]-v)*gesture);
      solveLimb(arm,wrist,[0,-.3,1]);rig.cup.rotation.x=-.12*gesture;rig.head.rotation.x=-.035*gesture;
      for(const finger of arm.fingers)finger.rotation.x=.60*gesture+.12;
    }else if(c.animation==='point'){
      const arm=rig.arms.right,start=[arm.upper.position.x,arm.upper.position.y-arm.l1-arm.l2,0],target=[-.13,.35,.465];
      const pointHand=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),-Math.PI/2*gesture);
      solveLimb(arm,start.map((v,i)=>v+(target[i]-v)*gesture),[-.3,-1,.2],pointHand);
      arm.fingers[1].rotation.x=.12*(1-gesture);for(const i of [0,2,3])arm.fingers[i].rotation.x=.95*gesture+.12;
      rig.head.rotation.y=-.05*gesture;
    }else if(c.animation==='wave'){
      const arm=rig.arms.right,start=[arm.upper.position.x,arm.upper.position.y-arm.l1-arm.l2,0],target=[-.43,.73,.025];
      const wavingHand=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),gesture*(Math.PI+.35*Math.sin(a*3)));
      solveLimb(arm,start.map((v,i)=>v+(target[i]-v)*gesture),[-1,0,.35],wavingHand);
      for(const finger of arm.fingers)finger.rotation.x=.04;
      rig.head.rotation.z=.035*gesture;
    }
  }
  if(mouthShape==='auto')mouthShape=c.animation==='talk'?(Math.sin(a*3)>.45?'wide':Math.sin(a*3)>-.55?'open':'closed'):'closed';
  rig.closedMouth.visible=mouthShape==='closed';rig.openMouth.visible=mouthShape!=='closed';rig.openMouth.scale.set(mouthShape==='wide'?1.08:1,mouthShape==='wide'?1.75:1,1);
  const blink=.92*Math.exp(-(((phase-.72)/.027)**2));for(const eye of rig.eyes)eye.scale.y=1-blink;
  if(rig.garmentSurfaces.length){
    // Fit a smooth, closed cloth envelope around the posed trousers. Sampling
    // both neighboring rings keeps bent knees inside the skirt between rings.
    group.updateMatrixWorld(true);
    const restRings=skirtProfile(rig.build),rings=restRings.map(([y,rx,rz])=>({y,rx,front:rz,back:rz})),inverse=rig.torso.matrixWorld.clone().invert(),points=[],p=new THREE.Vector3();
    const segment=y=>{let i=0;while(i<rings.length-2&&y>rings[i+1].y)i++;return i;};
    for(const leg of Object.values(rig.legs))leg.upper.traverse(o=>{if(o.name==='shaped-trouser-thigh'||o.name==='trouser-calf'){const transform=new THREE.Matrix4().multiplyMatrices(inverse,o.matrixWorld),v=o.geometry.getAttribute('position');for(let i=0;i<v.count;i++){p.fromBufferAttribute(v,i).applyMatrix4(transform);if(p.y>=rings[0].y&&p.y<=rings.at(-1).y)points.push(p.clone());}}});
    for(const p of points){const i=segment(p.y);for(const j of [i,i+1])rings[j].rx=Math.max(rings[j].rx,Math.abs(p.x)+.014);}
    for(const p of points){const i=segment(p.y),t=(p.y-rings[i].y)/(rings[i+1].y-rings[i].y),rx=rings[i].rx+(rings[i+1].rx-rings[i].rx)*t,required=(Math.abs(p.z)+.013)/Math.sqrt(Math.max(.07,1-(p.x/rx)**2)),side=p.z>=0?'front':'back';for(const j of [i,i+1])rings[j][side]=Math.max(rings[j][side],required);}
    for(const {geometry,rest}of rig.garmentSurfaces){const positions=geometry.getAttribute('position');for(let n=0;n<positions.count;n++){const y=rest[n*3+1],i=segment(y),t=clamp((y-rings[i].y)/(rings[i+1].y-rings[i].y),0,1),lerp=(a,b)=>a+(b-a)*t,rx=lerp(rings[i].rx,rings[i+1].rx),baseX=lerp(restRings[i][1],restRings[i+1][1]),baseZ=lerp(restRings[i][2],restRings[i+1][2]),side=rest[n*3+2]>=0?'front':'back',rz=lerp(rings[i][side],rings[i+1][side]);positions.setX(n,rest[n*3]*rx/baseX);positions.setZ(n,rest[n*3+2]*rz/baseZ);}positions.needsUpdate=true;geometry.computeVertexNormals();geometry.computeBoundingBox();geometry.computeBoundingSphere();}
  }
  group.userData.config=c;group.userData.pose={animation:c.animation,time:c.time,phase,direction:c.direction,mouth:c.mouth,mouthShape};
  group.updateMatrixWorld(true);return group;
}
