import type {JsonObject} from './protocol.ts';
/** v14 extension; never emitted unless both peers explicitly opt in for MERGE. */
export const LIBRARY_CHECKPOINT_FEATURE='supportsLibraryArticleCheckpoints';
export function wantsLibraryCheckpoint(frames:readonly JsonObject[],index:number):boolean {
 const current=frames[index]!,next=frames[index+1];
 const articles=Array.isArray(current.articles)?current.articles as JsonObject[]:[],following=next&&Array.isArray(next.articles)?next.articles as JsonObject[]:[];
 return !articles.length||!following.length||articles.at(-1)?.articleId!==following[0]?.articleId;
}
export function libraryBatchAck(direction:'phoneToWatch'|'watchToPhone',batchIndex:number,articles:number):JsonObject {
 return {version:14,action:'ack',phase:'libraryBatch',direction,batchIndex,success:true,applied:true,confirmedArticles:articles};
}
export function requireLibraryBatchAck(frame:JsonObject,direction:'phoneToWatch'|'watchToPhone',batchIndex:number):void {
 if(frame.action!=='ack'||frame.phase!=='libraryBatch'||frame.direction!==direction||frame.batchIndex!==batchIndex||frame.success!==true||frame.applied!==true)throw new Error('Invalid library batch acknowledgement');
}
