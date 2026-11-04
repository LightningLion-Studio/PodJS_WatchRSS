import type {CloudHostRequest} from './host-ports';
/** Bounded legacy reads shared by the full runtime and lightweight handoff.
 * A changed snapshot restarts at zero; never join pages from two values. */
export async function readCloudSecure(request:CloudHostRequest,key:string):Promise<string|undefined>{
 for(let retry=0;retry<3;retry++){
  let offset=0,total:number|undefined,version:number|undefined;const parts:string[]=[];
  for(;;){
   const r=await request<{exists:boolean;changed?:boolean;value?:string;totalChars?:number;offset?:number;version?:number}>('secure.get',{key,offset,maxChars:16384,...(version===undefined?{}:{version})});
   if(r.changed)break;
   if(!r.exists){if(!offset)return undefined;break;}
   if(r.totalChars===undefined)return r.value;
   if(!Number.isSafeInteger(r.totalChars)||r.totalChars<0||r.totalChars>2*1024*1024||r.offset!==offset||typeof r.value!=='string')throw Error('secure_store_corrupt');
   if(total!==undefined&&(total!==r.totalChars||version!==r.version))break;
   total=r.totalChars;version=r.version;parts.push(r.value);offset+=r.value.length;
   if(offset===total)return parts.join('');
   if(!r.value.length||offset>total)throw Error('secure_store_corrupt');
  }
 }
 throw Error('secure_read_failed');
}
