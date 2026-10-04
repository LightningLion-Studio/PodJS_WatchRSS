import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {bytesToBase64,delay} from '@podjs/framework/services';
import {javaUtf8Chunks} from '../../src/reader/imported-text-writer.ts';
import {javaJsonQuote} from '../../src/sync/article-body.ts';
import {bytesToBase64 as portableBase64} from '/home/wilf/data/PodJS/podjs-watch/vendor/pocketjs/framework/src/bytes.ts';
const key='sync-encoding-profile';
const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function batched(bytes:Uint8Array){const parts:string[]=[],units:number[]=[];for(let i=0;i<bytes.length;i+=3){const a=bytes[i]!,b=bytes[i+1]??0,c=bytes[i+2]??0;units.push(chars.charCodeAt(a>>2),chars.charCodeAt(((a&3)<<4)|(b>>4)),i+1<bytes.length?chars.charCodeAt(((b&15)<<2)|(c>>6)):61,i+2<bytes.length?chars.charCodeAt(c&63):61);if(units.length>=1024){parts.push(String.fromCharCode(...units));units.length=0;}}if(units.length)parts.push(String.fromCharCode(...units));return parts.join('');}
async function run(){const results:Record<string,number>={};kv.set(key,{state:'running'});const data=Uint8Array.from({length:65536},(_,i)=>i&255);let expected='';
 for(const [name,operation] of [['base64-portable',()=>expected=portableBase64(data)],['base64-native',()=>{if(bytesToBase64(data)!==expected)throw new Error('Native Base64 mismatch');}],['base64-batched',()=>{if(batched(data)!==expected)throw new Error('Base64 mismatch');}],['utf8-32k',()=>{let count=0;for(const b of javaUtf8Chunks('汉😀\0text'.repeat(4096)))count+=b.length;if(count!==49152)throw new Error('UTF8 size');}],['json-720k',()=>javaJsonQuote('汉😀\0text'.repeat(90000))]] as const){const start=Date.now();for(let i=0;i<3;i++)operation();results[name]=(Date.now()-start)/3;kv.set(key,{state:'running',results});await delay(30).result;}
 kv.set(key,{state:'passed',nativeAvailable:typeof (globalThis as any).pod?.encodeBase64==='function',results});}
mount(()=><Text>Sync encoding profile</Text>);void run().catch(e=>kv.set(key,{state:'failed',error:String(e)}));
