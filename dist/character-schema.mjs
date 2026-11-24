/** Portable character recipe schema; no Three.js or DOM dependencies. */
export const CHARACTER_ANIMATIONS=Object.freeze(['idle','walk','talk','drink','point','wave']);
export const CHARACTER_ANIMATION_DURATIONS=Object.freeze({idle:3.2,walk:1.0,talk:1.8,drink:3.6,point:3.0,wave:2.4});
export const CHARACTER_DURATIONS=CHARACTER_ANIMATION_DURATIONS;
export const CHARACTER_PRESETS=Object.freeze({
  innkeeper:{label:'The innkeeper',gender:'male',age:'adult',height:1.76,build:'sturdy',hair:'swept',beard:'short',skinColor:'#d6a17c',hairColor:'#68452f',tunicColor:'#824b3e',trouserColor:'#665447',leatherColor:'#795338',accentColor:'#e6d7b7'},
  ranger:{label:'The woodland ranger',gender:'female',age:'adult',height:1.80,build:'slim',hair:'braid',beard:'none',skinColor:'#bc8964',hairColor:'#48382b',tunicColor:'#66714d',trouserColor:'#6c6550',leatherColor:'#775339',accentColor:'#b3a578'},
  villager:{label:'The village craftsperson',gender:'male',age:'adult',height:1.72,build:'average',hair:'bob',beard:'none',skinColor:'#ddb18b',hairColor:'#9c7846',tunicColor:'#70868b',trouserColor:'#705d47',leatherColor:'#8a603f',accentColor:'#c4a26a'},
  blacksmith:{label:'The blacksmith',gender:'male',age:'adult',height:1.83,build:'sturdy',hair:'short',beard:'stubble',skinColor:'#bd8866',hairColor:'#42372f',tunicColor:'#b6b0a0',trouserColor:'#56534d',leatherColor:'#81563b',accentColor:'#b79763'},
  blonde_woman:{label:'Blonde woman',gender:'female',age:'adult',height:1.70,build:'average',hair:'braid',beard:'none',skinColor:'#e0b695',hairColor:'#d9bd73',tunicColor:'#72868b',trouserColor:'#6f6a5c',leatherColor:'#8b6748',accentColor:'#e9ddba'},
  blonde_man:{label:'Blonde man',gender:'male',age:'adult',height:1.81,build:'average',hair:'swept',beard:'none',skinColor:'#d8ad87',hairColor:'#d1b36a',tunicColor:'#607589',trouserColor:'#6c6250',leatherColor:'#846246',accentColor:'#dbcca5'},
  blonde_girl:{label:'Blonde girl',gender:'female',age:'child',height:1.22,build:'slim',hair:'bob',beard:'none',skinColor:'#e5bd9e',hairColor:'#e5cd8a',tunicColor:'#9d7378',trouserColor:'#77735f',leatherColor:'#9a7855',accentColor:'#f0e1bd'},
  blonde_boy:{label:'Blonde boy',gender:'male',age:'child',height:1.28,build:'slim',hair:'swept',beard:'none',skinColor:'#dfb794',hairColor:'#dec27b',tunicColor:'#7a8c70',trouserColor:'#80735d',leatherColor:'#97714c',accentColor:'#e6d6ad'},
});
const number=(v,f)=>Number.isFinite(Number(v))?Number(v):f;
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const hex=(v,f)=>typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v)?v:f;
export function normalizeCharacter(raw={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Character configuration must be an object.');
  const preset=Object.hasOwn(CHARACTER_PRESETS,raw.preset)?raw.preset:'innkeeper',base=CHARACTER_PRESETS[preset];
  const age=['adult','child'].includes(raw.age)?raw.age:base.age;
  const out={preset,label:base.label,seed:number(raw.seed,742)>>>0,height:clamp(number(raw.height,base.height),1.05,2),
    gender:['female','male'].includes(raw.gender)?raw.gender:base.gender,age,
    build:['slim','average','sturdy'].includes(raw.build)?raw.build:base.build,hair:['short','swept','bob','braid'].includes(raw.hair)?raw.hair:base.hair,
    beard:age==='child'?'none':['none','stubble','short'].includes(raw.beard)?raw.beard:base.beard,animation:CHARACTER_ANIMATIONS.includes(raw.animation)?raw.animation:'idle',
    time:clamp(number(raw.time,0),0,3600),direction:((number(raw.direction,0)%360)+360)%360,mouth:['auto','closed','open','wide'].includes(raw.mouth)?raw.mouth:'auto',schemaVersion:2};
  // Color overrides are identity data, including explicitly selected blonde hair.
  for(const key of ['skinColor','hairColor','tunicColor','trouserColor','leatherColor','accentColor'])out[key]=hex(raw[key],base[key]);
  return out;
}
