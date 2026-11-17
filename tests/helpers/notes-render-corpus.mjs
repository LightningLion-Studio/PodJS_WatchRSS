// Deterministic grammar fuzzing. The oracle is libcmark + parse5, not product logic.
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const host=createRequire(new URL('../../../PodJS_WatchRSS/package.json',import.meta.url));
const parser=host('parse5');
export const serialize=parser.serialize;
export function parseFragment(source){return parser.parseFragment(parser.defaultTreeAdapter.createElement('div','http://www.w3.org/1999/xhtml',[]),source,{scriptingEnabled:true});}
export function htmlOracle(source){
 // Apply the documented noninteractive note policy using an independent parser
 // version; Chromium separately compares the original, unmodified source.
 const state=parser.Parser.getFragmentParser(parser.defaultTreeAdapter.createElement('div','http://www.w3.org/1999/xhtml',[]),{scriptingEnabled:true});
 for(const method of ['onStartTag','onEndTag']){const receive=state[method].bind(state);state[method]=token=>receive(token.tagName==='select'&&!(method==='onStartTag'?state.shouldProcessStartTagTokenInForeignContent(token):state.currentNotInHTML)?{...token,tagName:'div',tagID:parser.html.TAG_ID.DIV}:token);}
 state.tokenizer.write(source,true);return state.getFragment();
}
export function markdownOracles(seed,count=COUNT){return JSON.parse(execFileSync('python3',[fileURLToPath(new URL('./notes-cmark-oracle.py',import.meta.url))],{input:JSON.stringify(Array.from(cases(seed,count),c=>c.markdown)),encoding:'utf8',maxBuffer:128*1024*1024}));}
export const SEEDS=[0x4e4f5445,0x524e5235,0x20261117,0xc0decafe];
export const COUNT=Number(process.env.NOTES_FUZZ_CASES||128);
export const blocked=new Set('script style iframe object template head noscript'.split(' '));
export function visible(node){if(blocked.has(node.tagName))return '';if(node.nodeName==='#text')return node.value;return(node.childNodes||[]).map(visible).join('');}
export function codes(node,out=[]){if(node.tagName==='pre'){out.push(visible(node));return out;}for(const c of node.childNodes||[])codes(c,out);return out;}
export function compact(s){return s.replace(/\s/g,'');}
export function retains(expected,actual){expected=compact(expected);actual=compact(actual);let at=0;for(let i=0;i<actual.length;i++)if(actual[i]===expected[at])at++;return at===expected.length;}
export function rng(seed){let x=seed>>>0;return n=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)%n;};}
const escape=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
export function* cases(seed,count=COUNT){
 const pick=rng(seed);let id=0;
 const text=()=> 'K'+seed.toString(16)+'Z'+(id++).toString(16)+'X文é😀';
 const names=['template','object','head','script','style','iframe','div','p','span','svg','math','table','select','textarea','xmp','noscript'];
 const end=name=>['</'+name+'>','</'+name+' x>','</'+name+'/>','</template>',''][pick(5)];
 const element=depth=>{
  const name=names[pick(names.length)],attrs=['',' title="<script>"',' title="</template>"',' onclick="probe()"',' style="color:red;background:url(javascript:probe())"'][pick(5)];
  const inner=depth?element(depth-1):escape(text());
  return '<'+name+attrs+'>'+inner+end(name);
 };
 for(let index=0;index<count;index++){
  const source='<p>'+escape(text())+'</p>'+element(1+pick(4))+['<!-->','<!--x-->','<p title="<script>">'+escape(text())+'</p>','<img src="assets/x.png" onerror="probe()">','<a href="jav&#x61;script:probe()">'+escape(text())+'</a>'][pick(5)]+'<p>'+escape(text())+'</p>';
  const marker=['```','~~~','````','~~~~'][pick(4)],prefix=['','> ','- ','> - ','- > ','> > ','1. ','  - ','> 1. > '][pick(9)];
  const next=prefix.replace(/(?:[-+*]|\d+[.)]) /g,s=>' '.repeat(s.length));
  const payload=text()+' | <img src="assets/x.png">',info=['lang|x','lang\u2028x','html','lang\u2029x',''][pick(5)];
  const fake=pick(2)?next+marker+'\u00a0\n':'';
  const fence=prefix+marker+info+'\n'+fake+next+payload+'\n'+next+marker+['',' \t',' '][pick(3)];
  const units=[fence,'A | B\n---|---\n'+marker+'lang|x\n'+text()+' | CODE\n'+marker,['    ','\t','  \t'][pick(3)]+text()+' | <img src="assets/x.png">','- '+text()+'\n\n> '+text(),'<p title="<script>">'+escape(text())+'</p>','<template><object></template><p>'+escape(text())+'</p>','<style>DROP</style/><p>'+escape(text())+'</p>'];
  for(let i=units.length-1;i>0;i--){const j=pick(i+1);[units[i],units[j]]=[units[j],units[i]];}
  yield {seed,index,html:source,markdown:units.slice(0,3+pick(5)).join('\n\n')};
 }
}
const allowed=new Set('p div span b strong i em u s strike del ol ul li br h1 h2 h3 h4 h5 h6 blockquote code a img mark sub sup'.split(' '));
export function unsafe(html){
 for(let pass=0;pass<3;pass++){
  const tree=parseFragment(html);let bad='';function walk(n){
   if(n.tagName&&(!allowed.has(n.tagName)||n.namespaceURI!=='http://www.w3.org/1999/xhtml'))bad=n.tagName;
   for(const a of n.attrs||[])if(!['src','href','alt','title','style','width','height'].includes(a.name)||(['src','href'].includes(a.name)&&/^[\s\x00-\x20]*(?:javascript|vbscript|data:text|data:image\/svg)/i.test(a.value))||(a.name==='style'&&/(?:expression|url|javascript|vbscript|behavior|binding)/i.test(a.value)))bad=a.name+'='+a.value;
   for(const c of n.childNodes||[])walk(c);if(n.content)walk(n.content);
  }walk(tree);if(bad)return bad;html=serialize(tree);
 }return '';
}
