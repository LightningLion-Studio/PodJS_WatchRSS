import type {LegacyBodyArchive} from '../sync-v2/legacy-body';
import type {BinaryAssetFiles} from '../sync/library-binary/assets';
import {noteAssetVersionPath, type NoteAssetFileIndex} from './asset-files';
import {NOTE_IMAGE_LIMIT} from './cloud-assets';

export async function prepareArchivedNoteAsset(index:NoteAssetFileIndex,files:BinaryAssetFiles,key:string,archive:LegacyBodyArchive,check:()=>void){
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(key)||archive.ref.size>NOTE_IMAGE_LIMIT)throw Error('closure_incomplete');
 const {size,sha256}=archive.ref,before=await index.version(key),current=await index.path(key);
 if((await files.stat(current)).file){
  const actual=await files.hash(current);
  if(actual.sha256!==sha256||actual.size!==size)throw Error('note_asset_conflict');
 }
 check();
 const {path}=await files.createTemp('notes/asset-versions');
 try{
  await archive.read(async(part,offset)=>{
   check();
   const written=await files.appendBytes(path,part,offset);
   if(written.size!==offset+part.length)throw Error('storage_error');
  });
  check();
  await files.commit(path,noteAssetVersionPath(key,sha256),size,sha256,null);
  check();
  return index.statements(key,before,{sha256,size});
 }finally{await files.remove(path).catch(()=>{});}
}
