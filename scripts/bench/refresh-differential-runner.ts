import {parseXmlDocument,portableXmlSteps,parseXmlDocumentSteps} from '@podjs/framework/xml';
import {parseFeed,parseFeedAsync,parseXml} from '../../src/core/parser.ts';
import {articlePreview} from '../../src/core/preview.ts';
import {articlePreview as oldPreview} from '../../tests/fixtures/preview-before.ts';
const g=globalThis as any,now=g.__benchNow,print=g.__benchPrint;let assertions=0,seed=42;
const equal=(fn:()=>unknown)=>{try{return JSON.stringify({value:fn()});}catch(e){return JSON.stringify({error:String(e)});}};
function check(xml:string){const before=equal(()=>parseXml(xml)),after=equal(()=>parseXmlDocument(xml));if(before!==after)throw Error('XML differential '+JSON.stringify({xml,before,after}));assertions++;}
const events:any[]=[],pending:any[]=[];Object.assign(g.pod,{capabilities:()=>JSON.stringify(['runtime.timer']),emit:(line:string)=>{const r=JSON.parse(line);if(r.t==='service.request')pending.push(r);},takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined});g.__benchPump=()=>{if(!pending.length)return false;const r=pending.shift();if(r.method!=='runtime.delay'||r.args.milliseconds<1)throw Error('timer contract');events.push({t:'service.result',id:r.id,ok:true,value:null});g.__pocketPumpServices();return true;};
for(const f of g.__refreshFixture.replies.filter((r:any)=>r.method==='fixture.fetch'))check(f.value);
for(const s of ['','<a/>','<a/><b/>','<rss><b>x</rss>','</a>','<r>one<![CDATA[<hi>]]><b>two</b>three</r>','<?xml x?><r a="&amp;" a="b" __proto__="x">&#xD800;</r>','<r a="&#xD800;"/>','<r A="a>b"/>','<r>\ud800</r>','<r><b/></r>','<r>unclosed','<r>界🙂'.repeat(2000),'<r>\ufeff a\n\u00a0b</r>'])check(s);
const random=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
const pool=['<r>','</r>','<r/>','<p>','</p>','<b a="x">','</b>','<p a="a>b">','<a A="&amp;"/>','<![CDATA[中🙂]]>','<!--x-->','<?x?>','<broken','<','>','a\n b','中🙂','&amp;','&#12af;','&#xD800;','\ud800'];
for(let i=0;i<2000;i++)check(Array.from({length:random()%30},()=>pool[random()%pool.length]).join(''));
const htmlPool=['<p>','</p>','<pancake>','</pancake>','<br>','<img src="&amp;x">','<img中 src=x/>','<script>','</script>','<style>','</style>','<noscript>','</noscript>','<SCRIPT>','</sCrIpT>','<!--x-->','a\n  b','中🙂','&nbsp;','&#12af;','&#999999999999999999999999;','&#xD800;','\ud800','<ſcript>x</ſcript>'];
const previews:string[]=[];
for(const f of g.__refreshFixture.replies.filter((r:any)=>r.method==='fixture.fetch')){for(const a of parseFeed(f.value,42,'https://fixture.test/feed').articles)previews.push(a.content??'');}
for(let i=0;i<2000;i++)previews.push(Array.from({length:random()%40},()=>htmlPool[random()%htmlPool.length]).join(''));
for(const html of previews){const a=equal(()=>oldPreview(html,null,null,'https://fixture.test/path')),b=equal(()=>articlePreview(html,null,null,'https://fixture.test/path'));if(a!==b)throw Error('preview differential '+JSON.stringify({html,a,b}));assertions++;}
// Closing an unfinished job releases its native slot; repeated cancellations
// exceed the native four-job cap without exhausting it.
for(let i=0;i<8;i++){const steps=parseXmlDocumentSteps('<r>x</r>');steps.next();steps.return(undefined as any);}
async function finish(){for(const f of g.__refreshFixture.replies.filter((r:any)=>r.method==='fixture.fetch')){const expected=JSON.stringify(parseFeed(f.value,42,f.url));const began=now();const actual=await parseFeedAsync(f.value,42,f.url);if(JSON.stringify(actual)!==expected)throw Error('async feed differential');print(JSON.stringify({phase:'xml.async',units:f.value.length,wallMs:now()-began,equal:true}));}print(JSON.stringify({phase:'xml.preview.differential',assertions,randomXML:2000,randomHTML:2000,cancelled:true}));g.__benchDone=true;}
finish().catch((error:any)=>{print(String(error));throw error;});
