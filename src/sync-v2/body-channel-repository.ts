import type {SqlLibrarySessionRepository} from '../sync/library-repository';
import type {BodyChannelRepository} from './body-channel';
import {validateBookPackage,splitBookLines} from '../books/package';
import {utf8Decode} from '../cloud/types';
import {sha256Hex} from '@podjs/framework/crypto';
import {NOTE_IMAGE_LIMIT} from '../notes/cloud-assets';
export type BodyRepository=Pick<SqlLibrarySessionRepository,'cloudNotes'|'cloudNoteAsset'|'mergeCloudNoteAsset'|'cloudBookBody'|'receiveCloudBook'>&Partial<Pick<SqlLibrarySessionRepository,'cloudBookPreview'>>;
export function bodyChannelRepository(repository:BodyRepository):BodyChannelRepository{return {
 async read(kind,id){if(kind==='book'){const preview=await repository.cloudBookPreview?.(id);if(preview&&preview.size>64*1024*1024)throw Error('body_channel_capacity_pending');return repository.cloudBookBody(id);}try{return await repository.cloudNoteAsset(id);}catch(error){if((error as Error).message==='cloud_note_asset_missing')return;throw error;}},
 async validate(kind,id,value,raw){
  if(raw.length>64*1024*1024)throw Error('object_too_large');
  if(kind==='asset'){if(value.assetId!==id||raw.length>NOTE_IMAGE_LIMIT)throw Error('source_identity_missing');return;}
  await validateBookPackage(splitBookLines((async function*(){yield utf8Decode(raw);})()),async b=>sha256Hex(b),{bookId:id,fingerprint:value.fingerprint,chapterCount:value.chapterCount,instanceId:value.instanceId});
 },
 async install(kind,id,raw){if(kind==='book')await repository.receiveCloudBook(id,raw);else await repository.mergeCloudNoteAsset(id,raw);},
};}
