import {encodeUtf8} from '@podjs/framework/bytes';
import {htmlToText} from '../core/html';
/** Local evidence only. Never changes a cross-device record or infers completeness from length. */
export function fileImportUrl(url:string):boolean{return /^(?:https:\/\/watchrss\.local\/import-(?:content\/(?:txt|epub)\/|txt-novel\/|epub\/)|watchrss:\/\/import\/(?:online-v1|instance-v1)\/|watchrss-(?:txt|epub):\/\/)/i.test(url);}
export function previewEquivalent(text:string,excerpt:string):boolean {
 // Match the phone importer ASCII \s contract on all runtimes.
 const compact=(s:string)=>s.replace(/[ \t\n\r\f\v]+/g,' ').replace(/^ +| +$/g,'');
 return !!excerpt.length && compact(text)===compact(excerpt);
}
export function authoritativeBody(input:{fileImport:boolean;text:string;excerpt:string;bodyEvidence:boolean;digestMatches:boolean;bodyAvailable?:boolean}):boolean {
 if(input.bodyAvailable===false)return false;
 if(input.fileImport&&previewEquivalent(input.text,input.excerpt))return input.digestMatches;
 return input.digestMatches||input.bodyEvidence;
}
/** An HTML digest proves plain text only when the whole HTML projection agrees. */
export async function matchingBodyDigest(text:string,html:string|null,expected:string,sha:(bytes:Uint8Array)=>Promise<string>):Promise<boolean>{
 if(!/^[a-f0-9]{64}$/.test(expected))return false;
 if(await sha(encodeUtf8(text,'question'))===expected)return true;
 return !!html&&previewEquivalent(htmlToText(html),text)&&await sha(encodeUtf8(html,'question'))===expected;
}
