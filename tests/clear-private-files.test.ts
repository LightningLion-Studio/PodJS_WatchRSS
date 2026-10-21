import {expect,test} from 'bun:test';
import {clearPrivateContentFiles} from '../src/core/clear-private-files';
test('private cleanup rejects traversal and files that remain after removal',async()=>{
 for(const path of ['../credentials','notes/../credentials','notes/nested/file','notes/..']){
  const removed:string[]=[];await expect(clearPrivateContentFiles({list:async root=>({entries:root==='notes'?[{path,file:true,directory:false}]:[]}),remove:async p=>{removed.push(p);},stat:async()=>({exists:false})})).rejects.toThrow('private_library_invalid_path');expect(removed).toEqual([]);
 }
 await expect(clearPrivateContentFiles({list:async root=>({entries:root==='notes'?[{path:'notes/private.txt',file:true,directory:false}]:[]}),remove:async()=>{},stat:async()=>({exists:true})})).rejects.toThrow('private_library_file_remains');
});
