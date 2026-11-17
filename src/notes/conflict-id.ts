/** UTF-16 code-unit lengths match Kotlin String.length; old IDs stay opaque. */
import {sha256Hex} from '@podjs/framework/crypto';
import {utf8Encode} from '../cloud/types';
export const noteConflictId=(noteId:string,base:string,local:string,remote:string,device:string)=>
 sha256Hex(utf8Encode('notes-conflict-v2:'+ [noteId,base,local,remote,device].map(s=>s.length+':'+s).join('')));
