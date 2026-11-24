/** Reproducible example assets from the same rig and renderer used by the app. */
import {createRequire} from 'node:module';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {buildCharacter,applyCharacterPose} from '../dist/character-model.mjs';
import {normalizeCharacter,CHARACTER_PRESETS,CHARACTER_ANIMATIONS} from '../dist/character-schema.mjs';
import {HouseRenderer} from '../dist/renderer.mjs';
import {disposeHouse} from '../dist/house-model.mjs';
import {renderAnimationSheet} from '../dist/animation-export.mjs';
import {zipBlobs} from '../dist/zip.mjs';

const require=createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'probe.js'):import.meta.url);
const {createCanvas}=require('@napi-rs/canvas');
globalThis.document={createElement:()=>createCanvas(1,1)};
const out=resolve(process.argv[2]||'qa/characters');
await mkdir(out,{recursive:true});
const renderer=new HouseRenderer(createCanvas(1,1)),entries=[],assets=[];
const view={elevation:45,azimuth:0};
const write=async(name,bytes)=>{const path=join(out,name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,bytes);entries.push({name,blob:new Blob([bytes])});};
const json=async(name,value)=>write(name,JSON.stringify(value,null,2));
const recipe=(config,output)=>({format:'village-foundry-character',version:1,config,view,output});

for(const preset of Object.keys(CHARACTER_PRESETS)){
  const config=normalizeCharacter({preset,seed:742}),group=buildCharacter(config);
  renderer.setHouse(group);
  const output={resolution:512,scale:1,pixelated:false,outline:true,shadow:true,sizeMode:'auto'};
  for(const direction of [0,90,180,270]){
    applyCharacterPose(group,{...config,direction});
    const canvas=renderer.render({...view,...output,fixedBounds:true,trim:false},{previewGround:false});
    const file=`references/${preset}/direction-${direction}.png`;
    await write(file,canvas.toBuffer('image/png'));assets.push({file,preset,direction,...renderer.lastMeta});
  }
  for(const mouth of ['closed','open','wide']){
    applyCharacterPose(group,{...config,mouth,direction:0});
    const canvas=renderer.render({...view,...output,fixedBounds:true,trim:false},{previewGround:false});
    await write(`references/${preset}/mouth-${mouth}.png`,canvas.toBuffer('image/png'));
  }
  await json(`references/${preset}/recipe.json`,recipe(config,output));
  renderer.setHouse(null);disposeHouse(group);
}
const config=normalizeCharacter({preset:'innkeeper',seed:742}),group=buildCharacter(config);
renderer.setHouse(group);
for(const style of ['illustrated','pixel']){
  const output={resolution:style==='pixel'?256:384,scale:style==='pixel'?2:1,pixelated:style==='pixel',outline:true,shadow:true,sizeMode:'auto'};
  for(const animation of CHARACTER_ANIMATIONS){
    const rendered=await renderAnimationSheet(renderer,group,config,{...view,...output},{animation,frames:16,directions:4});
    const file=`animations/${style}/${animation}.png`;
    await write(file,rendered.canvas.toBuffer('image/png'));
    await json(`animations/${style}/${animation}.json`,rendered.metadata);
    await json(`animations/${style}/${animation}-recipe.json`,recipe({...config,animation},output));
    assets.push({file,style,animation,frames:64,cellWidth:rendered.metadata.cellWidth,cellHeight:rendered.metadata.cellHeight,anchor_px:rendered.metadata.anchor_px});
    console.log(JSON.stringify({style,animation,frames:64,width:rendered.canvas.width,height:rendered.canvas.height}));
  }
}
renderer.setHouse(null);disposeHouse(group);renderer.dispose();
await json('manifest.json',{format:'village-foundry-character-examples',version:1,seed:742,assets,
  notes:'Actual procedural rig renders. Each animation sheet has 16 time samples per row and 4 directional rows (0,90,180,270 degrees). Use the per-sheet cell coordinates, cycle duration and anchor metadata. PNGs retain alpha; recipes load in Village Foundry MCP.'});
const zip=await zipBlobs(entries),archive=join(out,'village-foundry-character-examples.zip');
await writeFile(archive,new Uint8Array(await zip.arrayBuffer()));
console.log(JSON.stringify({archive,bytes:zip.size,entries:entries.length,animationFrames:768}));
