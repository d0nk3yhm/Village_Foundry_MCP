#!/usr/bin/env node
/**
 * Package the portable source project with Node built-ins only.
 * A strict include list omits hosting identities, installed dependencies,
 * generated Worker bundles, local workspaces, and Godot/editor caches.
 */
import {createReadStream, constants} from 'node:fs';
import {lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {basename, dirname, extname, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateRawSync, inflateRawSync} from 'node:zlib';

export const ARCHIVE_FOLDER = 'village-foundry-mcp';
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOP_FILES = ['README.md', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.gitignore', '.gitattributes', 'LICENSE', 'LICENSE.md', 'NOTICE', 'start-local.cmd', 'start-local.command'];
const SOURCE_TREES = ['dist', 'src', 'scripts', 'tests', 'docs/media', 'examples/godot'];
const REQUIRED_FILES = ['README.md', 'package.json', '.gitignore', 'start-local.cmd', 'start-local.command',
  'dist/index.html', 'dist/app.js', 'dist/vendor/three.module.js', 'dist/vendor/three.core.js', 'dist/vendor/THREE_LICENSE.txt',
  'src/worker.mjs', 'scripts/local-server.mjs', 'scripts/local-storage.mjs', 'examples/godot/project.godot'];
const PRIVATE_DIRS = new Set(['.git', '.openai', '.godot', '.cache', '.venv', '.village-foundry', 'node_modules', '__pycache__', 'qa', 'local-data', 'private', 'storage', 'logs', 'artifacts', 'release', 'deliverables', 'generated', 'coverage', 'tmp', 'temp']);
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const ZIP32_MAX = 0xffffffff;
const ZIP_UTF8 = 0x0800;
const DOS_DATE = 33; // 1980-01-01; reproducible timestamps, not machine metadata.
const MANIFEST_NAME = `${ARCHIVE_FOLDER}/SOURCE_MANIFEST.json`;
const crcTable = Uint32Array.from({length:256}, (_, n) => {
  let value=n; for(let i=0;i<8;i++)value=value&1?0xedb88320^(value>>>1):value>>>1; return value>>>0;
});
export function crc32(bytes) { let value=0xffffffff; for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8); return(value^0xffffffff)>>>0; }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function fileHash(path) { const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex'); }
const portablePath = path => path.split(sep).join('/');
const compareNames = (a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b));
function zip32(value,label) { if(!Number.isSafeInteger(value)||value<0||value>=ZIP32_MAX)throw new Error(`${label} exceeds this ZIP32 packager's limit.`); }
function safeName(name) {
  if(typeof name!=='string'||name.startsWith('/')||name.includes('\\')||/[\x00-\x1f\x7f<>:"|?*]/.test(name))throw new Error(`Non-portable archive path: ${name}`);
  const parts=name.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw new Error(`Non-portable archive path: ${name}`);
  if(Buffer.byteLength(name)>65535)throw new Error('An archive path is too long.');return name;
}
function excluded(path) {
  const parts=path.split('/'),file=parts.at(-1),lower=parts.map(p=>p.toLowerCase());
  if(path==='dist/server'||path.startsWith('dist/server/'))return 'generated Worker bundle';
  if(lower.some(p=>PRIVATE_DIRS.has(p)))return 'private, installed, or generated directory';
  if(parts.some(p=>p.startsWith('.')&&!['.gitignore','.gitattributes'].includes(p)))return 'private/editor metadata';
  if(file==='server.lock'||/\/(?:objects)\/[a-f0-9]{64}\.json$/i.test('/'+path))return 'local scene storage';
  if(/^(?:thumbs\.db|desktop\.ini|\.ds_store|sites\.local\.json|id_rsa|id_ed25519)$/i.test(file))return 'OS metadata or credentials';
  if(/(?:^|[-_.])(?:credentials?|secrets?|tokens?|service[-_]account)(?:[-_.][^.]+)*\.(?:json|ya?ml|toml|txt|ini)$/i.test(file))return 'credential file';
  if(/\.(?:zip|7z|tar|gz|log|sqlite(?:3)?|db|pem|key|p12|pfx|pyc|bak|tmp)$/i.test(file)||file.endsWith('~'))return 'archive, local data, or temporary file';
  return null;
}

/** Return only portable source entries; absolute source paths never enter the manifest. */
export async function collectProject(root=DEFAULT_ROOT,{excludePaths=[]}={}) {
  root=await realpath(root);const files=[],skipped={},seen=new Map(),excludedAbsolute=new Set(excludePaths.map(p=>resolve(p)));let bytes=0;
  const skip=reason=>{skipped[reason]=(skipped[reason]||0)+1;};
  async function visit(path) {
    const rel=portablePath(relative(root,path)),reason=excluded(rel);
    if(reason){skip(reason);return;}
    if(excludedAbsolute.has(path)){skip('output artifact');return;}
    const info=await lstat(path);
    if(info.isSymbolicLink()){skip('symbolic link');return;}
    if(info.isDirectory()){
      const children=await readdir(path);children.sort(compareNames);for(const child of children)await visit(resolve(path,child));return;
    }
    if(!info.isFile()){skip('non-regular file');return;}
    const name=safeName(`${ARCHIVE_FOLDER}/${rel}`),caseKey=name.normalize('NFC').toLowerCase();
    if(seen.has(caseKey))throw new Error(`Archive paths collide on a case-insensitive filesystem: ${seen.get(caseKey)} and ${name}`);
    seen.set(caseKey,name);
    if(info.size>MAX_FILE_BYTES)throw new Error(`Unexpectedly large source file: ${rel}. Inspect it before packaging.`);
    bytes+=info.size;if(bytes>MAX_TOTAL_BYTES)throw new Error('The source package exceeds 1 GiB. Inspect generated files before packaging.');
    const mode=(rel==='start-local.command'||(info.mode&0o111))?'0755':'0644';
    files.push({path:rel,archivePath:name,bytes:info.size,sha256:await fileHash(path),mode,sourcePath:path});
  }
  for(const name of [...TOP_FILES,...SOURCE_TREES]){
    const path=resolve(root,name);try{await lstat(path);}catch(error){if(error.code==='ENOENT')continue;throw error;}await visit(path);
  }
  files.sort((a,b)=>compareNames(a.archivePath,b.archivePath));
  const included=new Set(files.map(file=>file.path)),missing=REQUIRED_FILES.filter(path=>!included.has(path));
  if(missing.length)throw new Error(`The portable project is incomplete. Missing required files: ${missing.join(', ')}`);
  if(files.length+1>=65535)throw new Error('This packager supports fewer than 65,535 ZIP entries.');
  return{root,files,sourceBytes:bytes,excludedSummary:skipped};
}
function localHeader(entry) {
  const b=Buffer.alloc(30+entry.nameBytes.length);b.writeUInt32LE(0x04034b50,0);b.writeUInt16LE(20,4);b.writeUInt16LE(ZIP_UTF8,6);b.writeUInt16LE(entry.method,8);b.writeUInt16LE(DOS_DATE,12);b.writeUInt32LE(entry.crc,14);b.writeUInt32LE(entry.compressedBytes,18);b.writeUInt32LE(entry.bytes,22);b.writeUInt16LE(entry.nameBytes.length,26);entry.nameBytes.copy(b,30);return b;
}
function centralHeader(entry) {
  const b=Buffer.alloc(46+entry.nameBytes.length);b.writeUInt32LE(0x02014b50,0);b.writeUInt16LE((3<<8)|20,4);b.writeUInt16LE(20,6);b.writeUInt16LE(ZIP_UTF8,8);b.writeUInt16LE(entry.method,10);b.writeUInt16LE(DOS_DATE,14);b.writeUInt32LE(entry.crc,16);b.writeUInt32LE(entry.compressedBytes,20);b.writeUInt32LE(entry.bytes,24);b.writeUInt16LE(entry.nameBytes.length,28);b.writeUInt32LE(((0o100000|parseInt(entry.mode,8))<<16)>>>0,38);b.writeUInt32LE(entry.offset,42);entry.nameBytes.copy(b,46);return b;
}
async function writeAll(handle,bytes) { let offset=0;while(offset<bytes.length){const result=await handle.write(bytes,offset,bytes.length-offset);if(!result.bytesWritten)throw new Error('Archive write made no progress.');offset+=result.bytesWritten;} }
async function writeZip(path,files,manifestBytes) {
  const handle=await open(path,'wx'),entries=[];let offset=0;
  try{
    for(const file of [...files,{archivePath:MANIFEST_NAME,bytes:manifestBytes.length,sha256:sha256(manifestBytes),mode:'0644',inline:manifestBytes}]){
      let bytes;
      if(file.inline)bytes=file.inline;
      else{
        // A frozen source snapshot is required; detect edits between inventory and write.
        const source=await open(file.sourcePath,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
        try{bytes=await source.readFile();}finally{await source.close();}
        if(bytes.length!==file.bytes||sha256(bytes)!==file.sha256)throw new Error(`Source changed while packaging: ${file.path}. Freeze edits and run again.`);
      }
      const deflated=bytes.length>=64?deflateRawSync(bytes,{level:9}):bytes,compress=deflated.length<bytes.length,payload=compress?deflated:bytes;
      const entry={...file,nameBytes:Buffer.from(file.archivePath),offset,crc:crc32(bytes),method:compress?8:0,compressedBytes:payload.length};
      const header=localHeader(entry);zip32(offset+header.length+payload.length,'Archive size');await writeAll(handle,header);await writeAll(handle,payload);offset+=header.length+payload.length;entries.push(entry);
    }
    const centralOffset=offset;for(const entry of entries){const header=centralHeader(entry);await writeAll(handle,header);offset+=header.length;}
    const centralSize=offset-centralOffset;zip32(offset+22,'Archive size');const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(centralOffset,16);await writeAll(handle,end);await handle.sync();return entries;
  }finally{await handle.close();}
}
async function readExactly(handle,position,length) { const b=Buffer.alloc(length);let offset=0;while(offset<length){const read=await handle.read(b,offset,length-offset,position+offset);if(!read.bytesRead)throw new Error('Truncated ZIP archive.');offset+=read.bytesRead;}return b; }

/** Read the written ZIP independently, inflate entries, and verify CRC, hashes and Unix modes. */
export async function verifyArchive(path,expected=null) {
  const handle=await open(path,'r'),file=await handle.stat(),entries=[],names=new Set();let sourceManifest=null;
  try{
    if(file.size<22)throw new Error('ZIP archive is too short.');const end=await readExactly(handle,file.size-22,22);
    if(end.readUInt32LE(0)!==0x06054b50||end.readUInt16LE(20)!==0||end.readUInt16LE(4)!==0||end.readUInt16LE(6)!==0)throw new Error('Invalid ZIP end record.');
    const count=end.readUInt16LE(10),centralBytes=end.readUInt32LE(12),centralOffset=end.readUInt32LE(16);if(count!==end.readUInt16LE(8)||centralOffset+centralBytes!==file.size-22)throw new Error('Invalid ZIP directory size.');
    let position=centralOffset,localEnd=0;
    for(let n=0;n<count;n++){
      const h=await readExactly(handle,position,46);if(h.readUInt32LE(0)!==0x02014b50)throw new Error('Invalid ZIP directory entry.');
      const nameLength=h.readUInt16LE(28),extraLength=h.readUInt16LE(30),commentLength=h.readUInt16LE(32),name=(await readExactly(handle,position+46,nameLength)).toString('utf8');safeName(name);
      if(!name.startsWith(`${ARCHIVE_FOLDER}/`)||names.has(name.normalize('NFC').toLowerCase()))throw new Error('Unsafe or duplicate ZIP entry.');names.add(name.normalize('NFC').toLowerCase());
      const method=h.readUInt16LE(10),compressedBytes=h.readUInt32LE(20),bytes=h.readUInt32LE(24),crc=h.readUInt32LE(16),offset=h.readUInt32LE(42),mode=((h.readUInt32LE(38)>>>16)&0o777).toString(8).padStart(4,'0');
      if(h.readUInt16LE(4)>>8!==3||h.readUInt16LE(8)!==ZIP_UTF8||![0,8].includes(method)||bytes>MAX_FILE_BYTES||compressedBytes>MAX_FILE_BYTES||offset!==localEnd)throw new Error(`Unsupported or overlapping ZIP entry: ${name}`);
      const local=await readExactly(handle,offset,30);if(local.readUInt32LE(0)!==0x04034b50||local.readUInt16LE(6)!==ZIP_UTF8||local.readUInt16LE(8)!==method||local.readUInt32LE(14)!==crc||local.readUInt32LE(18)!==compressedBytes||local.readUInt32LE(22)!==bytes)throw new Error(`ZIP headers disagree: ${name}`);
      const localNameLength=local.readUInt16LE(26),localExtraLength=local.readUInt16LE(28),localName=(await readExactly(handle,offset+30,localNameLength)).toString('utf8');if(localName!==name)throw new Error('ZIP entry names disagree.');
      const dataOffset=offset+30+localNameLength+localExtraLength;localEnd=dataOffset+compressedBytes;if(localEnd>centralOffset)throw new Error('ZIP payload overlaps its directory.');
      const payload=await readExactly(handle,dataOffset,compressedBytes),data=method===8?inflateRawSync(payload,{maxOutputLength:Math.max(1,bytes)}):payload;
      if(data.length!==bytes||crc32(data)!==crc)throw new Error(`ZIP content checksum mismatch: ${name}`);
      const entry={archivePath:name,bytes,sha256:sha256(data),mode};entries.push(entry);if(name===MANIFEST_NAME)sourceManifest=JSON.parse(data.toString('utf8'));
      position+=46+nameLength+extraLength+commentLength;
    }
    if(position!==file.size-22||localEnd!==centralOffset)throw new Error('ZIP contains unexpected trailing or hidden content.');
    const expectedEntries=expected||sourceManifest?.files;if(!Array.isArray(expectedEntries))throw new Error('ZIP source manifest is missing.');
    const actual=new Map(entries.map(entry=>[entry.archivePath,entry]));
    if(actual.size!==expectedEntries.length+(expected?0:1))throw new Error('ZIP entry count does not match its source manifest.');
    for(const e of expectedEntries){const a=actual.get(e.archivePath);if(!a||a.bytes!==e.bytes||a.sha256!==e.sha256||a.mode!==e.mode)throw new Error(`ZIP integrity check failed: ${e.archivePath}`);}
    if(actual.get(`${ARCHIVE_FOLDER}/start-local.command`)?.mode!=='0755')throw new Error('macOS launcher executable mode was not preserved.');
    return{verified:true,entries:entries.length,bytes:file.size,sha256:await fileHash(path),sourceFiles:sourceManifest?.files?.length??entries.length-1};
  }finally{await handle.close();}
}

export async function packageProject({root=DEFAULT_ROOT,output,manifest,dryRun=false}={}) {
  root=await realpath(root);output=resolve(output||resolve(root,'artifacts','village-foundry-mcp-project.zip'));manifest=resolve(manifest||output.replace(/\.zip$/i,'')+'.manifest.json');
  if(extname(output).toLowerCase()!=='.zip')throw new Error('--output must end in .zip.');if(extname(manifest).toLowerCase()!=='.json'||manifest===output)throw new Error('--manifest must be a separate .json file.');
  for(const destination of [output,manifest]){const rel=portablePath(relative(root,destination)),included=TOP_FILES.includes(rel)||SOURCE_TREES.some(tree=>rel===tree||rel.startsWith(tree+'/'));if(included&&!excluded(rel))throw new Error('Choose an output path outside the packaged source files, such as artifacts/.');}
  const inventory=await collectProject(root,{excludePaths:[output,manifest]});
  const files=inventory.files.map(({path,archivePath,bytes,sha256,mode})=>({path,archivePath,bytes,sha256,mode}));
  const packageInfo=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
  const sourceManifest={format:'village-foundry-source-package',version:1,project:{name:packageInfo.name,version:packageInfo.version},archiveFolder:ARCHIVE_FOLDER,sourceBytes:inventory.sourceBytes,fileCount:files.length,
    scope:'Source entries only; this generated manifest does not hash itself.',includeRoots:[...TOP_FILES,...SOURCE_TREES],excludedSummary:inventory.excludedSummary,files};
  if(dryRun)return{dryRun:true,output,manifest,...sourceManifest};
  for(const file of inventory.files)if(file.sourcePath===output||file.sourcePath===manifest)throw new Error('An output path would overwrite a source file.');
  await mkdir(dirname(output),{recursive:true});await mkdir(dirname(manifest),{recursive:true});
  const temporary=`${output}.${randomUUID()}.tmp`,manifestTemp=`${manifest}.${randomUUID()}.tmp`;
  try{
    const content=Buffer.from(JSON.stringify(sourceManifest,null,2)+'\n'),written=await writeZip(temporary,inventory.files,content),check=await verifyArchive(temporary,written);
    const result={...sourceManifest,archive:{filename:basename(output),...check}};
    await writeFile(manifestTemp,JSON.stringify(result,null,2)+'\n',{flag:'wx'});await rename(temporary,output);await rename(manifestTemp,manifest);
    return{output,manifest,...check,sourceBytes:inventory.sourceBytes};
  }finally{await rm(temporary,{force:true});await rm(manifestTemp,{force:true});}
}
export function parseArguments(argv=process.argv.slice(2)) {
  const out={};for(let i=0;i<argv.length;i++){const flag=argv[i];if(flag==='--help'||flag==='-h'){out.help=true;continue;}if(flag==='--dry-run'){out.dryRun=true;continue;}if(!['--output','--manifest','--root','--verify'].includes(flag)||!argv[i+1])throw new Error(`Unknown or incomplete argument: ${flag}`);out[flag.slice(2)]=resolve(argv[++i]);}return out;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const options=parseArguments();
    if(options.help)console.log('Village Foundry portable source ZIP\n\nnode scripts/package-project.mjs [--output PATH.zip] [--manifest PATH.json] [--dry-run]\nnode scripts/package-project.mjs --verify PATH.zip\n\nDefault: artifacts/village-foundry-mcp-project.zip and a sibling .manifest.json.\n--dry-run prints the complete source inventory and hashes without writing an archive.\n--root PATH is available for isolated fixtures. Archives contain village-foundry-mcp/.\nUses Node built-ins only; no npm install, hosted credentials, or git command is required.');
    else console.log(JSON.stringify(options.verify?await verifyArchive(options.verify):await packageProject(options),null,2));
  }catch(error){console.error(`Project packaging failed: ${error.message}`);process.exitCode=1;}
}
