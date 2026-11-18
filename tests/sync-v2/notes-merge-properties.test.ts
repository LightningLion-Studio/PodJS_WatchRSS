import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'bun:test';
import {mergeNoteMarkdown} from '../../src/sync-v2/business';
import {vector} from './fixture';

test('Sync V2 note merges retain both edits and converge for every shared seed',()=>{
 const {seeds,casesPerSeed,outputSha256}=vector('notes-merge').properties;
 const digest=createHash('sha256');
 const prefixes=['x','z','𐀀','\uE000'];
 for(const seed of seeds){
  let state=seed;
  const next=(limit:number)=>{
   state^=state<<13;
   state^=state>>>17;
   state^=state<<5;
   return (state>>>0)%limit;
  };
  for(let i=0;i<casesPerSeed;i++){
   const label=`seed ${seed}, case ${i}`;
   const base=Array.from({length:1+next(8)},(_,index)=>`b${index}`);
   const edit=(side:string)=>{
    const start=next(base.length+1),removed=next(base.length-start+1);
    const count=removed===0?1+next(3):next(4);
    const prefix=prefixes[next(prefixes.length)];
    const added=Array.from({length:count},(_,index)=>`${prefix}${side}${index}`);
    const end=start+removed;
    return {start,end,added,text:base.slice(0,start).concat(added,base.slice(end)).join('\n')};
   };
   const left=edit('L'),right=edit('R'),ancestor=base.join('\n');
   const result=mergeNoteMarkdown(ancestor,left.text,right.text);
   assert.equal(result,mergeNoteMarkdown(ancestor,right.text,left.text),label);
   const identical=left.text===right.text;
   const overlaps=left.start<right.end&&right.start<left.end;
   assert.equal(result===null,!identical&&overlaps,label);
   if(result!==null){
    const surviving=base.filter((_,index)=>
     (index<left.start||index>=left.end)&&(index<right.start||index>=right.end));
    const expected=surviving.concat(left.added,identical?[]:right.added);
    assert.deepEqual((result===''?[]:result.split('\n')).sort(),expected.sort(),label);
   }
   for(const text of [ancestor,left.text,right.text])digest.update(text+'\0');
   digest.update(result===null?'C\0':'M'+result+'\0');
  }
 }
 assert.equal(digest.digest('hex'),outputSha256);
});
