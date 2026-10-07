import {prepareNotePreview as beforeBlocks} from '../../tests/fixtures/note-blocks-before.ts';
import {prepareNotePreview,prepareNotePreviewSteps,noteBlockSourceOffsets} from '../../src/notes/preview.ts';
import {noteTextRows,noteImageSource} from '../../src/notes/presentation.ts';
import {noteBodyLayoutBlocks,noteBodyLayoutSteps} from '../../src/notes/native-layout-input.ts';
import {memoPlainText} from '../../src/notes/text.ts';
import {noteCharacterCount} from '../../src/notes/metadata.ts';
import {noteEditorAnchor} from '../../src/notes/editor-anchor.ts';
import {notePreviewEntries,notePreviewEntrySteps} from '../../src/ui/NotePreview.tsx';
import {notePreviewEntries as beforeEntries} from '../../tests/fixtures/note-preview-before.tsx';
import {layoutText as beforeLayout} from '../../tests/fixtures/layout-text-before.ts';
import {wrapAtlasText} from '@podjs/framework/text-wrap';
import {createKeyedMemo} from '@podjs/framework/keyed-memo';
import {prepareTextLayout} from '@podjs/framework/text';
import {installHost} from '@pocketjs/framework/host';
import {defaultReaderPreset} from '../../src/reader/preset.ts';
const host=globalThis as any,now=host.__benchNow,print=host.__benchPrint,markup:string=host.__rs1Note;
let measures=0;
const measure=(s:string)=>{measures++;return s.length*7;};
installHost({ops:{measureText:measure} as any,kind:'injected',target:'bench',strict:true});
const events:unknown[]=[];
Object.assign(host.pod,{capabilities:()=>JSON.stringify(['runtime.timer']),emit:(line:string)=>{const request=JSON.parse(line);if(request.method!=='runtime.delay')throw Error('unexpected probe IO');events.push({t:'service.result',id:request.id,ok:true,value:null});},takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,displayMetrics:()=>JSON.stringify({logicalWidth:233,physicalWidth:466,logicalHeight:233,physicalHeight:466,shape:'round',safeInsets:{top:0,right:0,bottom:0,left:0}})});
host.__benchPump=()=>{if(!events.length)return false;host.__pocketPumpServices();return true;};
const time=<T>(name:string,fn:()=>T):T=>{fn();let result:T|undefined;const samples:number[]=[],calls:number[]=[];for(let i=0;i<11;i++){measures=0;const start=now();result=fn();samples.push(now()-start);calls.push(measures);}samples.sort((a,b)=>a-b);print(JSON.stringify({name,medianMs:samples[5],maxMs:samples.at(-1),measureCalls:Math.max(...calls)}));return result!;};
const blocks=time('note.parse',()=>prepareNotePreview(markup));
print(JSON.stringify({phase:'fixture',markupUnits:markup.length,characterCount:noteCharacterCount(memoPlainText(markup)),blocks:blocks.length,images:blocks.filter(b=>b.kind==='image').map(b=>noteImageSource(b.path)),tables:blocks.filter(b=>b.kind==='table').length}));
time('note.blockOffsets',()=>noteBlockSourceOffsets(markup,blocks));
time('note.rows',()=>blocks.flatMap(b=>b.kind==='rich'?noteTextRows(b.markup,b.html):[]));
if(JSON.stringify(blocks)!==JSON.stringify(beforeBlocks(markup)))throw Error('README parsed blocks changed');
const body=time('note.nativeInput',()=>noteBodyLayoutBlocks(markup));
const preset=defaultReaderPreset();
const rows=time('note.entries.fallback',()=>notePreviewEntries(markup,205,undefined,preset));
const native=new Map(body.map(b=>[b.text,[{start:0,end:b.text.length,visibleEnd:b.text.length,height:20}]]));
time('note.entries.native',()=>notePreviewEntries(markup,205,undefined,preset,native));
time('note.anchor',()=>noteEditorAnchor(rows,markup,2000,233,233,measure,{top:22,gap:0,horizontalInset:14}));
let publications=0;time('note.allNativeBatchPublications',()=>{const map=new Map();for(let i=0;i<body.length;i+=16){for(const b of body.slice(i,i+16))map.set(b.text,native.get(b.text));notePreviewEntries(markup,205,undefined,preset,map);publications++;}});
print(JSON.stringify({phase:'publication-count',bodyBlocks:body.length,perPass:Math.ceil(body.length/16),rows:rows.length}));
const geometry=(entries:ReturnType<typeof notePreviewEntries>)=>entries.map(entry=>({height:entry.height,anchor:entry.anchor,positioned:entry.positionedAnchors?.()}));
for(const layout of [undefined,native]){if(JSON.stringify(geometry(notePreviewEntries(markup,205,undefined,preset,layout)))!==JSON.stringify(geometry(beforeEntries(markup,205,undefined,preset,layout))))throw Error('README geometry/anchors changed');}
const cache=createKeyedMemo<string>();
time('note.cachedNativeBatchPublications',()=>{const map=new Map();for(let i=0;i<body.length;i+=16){for(const b of body.slice(i,i+16))map.set(b.text,native.get(b.text));notePreviewEntries(markup,205,undefined,preset,map,undefined,undefined,undefined,cache);}});
// The stable early source prefix uses exactly the final document's block and
// anchor geometry; cached image identity survives completion.
let prefix:typeof blocks|undefined;
let prefixComplete:typeof blocks=[];
const parsePrefix=prepareNotePreviewSteps(markup,1200,value=>prefix=value);
for(;;){const value=parsePrefix.next();if(value.done){prefixComplete=value.value;break;}}
if(!prefix||JSON.stringify(prefix)!==JSON.stringify(blocks.slice(0,prefix.length)))throw Error('source prefix changed blocks');
const prefixCache=createKeyedMemo<string>();
const early=notePreviewEntries(markup,205,undefined,preset,undefined,undefined,undefined,undefined,prefixCache,{blocks:prefix,offsets:noteBlockSourceOffsets(markup,prefix)});
prefixCache.get('parse',[markup],()=>({blocks:prefixComplete,offsets:noteBlockSourceOffsets(markup,prefixComplete)}));
const final=notePreviewEntries(markup,205,undefined,preset,native,undefined,undefined,undefined,prefixCache);
if(JSON.stringify(geometry(early))!==JSON.stringify(geometry(final.slice(0,early.length))))throw Error('first screen geometry changed');
const earlyImage=early.find(e=>e.data===260)!;
if(!earlyImage||!final.includes(earlyImage))throw Error('first screen image was replaced');
print(JSON.stringify({phase:'note.prefixDifferential',blocks:prefix.length,rows:early.length,geometryEqual:true,imageRetained:true}));
const identityCache=createKeyedMemo<string>();
const first=notePreviewEntries(markup,205,undefined,preset,undefined,undefined,undefined,undefined,identityCache),image=first.find(e=>e.data===260)!;
if(!image)throw Error('image fixture missing');
const second=notePreviewEntries(markup,205,undefined,preset,native,undefined,undefined,undefined,identityCache);
if(!second.includes(image))throw Error('native publication replaced image entry');
const path=blocks.find(b=>b.kind==='image')!.path;
const resized=notePreviewEntries(markup,205,undefined,preset,native,undefined,new Map([[path,140]]),undefined,identityCache).find(e=>e.data===140)!;
if(resized.key!==image.key)throw Error('image resize changed key');
let seed=42,assertions=0,parseAssertions=0;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
const pool=['a','b','中','　','\n','\r','\t','🙂','e','\u0301','\u200d','\ufe0f','\u1ab0','\u2000','\ufeff','\ud800'];
for(let run=0;run<2000;run++){
 const text=Array.from({length:random()%120},()=>pool[random()%pool.length]).join(''),width=1+random()%230,scale=(1+random()%4)/2,tracking=(random()%5-2)/10;
 const measured=(s:string)=>measure(s)*scale+Math.max(0,Array.from(s).length-1)*tracking;
 const lines=wrapAtlasText(text,{width,fontSlot:2,scale,tracking,measure:measured});
 if(JSON.stringify(lines)!==JSON.stringify(beforeLayout(text,{width,measure:measured})))throw Error('Rust wrapping differential mismatch');assertions++;
}
for(let i=0;i<1000;i++){const text=Array.from({length:random()%30},()=>['a | b','|a|b|','|---|:---:|','    x  y','![x](assets/x%20y.jpg)','```','a\t b','<img src=\"a\">','one  two','\r',''][random()%11]).join('\n');if(JSON.stringify(prepareNotePreview(text))!==JSON.stringify(beforeBlocks(text)))throw Error('random block differential');parseAssertions++;}
print(JSON.stringify({phase:'differential',wrapAssertions:assertions,parseAssertions,READMEGeometryCases:2,imageRetained:true}));
const coldCache=createKeyedMemo<string>();
let parseWork=0,parseMaxStep=0;const parsing=prepareNotePreviewSteps(markup);
const parseSteps={next(){const start=now();try{return parsing.next();}finally{parseMaxStep=Math.max(parseMaxStep,now()-start);}},return(){return parsing.return([]);}};
const parseTask=prepareTextLayout(parseSteps,{key:()=>parseWork++,entry:()=>undefined,publish:({layout})=>{coldCache.get('parse',[markup],()=>({blocks:layout,offsets:noteBlockSourceOffsets(markup,layout)}));print(JSON.stringify({phase:'note.parseSliced',maxStepMs:parseMaxStep,stats:parseTask.stats}));}});
parseTask.done.then(()=>runBodyInput()).catch(error=>{throw error;});
function runBodyInput(){let maxStepMs=0;
 const steps=noteBodyLayoutSteps(markup,coldCache.peek<{blocks:typeof blocks}>('parse',[markup])!.blocks,(block,index)=>coldCache.get('text:'+index,[block],()=>noteTextRows(block.markup,block.html)));
 const measured={next(){const start=now();try{return steps.next();}finally{maxStepMs=Math.max(maxStepMs,now()-start);}},return(){return steps.return();}};
 const task=prepareTextLayout(measured,{key:block=>block.text,entry:block=>block,publish:snapshot=>print(JSON.stringify({phase:'note.nativeInputSliced',rows:snapshot.entries.length,maxStepMs,stats:task.stats}))});
 task.done.then(()=>runLayout()).catch(error=>{throw error;});
}
function runLayout(){const steps=notePreviewEntrySteps(markup,205,undefined,preset,native,undefined,undefined,undefined,coldCache);
let maxStepMs=0;
const measuredSteps={next(){const start=now();try{return steps.next();}finally{maxStepMs=Math.max(maxStepMs,now()-start);}},return(){return steps.return();}};
const task=prepareTextLayout(measuredSteps,{key:entry=>entry,entry:entry=>entry,publish:snapshot=>print(JSON.stringify({phase:'note.sliced',rows:snapshot.entries.length,maxStepMs,stats:task.stats}))});
task.done.then(()=>{host.__benchDone=true;}).catch(error=>{throw error;});
}
