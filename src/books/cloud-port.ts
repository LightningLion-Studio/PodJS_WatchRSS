import type {BookState,BookReading} from './protocol';
import type {BookMapping} from './store';
export interface CloudBookSnapshot {books:BookState[];reading:BookReading[];mappings:BookMapping[]}
export interface CloudBookPort {
 cloudBooks():Promise<CloudBookSnapshot>;
 mergeCloudBooks(books:readonly BookState[],reading:readonly BookReading[]):Promise<number>;
 cloudBookBody(id:string):Promise<Uint8Array|undefined>;
 receiveCloudBook(id:string,bytes:Uint8Array):Promise<number>;
}
