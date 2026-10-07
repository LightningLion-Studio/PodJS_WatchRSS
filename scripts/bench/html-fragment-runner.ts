import {requestHtmlFragment} from '@podjs/framework/html-slices';
import {parseContent,extractReadableHtml,parseContentAsync} from '../../src/reader/content.ts';
import {parseContent as before,extractReadableHtml as readableBefore} from '../../tests/fixtures/html-content-before.ts';
import {parseHtmlFragment,parseHtmlFragmentSteps} from '@podjs/framework/html';
const g=globalThis as any,now=g.__benchNow,print=g.__benchPrint;
const nativeAvailable=typeof g.pod.htmlBegin==='function';
const events:any[]=[],pending:any[]=[];
Object.assign(g.pod,{capabilities:()=>JSON.stringify(['runtime.timer']),emit:(line:string)=>{const r=JSON.parse(line);if(r.t==='service.request'){if(r.method!=='runtime.delay'||r.args.milliseconds<1)throw Error('timer contract');pending.push(r);}else if(r.t==='service.cancel'){const i=pending.findIndex(p=>p.id===r.id);if(i>=0)pending.splice(i,1);}},takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined});
g.__benchPump=()=>{if(!pending.length)return false;const r=pending.shift();events.push({t:'service.result',id:r.id,ok:true,value:null});g.__pocketPumpServices();return true;};
let assertions=0,nativeTrees=0;
function check(name:string,html:string){
 const a=JSON.stringify(before(html)),b=JSON.stringify(parseContent(html));if(a!==b)throw Error('block differential '+name+' '+JSON.stringify({html,a,b}));assertions++;
 const base='https://fixture.test/news/item';const r=readableBefore(html,base),s=extractReadableHtml(html,base);if(r!==s)throw Error('readable differential '+name+' '+JSON.stringify({html,r,s}));assertions++;
 if(parseHtmlFragment(html))nativeTrees++;
}
for(const f of g.__htmlFixtures)check(f.name,f.html);
check('deep5000','<div>'.repeat(5000)+'<p>deep</p>'+'</div>'.repeat(5000));
check('unicode attributes','<article><p ΟΣ="ok" İ="ok">one</p></article>');
check('infinite numeric','<p>&#'+('9'.repeat(400))+'; &#x'+('f'.repeat(400))+';</p>');
check('lone source surrogate','<p>\ud800x</p>');
check('surrogate numeric','<p>&#xD800; &#dc00; &#ab; &#12af; &#99999999999999999999;</p>');
check('oversized token','<p>'+('a'.repeat(20000))+'</p>');
check('oversized quoted tag','<p title="'+('<b>'.repeat(7000))+'">tail</p>');
let seed=42;const random=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
const pool=['<div>','</div>','<p>','</p>','<p a=foo/>','<li>','</li>','<img src="a>b" alt="&amp;">','<script>','</script>','<style>','</style>','<!--x-->','<!--unfinished','<!x>','<broken','< a>','<','>','中🙂','a\n  b','&nbsp;','&#12af;','&bogus;','<p class="bio">','<main>','</main>','<pre>','</pre>','<img __proto__="x" data-SRC=../x>','<p\u00a0id="a">','<p a=\"bad>','<div role=tooltip>','<iframe src=//example.test/x>'];
for(let i=0;i<2000;i++)check('random'+i,Array.from({length:random()%40},()=>pool[random()%pool.length]).join(''));
function time(fn:()=>unknown){fn();const values:number[]=[];for(let i=0;i<11;i++){const start=now();fn();values.push(now()-start);}values.sort((a,b)=>a-b);return {medianMs:values[5],maxMs:values.at(-1)};}
for(const name of ['411','407']){const html=g.__htmlFixtures.find((f:any)=>f.name===name).html;print(JSON.stringify({phase:'html.sync',name,units:html.length,blocks:parseContent(html).length,before:time(()=>before(html)),after:time(()=>parseContent(html))}));}
// Real bridge lifetime: cancellation closes the generator and releases the job.
const cancelled=parseHtmlFragmentSteps('<p>x</p>');cancelled.next();cancelled.return(null);
let didPublish=false;const task=requestHtmlFragment('<p>x</p>',()=>didPublish=true);task.cancel();
task.done.then(()=>{if(didPublish)throw Error('cancelled publication');return asyncBench(0);}).catch((error:any)=>{throw error;});
async function asyncBench(index:number){
 const name=['411','407'][index],html=g.__htmlFixtures.find((f:any)=>f.name===name).html;let tree:any,maxStepMs=0,steps=0;
 const generator=parseHtmlFragmentSteps(html),measure={next(){const began=now();const result=generator.next();maxStepMs=Math.max(maxStepMs,now()-began);steps++;return result;},return(){return generator.return(null);}};
 const {prepareTextLayout}=await import('@podjs/framework/text-layout');let key=0;
 const work=prepareTextLayout(measure,{key:()=>key++,entry:()=>undefined,publish:({layout})=>tree=layout});await work.done;
 if(!tree&&nativeAvailable)throw Error('real fixture lost native path');
 const started=now();const blocks=await parseContentAsync(html);if(JSON.stringify(blocks)!==JSON.stringify(before(html)))throw Error('async differential');
 print(JSON.stringify({phase:'html.async',name,steps,maxStepMs,scheduler:work.stats,wallMs:now()-started}));
 if(index===0)return asyncBench(1);
 print(JSON.stringify({phase:'html.differential',assertions,nativeTrees,existingFixtures:g.__htmlFixtures.length,randomCases:2000,cancelled:true}));g.__benchDone=true;
}
