/** Offline chain: phone JVM -> watch codec -> mini codec -> opaque cloud bytes -> phone.
 * No editor, BLE, HTTP, device or real server is involved. */
import {test,expect} from 'bun:test';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=process.env.NOTES_SOURCE_ROOT??new URL('../',import.meta.url).pathname;
const {encodeNoteCloudState,decodeNoteCloudState}=await import(root+'/src/notes/cloud-state');
const {encodeNote,assembleSegments,parentState,segmentState,checkSegmentedParent}=await import(root+'/src/sync-v2/note-segments');
const require=createRequire(import.meta.url);
const mini=process.env.NOTES_MINI_ROOT?require(process.env.NOTES_MINI_ROOT+'/miniprogram/lib/notes-codec.js'):null;
const corpus=process.env.NOTES_CORPUS!;
const manifest=corpus?JSON.parse(readFileSync(join(corpus,'manifest.json'),'utf8')):null;
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
test.skipIf(!mini||!manifest||!process.env.NOTES_PHONE_JAR||!process.env.NOTES_PHONE_CLASSPATH)('NA-CONTROL six complete codec cycles retain corpus body/title/base scalar values',()=>{
 const dir=mkdtempSync(join(tmpdir(),'notes-adversarial-wire-'));
 try{
  const notes=manifest.entries.filter((e:any)=>e.file.endsWith('.txt')).map((e:any,i:number)=>{const raw=readFileSync(join(corpus,e.file));expect(hash(raw)).toBe(e.sha256);const markdown=raw.toString('utf8');return {id:'n'+i,folder:null,title:e.file,markdown,hash:hash(raw),base:markdown,updatedAt:100,modifiedBy:'fixture',pinned:false,deleted:false,deletedAt:0,createdAt:100};});
  const path=join(dir,'state.json');writeFileSync(path,JSON.stringify({format:'watchrss-notes',version:1,notes}));
  const phone=()=>{const result=spawnSync('java',['-cp',process.env.NOTES_PHONE_JAR+':'+readFileSync(process.env.NOTES_PHONE_CLASSPATH!,'utf8').trim(),'com.lightningstudio.watchrss.phone.HostTestsKt','--wire',path,path],{encoding:'utf8'});if(result.status!==0)throw Error('phone adapter failed: '+result.stderr);};
  for(let round=0;round<6;round++){
   phone();const watch=encodeNoteCloudState(decodeNoteCloudState(readFileSync(path)));const cloudOpaque=mini.encode(mini.decode(watch));writeFileSync(path,cloudOpaque);phone();
   const actual=JSON.parse(readFileSync(path,'utf8')).notes;
   for(const n of notes){const r=actual.find((v:any)=>v.id===n.id);expect(r.markdown).toBe(n.markdown);expect(r.base).toBe(n.base);expect(r.title).toBe(n.title);}
  }
  console.log('six codec cycles:',notes.length,'corpus inputs; all semantic body/base/title strings retained');
 }finally{rmSync(dir,{recursive:true,force:true});}
},120000);
test('NA-CONTROL greedy note segments preserve emoji and JSON escapes at hostile boundaries',()=>{
 for(const offset of [8191,65535,245759,245760,262143]){
  const body='x'.repeat(offset)+'😀👨‍👩‍👧‍👦\\"\u0000\r\n\u2028\u2029éאבג'+'z'.repeat(270000-offset);
  const input={entityKey:'0'.repeat(64),features:[],metadata:{title:'Manual'},fields:{markdown:body}};
  const values:any[]=[],revision='1'.repeat(32),ids:string[]=[];
  const encoded=encodeNote(input,revision,(i:number,text:string)=>{expect([...text].every(ch=>{const cp=ch.codePointAt(0)!;return cp<0xd800||cp>0xdfff;})).toBe(true);values.push(segmentState(input.entityKey,revision,i,text));ids.push('state:sha256:'+i.toString(16).padStart(64,'0'));});
  expect(encoded.form).toBe('segmented');const parent=parentState(input,revision,values.length,encoded.plaintextSha256,ids);checkSegmentedParent(parent);
  expect(assembleSegments(parent,values).payload.markdown).toBe(body);
 }
});
test('NA-CONTROL unpaired UTF-16 is rejected by v2 note encoder',()=>{
 expect(()=>encodeNote({entityKey:'0'.repeat(64),features:[],metadata:{title:'\ud83d'},fields:{markdown:'x'.repeat(270000)}},'1'.repeat(32),()=>{})).toThrow();
});
