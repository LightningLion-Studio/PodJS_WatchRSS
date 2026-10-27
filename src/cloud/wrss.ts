import {utf8Encode,utf8Decode} from './types';

const MAX=256*1024*1024, ENTRY=32*1024*1024;
const entryLimit=(name:string)=>/^books\/[a-f0-9]{64}\.jsonl$/.test(name)?MAX:ENTRY;
const check=(v:unknown)=>{if(!v)throw Error('cloud_archive_invalid');};
export function crc32(bytes:Uint8Array){let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
const concat=(parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((n,b)=>n+b.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;};
/** Deterministic ZIP STORE: fixed DOS date, UTF-8 names, no platform extras. */
export function writeWrss(entries:Map<string,Uint8Array>):Uint8Array {
 check(entries.size<=65535);const files:Uint8Array[]=[],directory:Uint8Array[]=[];let offset=0;
 for(const [name,bytes]of entries){const path=utf8Encode(name),crc=crc32(bytes);check(path.length<65536&&bytes.length<=entryLimit(name));
  const local=new Uint8Array(30+path.length),l=new DataView(local.buffer);l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x800,true);l.setUint16(12,33,true);l.setUint32(14,crc,true);l.setUint32(18,bytes.length,true);l.setUint32(22,bytes.length,true);l.setUint16(26,path.length,true);local.set(path,30);
  const central=new Uint8Array(46+path.length),c=new DataView(central.buffer);c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint16(14,33,true);c.setUint32(16,crc,true);c.setUint32(20,bytes.length,true);c.setUint32(24,bytes.length,true);c.setUint16(28,path.length,true);c.setUint32(42,offset,true);central.set(path,46);
  files.push(local,bytes);directory.push(central);offset+=local.length+bytes.length;check(offset<=MAX);
 }
 const cd=concat(directory),end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.size,true);v.setUint16(10,entries.size,true);v.setUint32(12,cd.length,true);v.setUint32(16,offset,true);check(offset+cd.length+22<=MAX);return concat([...files,cd,end]);
}
/** Authenticated ZIP only; strict bounds/CRC, no path extraction or filesystem names. */
export async function readWrss(bytes:Uint8Array,gunzip:(b:Uint8Array,max:number)=>Promise<Uint8Array>,options:{yield?:()=>Promise<void>}={}){
 check(bytes.length>=22&&bytes.length<=MAX);const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let end=bytes.length-22;
 for(;end>=Math.max(0,bytes.length-65557);end--)if(view.getUint32(end,true)===0x06054b50&&end+22+view.getUint16(end+20,true)===bytes.length)break;
 check(end>=0&&end>=bytes.length-65557);check(view.getUint16(end+4,true)===0&&view.getUint16(end+6,true)===0);
 const count=view.getUint16(end+10,true),size=view.getUint32(end+12,true),start=view.getUint32(end+16,true);check(view.getUint16(end+8,true)===count&&start+size===end);
 const entries=new Map<string,Uint8Array>();let at=start,total=0;
 for(let i=0;i<count;i++){if(i>0&&i%16===0)await options.yield?.();
  check(at+46<=end&&view.getUint32(at,true)===0x02014b50);
  const flags=view.getUint16(at+8,true),method=view.getUint16(at+10,true),crc=view.getUint32(at+16,true),packed=view.getUint32(at+20,true),length=view.getUint32(at+24,true),n=view.getUint16(at+28,true),extra=view.getUint16(at+30,true),comment=view.getUint16(at+32,true),local=view.getUint32(at+42,true);
  check(!(flags&1)&&[0,8].includes(method)&&at+46+n+extra+comment<=end&&local+30<=start);
  const name=utf8Decode(bytes.subarray(at+46,at+46+n));check(length<=entryLimit(name)&&packed<=entryLimit(name));check(name.length&&!name.startsWith('/')&&!name.split('/').some(p=>p==='..'||p==='.')&&!name.includes('\\')&&!entries.has(name));
  check(view.getUint32(local,true)===0x04034b50&&view.getUint16(local+8,true)===method);const ln=view.getUint16(local+26,true),le=view.getUint16(local+28,true),body=local+30+ln+le;check(body+packed<=start&&utf8Decode(bytes.subarray(local+30,local+30+ln))===name);
  let raw:Uint8Array=bytes.slice(body,body+packed);
  if(method===8){const trailer=new Uint8Array(8),t=new DataView(trailer.buffer);t.setUint32(0,crc,true);t.setUint32(4,length,true);raw=await gunzip(concat([new Uint8Array([31,139,8,0,0,0,0,0,0,3]),raw,trailer]),length);}
  check(raw.length===length&&crc32(raw)===crc);total+=raw.length;check(total<=MAX);entries.set(name,raw);at+=46+n+extra+comment;
 }
 check(at===end);return entries;
}
