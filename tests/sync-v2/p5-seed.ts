import {mkdtempSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {copyImmutableFile,fixtureInputs} from '../helpers/immutable-cache';
import {p5Fixture} from './p5-fixture';
import {noteValue} from './fixture';
const framework=resolve(dirname(realpathSync(resolve(import.meta.dir,'../../node_modules/@podjs/framework/package.json'))),'../..');
/** Only callers that need an already-populated native library use this seed.
 * p5Fixture(), fresh schema, migration and first-publish tests stay uncached. */
export async function populatedNoteFixture(n:number){
 const root=mkdtempSync(join(tmpdir(),'wrss-p5-copy-'));
 await copyImmutableFile(join(root,'state.sqlite'),{kind:'p5-native-seed-v1',n,inputs:fixtureInputs([join(framework,'packages/framework/src')])},async()=>{
  const f=await p5Fixture();try{
   for(let start=1;start<n;start+=32){await f.db.transaction(Array.from({length:Math.min(32,n-start)},(_,k)=>{const v=noteValue('n'+(start+k));return {sql:'INSERT INTO memo_notes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',params:[v.noteId,null,v.title,v.markdown,v.plainText,v.contentHash,v.baseContentHash,v.baseMarkdown,0,1,2,'watch',0,0]};}));}
   return readFileSync(join(f.root,'state.sqlite'));
  }finally{f.close();}
 });
 return p5Fixture({root});
}
