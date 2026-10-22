import {utf8Encode} from './types';
// Local URL identity: no network, pool UUID, or host-global URL dependency.
// IDNA uses RFC 3492; URL path/query spelling remains significant.
function asciiLabel(label:string){
 if(/^[\x00-\x7f]*$/.test(label))return label;
 const input=Array.from(label,c=>c.codePointAt(0)!),base=input.filter(c=>c<128);let out=String.fromCharCode(...base),n=128,delta=0,bias=72,h=base.length;
 if(h)out+='-';const adapt=(d:number,count:number,first:boolean)=>{d=first?Math.floor(d/700):Math.floor(d/2);d+=Math.floor(d/count);let k=0;while(d>455){d=Math.floor(d/35);k+=36;}return k+Math.floor(36*d/(d+38));};
 while(h<input.length){const m=Math.min(...input.filter(c=>c>=n));delta+=(m-n)*(h+1);n=m;for(const cp of input){if(cp<n)delta++;if(cp===n){let q=delta;for(let k=36;;k+=36){const t=k<=bias?1:k>=bias+26?26:k-bias;if(q<t)break;const v=t+(q-t)%(36-t);out+=String.fromCharCode(v<26?v+97:v-26+48);q=Math.floor((q-t)/(36-t));}out+=String.fromCharCode(q<26?q+97:q-26+48);bias=adapt(delta,h+1,h===base.length);delta=0;h++;}}delta++;n++;}return 'xn--'+out;
}
function ipv6Words(host:string){
 let text=host.slice(1,-1).toLowerCase();
 if(text.includes('.')){const colon=text.lastIndexOf(':'),v4=text.slice(colon+1).split('.');if(v4.length!==4||v4.some(v=>!/^(0|[1-9]\d{0,2})$/.test(v)||Number(v)>255))throw Error('invalid_rss_url');text=text.slice(0,colon+1)+((Number(v4[0])<<8)|Number(v4[1])).toString(16)+':'+((Number(v4[2])<<8)|Number(v4[3])).toString(16);}
 const parts=text.split('::');if(parts.length>2)throw Error('invalid_rss_url');const left=parts[0]?parts[0].split(':'):[],right=parts[1]?parts[1].split(':'):[];if([...left,...right].some(v=>!/^[0-9a-f]{1,4}$/.test(v))||parts.length===2&&left.length+right.length>=8)throw Error('invalid_rss_url');const words=[...left,...Array(parts.length===2?8-left.length-right.length:0).fill('0'),...right].map(v=>parseInt(v,16));if(words.length!==8)throw Error('invalid_rss_url');return words;
}
function ipHost(host:string){
 if(host.startsWith('[')){const words=ipv6Words(host);let start=-1,length=1;for(let i=0;i<8;){if(words[i]){i++;continue;}let j=i;while(j<8&&!words[j])j++;if(j-i>length){start=i;length=j-i;}i=j;}return '['+(start<0?words.map(v=>v.toString(16)).join(':'):words.slice(0,start).map(v=>v.toString(16)).join(':')+'::'+words.slice(start+length).map(v=>v.toString(16)).join(':'))+']';}
 const bits=host.split('.');if(bits.at(-1)==='')bits.pop();if(bits.length&&bits.every(p=>/^(?:0x[\da-f]+|\d+)$/i.test(p))){const nums=bits.map(p=>/^0x/i.test(p)?parseInt(p.slice(2),16):p.length>1&&p[0]==='0'?parseInt(p,8):Number(p));if(nums.length>4||nums.some(n=>!Number.isFinite(n)||n<0)||nums.slice(0,-1).some(n=>n>255)||nums.at(-1)!>=256**(5-nums.length))throw Error('invalid_rss_url');let n=nums.at(-1)!;for(let i=0;i<nums.length-1;i++)n+=nums[i]*256**(3-i);return [24,16,8,0].map(b=>Math.floor(n/2**b)%256).join('.');}return host;
}
function publicHost(host:string){
 if(host.startsWith('[')){const words=ipv6Words(host),[a,b]=words;if(words.slice(0,5).every(v=>v===0)&&(words[5]===0||words[5]===0xffff))return publicHost([words[6]>>8,words[6]&255,words[7]>>8,words[7]&255].join('.'));return (a&0xe000)===0x2000&&!(a===0x2001&&(b<0x200||b===0xdb8))&&a!==0x2002&&!(a===0x3fff&&b<0x1000);}
 if(!/^[\d.]+$/.test(host))return true;const [a,b,c]=host.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===192&&b===0&&(c===0||c===2)||a===192&&b===88&&c===99||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19)||a===198&&b===51&&c===100||a===203&&b===0&&c===113);
}
export function canonicalRssUrl(raw:string,validateAddress=true){
 if(utf8Encode(raw).length>4096)throw Error('invalid_rss_url');const value=raw.trim().replace(/[\t\r\n]/g,'').replace(/^[^?#]*/,v=>v.replace(/\\/g,'/')),m=/^(https?):\/\/([^/?#]+)([^#]*)/i.exec(value);if(!m)throw Error('invalid_rss_url');if(m[2].startsWith('@'))m[2]=m[2].slice(1);if(m[2].includes('@'))throw Error('invalid_rss_url');
 const authority=/^(\[[^\]]+\]|[^:]+)(?::(\d*))?$/.exec(m[2]);if(!authority)throw Error('invalid_rss_url');const scheme=m[1].toLowerCase(),host=ipHost(decodeURIComponent(authority[1]).toLowerCase().normalize('NFC').replace(/[\u3002\uff0e\uff61]/g,'.').split('.').map(asciiLabel).join('.'));if(!host||/[\s/#?%|^<>]/.test(host))throw Error('invalid_rss_url');if(validateAddress&&!publicHost(host))throw Error('rss_private_address_blocked');let port=authority[2]?Number(authority[2]):null;if(port!==null&&port>65535)throw Error('invalid_rss_url');if(port===(scheme==='https'?443:80))port=null;
 const q=m[3].indexOf('?'),path=q<0?m[3]:m[3].slice(0,q),query=q<0?'':m[3].slice(q),segments:string[]=[];for(const [i,p]of (path||'/').split('/').entries()){if(i===0)continue;const dot=p.replace(/%2e/ig,'.');if(dot==='..'){segments.pop();}else if(dot!=='.')segments.push(p);if((dot==='..'||dot==='.')&&i===(path||'/').split('/').length-1)segments.push('');}
 const encode=(s:string,query=false)=>Array.from(s,c=>/[\u0000-\u0020\u007f-\uffff]/.test(c)||c.codePointAt(0)!>127||/["<>]/.test(c)||!query&&/[{}`]/.test(c)||query&&c==="'"?encodeURIComponent(c).replace(/[!'()*]/g,v=>'%'+v.charCodeAt(0).toString(16).toUpperCase()):c).join('');return scheme+'://'+host+(port!==null?':'+port:'')+encode('/'+segments.join('/'))+encode(query,true);
}
export const rssSourceKey=(raw:string,sha256:(bytes:Uint8Array)=>Promise<string>)=>sha256(utf8Encode(canonicalRssUrl(raw)));

/** R41: exact rss.rs store_entry priority. A non-web link is absent, not a URL error.
 * Pool dedupKey is already the hash, and must never be hashed as a synthetic guid. */
export interface RssEntryIdentity {link?:string|null;guid?:string|null;contentHash?:string|null;title?:string|null;dedupKey?:string|null}
export async function rssArticleId(raw:string|RssEntryIdentity,sha256:(bytes:Uint8Array)=>Promise<string>){
 const entry=typeof raw==='string'?{link:raw}:raw;
 if(entry.dedupKey!=null){if(!/^[a-f0-9]{64}$/.test(entry.dedupKey))throw Error('invalid_rss_entry_identity');return entry.dedupKey;}
 let identity=entry.guid?.trim();
 if(!identity){try{identity=canonicalRssUrl(entry.link??'',false);}catch{/* rss.rs canonicalize_entry_link returns None. */}}
 identity??=entry.contentHash??entry.title?.trim()??'';
 // A blank guid is absent, including when link parsing failed.
 if(!identity)identity=entry.contentHash??entry.title?.trim()??'';
 return sha256(utf8Encode(identity));
}
/** Per-entry containment. An uncomputable entry never prevents healthy records or snapshots. */
export async function tryRssArticleId(raw:string|RssEntryIdentity,sha256:(bytes:Uint8Array)=>Promise<string>){
 try{return await rssArticleId(raw,sha256);}catch{return undefined;}
}

/** Standalone webpage compatibility; RSS uses rssArticleId instead (R41). */
export function legacyWebArticleId(raw:string,sha256:(bytes:Uint8Array)=>Promise<string>){const canonical=canonicalRssUrl(raw,false),m=/^(https?):\/\/(\[[^\]]+\]|[^/:]+)(?::[0-9]+)?(.*)$/.exec(canonical)!;return sha256(utf8Encode(m[1]+'://'+m[2].replace(/^www\./,'')+m[3].replace(/\?$/,'')));}

/** R36: subscription remains encrypted and byte-preserved; no public IO/state. */
export function isLocalOnlyRssSource(raw:string){try{canonicalRssUrl(raw);return false;}catch{return true;}}
