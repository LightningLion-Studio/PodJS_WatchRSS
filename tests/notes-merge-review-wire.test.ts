/** Offline review controls. Supply actual frozen Compose output and the phone JVM jar. */
import {test,expect} from 'bun:test';
import {createRequire} from 'node:module';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encodeNoteCloudState,decodeNoteCloudState} from '../src/notes/cloud-state';

test.skipIf(!process.env.NOTES_MINI_ROOT)('RVM-WIRE mini v1 encoder bytes match the pre-fix encoder',()=>{
 const root=process.env.NOTES_MINI_ROOT!,require=createRequire(root+'/package.json');
 const after=require('./miniprogram/lib/notes-codec');
 const source=execFileSync('git',['-C',root,'show','a622fec8^:miniprogram/lib/notes-codec.js'],{encoding:'utf8'});
 const module={exports:{} as any},localRequire=createRequire(root+'/miniprogram/lib/notes-codec.js');
 new Function('require','module','exports',source)(localRequire,module,module.exports);
 const before=module.exports;
 for(const body of ['a','\0\r\n👨‍👩‍👧‍👦ééאבג\\"','9) nine\n11. eleven  \n# heading']){
  const n={id:'n',folder:null,title:'Manual',markdown:body,hash:after.hash(body),base:body,updatedAt:100,modifiedBy:'compose',pinned:false,deleted:false,deletedAt:0,createdAt:1};
  expect(Buffer.from(after.encode([n]))).toEqual(Buffer.from(before.encode([n])));
  expect(after.decode(after.encode([n]))).toEqual(before.decode(before.encode([n])));
 }
});

test.skipIf(!process.env.NOTES_COMPOSE_DIR||!process.env.NOTES_PHONE_JAR||!process.env.NOTES_PHONE_CLASSPATH||!process.env.NOTES_MINI_ROOT)('RVM-WIRE actual frozen Compose records pass watch, mini and phone codecs',()=>{
 const mini=createRequire(process.env.NOTES_MINI_ROOT!+'/package.json')('./miniprogram/lib/notes-codec');
 const dir=mkdtempSync(join(tmpdir(),'review-compose-wire-'));
 try {for(const name of ['compose-live.json','compose-dead.json']){
  const original=readFileSync(join(process.env.NOTES_COMPOSE_DIR!,name));
  const input=JSON.parse(original.toString()).notes[0];
  const cloud=mini.encode(mini.decode(encodeNoteCloudState(decodeNoteCloudState(original))));
  const file=join(dir,name);writeFileSync(file,cloud);
  const result=spawnSync('java',['-cp',process.env.NOTES_PHONE_JAR+':'+readFileSync(process.env.NOTES_PHONE_CLASSPATH!,'utf8').trim(),'com.lightningstudio.watchrss.phone.HostTestsKt','--wire',file,file],{encoding:'utf8'});
  expect(result.status).toBe(0);
  expect(JSON.parse(readFileSync(file,'utf8')).notes[0]).toEqual(input);
 }}finally{rmSync(dir,{recursive:true,force:true});}
});
