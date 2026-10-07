import type {JsonObject} from "./protocol.ts";
const numericTokens=new WeakMap<object,Map<string,string>>();
/** JSON.parse loses the integer-vs-double distinction used by JSONObject's
 * strict body metadata readers (1 and 1.0 are different native types). */
export function parseWireJson(text:string):JsonObject {
 const root:unknown=JSON.parse(text);
 if(!root||typeof root!=="object"||Array.isArray(root))throw new Error("sync payload must be a JSON object");
 let at=0;
 const space=()=>{while(at<text.length&&/[\x20\t\r\n]/.test(text[at]!))at++;};
 const string=()=>{const start=at++;while(at<text.length){const c=text[at++];if(c==='"')break;if(c==='\\')at++;}return text.slice(start,at);};
 const mark=(parent:unknown,key:string,token:string|null)=>{if(parent&&typeof parent==="object"){let m=numericTokens.get(parent);if(!m){m=new Map();numericTokens.set(parent,m);}if(token===null)m.delete(key);else m.set(key,token);}};
 function visit(value:unknown,parent:unknown,key:string,depth:number):void {
  if(depth>128)throw new Error("sync JSON nesting too deep");space();const c=text[at];
  mark(parent,key,null);
  if(c==='{'){
   at++;space();if(text[at]==='}'){at++;return;}
   while(at<text.length){space();const k=JSON.parse(string()) as string;space();at++;visit(value&&typeof value==="object"?(value as JsonObject)[k]:undefined,value,k,depth+1);space();if(text[at++]==='}')break;}
  }else if(c==='['){
   at++;space();if(text[at]===']'){at++;return;}let index=0;
   while(at<text.length){visit(Array.isArray(value)?value[index]:undefined,value,String(index++),depth+1);space();if(text[at++]===']')break;}
  }else if(c==='"'){string();}
  else{const start=at;while(at<text.length&&!/[\x20\t\r\n,\]}]/.test(text[at]!))at++;const token=text.slice(start,at);if(token!=="true"&&token!=="false"&&token!=="null")mark(parent,key,token);}
 }
 visit(root,null,"",0);return root as JsonObject;
}
export function wireNumberToken(parent:object,key:string):string|undefined{return numericTokens.get(parent)?.get(key);}
export function isWireInteger(parent:object,key:string):boolean{
 const value=(parent as Record<string,unknown>)[key],token=wireNumberToken(parent,key);
 return typeof value==="number"&&Number.isSafeInteger(value)&&(token===undefined||/^-?(?:0|[1-9][0-9]*)$/.test(token));
}
