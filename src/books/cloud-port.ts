import type {FileCheckpoint} from '@podjs/framework/work-window';
import type {BookState,BookReading} from './protocol';
import type {BookMapping} from './store';
export interface CloudBookSnapshot {books:BookState[];reading:BookReading[];mappings:BookMapping[]}
export interface CloudBookPort {
 cloudBooks(check?:()=>void):Promise<CloudBookSnapshot>;
 mergeCloudBooks(books:readonly BookState[],reading:readonly BookReading[],check?:()=>void):Promise<number>;
 /** Verified immutable package prefix; body transfer can wait until upload. */
 cloudBookPreview?(id:string):Promise<{prefix:Uint8Array;size:number;sha256:string}|undefined>;
 cloudBookBody(id:string):Promise<Uint8Array|undefined>;
 receiveCloudBook(id:string,bytes:Uint8Array,checkpoint?:FileCheckpoint):Promise<number>;
}
