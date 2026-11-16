import {test,expect} from 'bun:test';
import {createRequire} from 'node:module';
import {sha256Hex} from '@podjs/framework/crypto';
import {utf8Encode} from '../src/cloud/types';
import {mergeNoteMarkdown} from '../src/notes/merge';
import {newConflictId,mergeConflicts,conflictSet} from '../src/sync-v2/notes-conflict';
const hash=(s:string)=>sha256Hex(utf8Encode(s));

test('NA-16 aliases preserve legacy ID and merge resolved marker in either order',()=>{
 const tuple=['n','a','x\0y','z😀','peer'];
 const old=hash(tuple.join('\0')),fresh=newConflictId(...tuple as [string,string,string,string,string]);
 const row={conflictId:old,noteId:tuple[0],baseMarkdown:tuple[1],localMarkdown:tuple[2],remoteMarkdown:tuple[3],remoteDeviceId:tuple[4],createdAt:2,resolvedAt:0};
 const a=conflictSet('n',[row]),b=conflictSet('n',[{...row,conflictId:fresh,createdAt:1,resolvedAt:10}]);
 const merged=mergeConflicts('n',a,b);
 expect(merged).toEqual(mergeConflicts('n',b,a));expect(merged.records).toEqual([{...row,createdAt:1,resolvedAt:10}]);
 expect(mergeConflicts('n',merged,b)).toEqual(merged);
 expect(()=>mergeConflicts('n',a,conflictSet('n',[{...row,remoteMarkdown:'other'}]))).toThrow('conflict_identity_mismatch');
 expect(newConflictId('n','a','x\0y','z','peer')).not.toBe(newConflictId('n','a','x','y\0z','peer'));
});

test.skipIf(!process.env.NOTES_MINI_ROOT)('NA-02 watch and mini merge identically under argument swaps over hostile line edits',()=>{
 const require=createRequire(import.meta.url);
 const mini=require(process.env.NOTES_MINI_ROOT+'/miniprogram/lib/notes-codec');
 const texts=['','a','b','x\na','y\na','a\nx','a\ny','A\nb','a\nB','a\nb','x\0y','😀'];
 for(const base of texts)for(const local of texts)for(const remote of texts){
  const result=mergeNoteMarkdown(base,local,remote);
  expect(result).toBe(mergeNoteMarkdown(base,remote,local));
  expect(mini.merge(base,local,remote)).toEqual(result===null?{conflict:true}:{markdown:result});
 }
 expect(mergeNoteMarkdown('a\nb','A\nb','a\nB')).toBe('A\nB');
 for(const tuple of [['n','a','x\0y','z','peer'],['😀','a:b','x','\0z','']])expect(newConflictId(...tuple as [string,string,string,string,string])).toBe(mini.conflictId(...tuple));
});


test.skipIf(!process.env.NOTES_PHONE_MATRIX||!process.env.NOTES_MINI_ROOT)('three actual clients agree on 1728 merge cases and UTF-16 conflict ID vectors',async()=>{
 const {readFileSync}=await import('node:fs');
 const matrix=JSON.parse(readFileSync(process.env.NOTES_PHONE_MATRIX!,'utf8'));
 const mini=createRequire(import.meta.url)(process.env.NOTES_MINI_ROOT+'/miniprogram/lib/notes-codec');
 expect(matrix.cases).toHaveLength(1728);
 for(const [base,local,remote,expected] of matrix.cases){
  expect(mergeNoteMarkdown(base,local,remote)).toBe(expected);
  const result=mini.merge(base,local,remote);expect(result.conflict?null:result.markdown).toBe(expected);
 }
 for(const [id,base,local,remote,device,expected] of matrix.identities){expect(newConflictId(id,base,local,remote,device)).toBe(expected);expect(mini.conflictId(id,base,local,remote,device)).toBe(expected);}
});
