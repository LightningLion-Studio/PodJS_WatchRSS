import type {PublicationDeadline} from '../cloud/publication-deadline';
import type {FileCheckpoint} from '@podjs/framework/work-window';
export interface BookFileInfo {path:string;size:number;sha256:string}
/** All paths come from this port or locally generated book/hash names. */
export interface BookFiles {
 write(parts:AsyncIterable<string>,maxBytes:number):Promise<BookFileInfo>;
 writeBytes(bytes:Uint8Array,checkpoint?:FileCheckpoint,bookId?:string):Promise<BookFileInfo>;
 publish(info:BookFileInfo,bookId:string,deadline?:PublicationDeadline,repairTargetSha256?:string):Promise<BookFileInfo>;
 /** Adopt a verified, owned native restore output on the same filesystem. */
 adopt?(info:BookFileInfo,bookId:string):Promise<BookFileInfo>;
 stat(path:string):Promise<{exists:boolean;size:number;changeToken?:string}>;
 hash(path:string):Promise<{size:number;sha256:string}>;
 readForInstall?(path:string,offset:number,maxBytes:number):Promise<{size:number;bytes:Uint8Array}>;
 read(path:string,offset:number,maxBytes:number):Promise<{size:number;bytes:Uint8Array}>;
 lines(path:string):AsyncIterable<string>;
 combine(paths:readonly string[],maxBytes:number):Promise<BookFileInfo>;
 remove(path:string):Promise<void>;
}
