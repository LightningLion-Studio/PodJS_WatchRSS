import {mount} from '@pocketjs/framework/solid';
import WatchRSS from '../../../src/ui/screen.tsx';
import {services} from '../../../src/services.ts';
import {kv} from '@podjs/framework/watch';
import {delay,fileChunks} from '@podjs/framework/services';
import {readerPreviewSession as session,requestReaderPreviewOpen} from '../../../src/reader/preview-host.ts';
import {handleReaderPreview} from '../../../src/sync/reader-preview.ts';
import {defaultReaderPreset} from '../../../src/reader/preset.ts';
const sleep=(ms:number)=>delay(ms).result;
const check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const send=(request:Record<string,unknown>)=>handleReaderPreview({version:2,sessionId:'fixture-preview',...request},session,requestReaderPreviewOpen);
async function stage(name:string,sequence:number){kv.set('reader-preview-result',{state:'running',stage:name});const end=Date.now()+90000;while(!(await fileChunks.stat('preview-advance-'+name)).file){if(Date.now()>end)throw Error('Snapshot stage timed out: '+name);if(session.state())send({phase:'heartbeat',sequence});await sleep(150);}}
async function run(){
 await sleep(2000);const before=JSON.stringify(kv.get('watchrss.reader-presets'));check(before,'presets not initialized');const preset=defaultReaderPreset('preview-only','Ephemeral preview',true,14);
 check(send({phase:'update',sequence:0,preset}).applied,'full');await stage('full',0);
 check(send({phase:'update',sequence:1,changes:{body:{...preset.body,fontSizeSp:20,colorArgb:0xffff7777}}}).applied,'delta');await sleep(100);await stage('delta',1);
 const transfer={...preset,background:{...preset.background,colorArgb:0xff164020}};check(send({phase:'resourceHandoff',sequence:2,preset:transfer}).applied,'handoff');await stage('transfer',2);
 check(send({phase:'update',sequence:3,preset:transfer}).applied,'resource applied');await stage('switched',3);
 check(send({phase:'stop'}).applied,'stop');await stage('stopped',3);check(!session.state(),'still active');check(JSON.stringify(kv.get('watchrss.reader-presets'))===before,'persisted preview');
 check(send({phase:'update',sequence:0,preset}).applied,'restart');await stage('before-expiry',0);kv.set('reader-preview-result',{state:'running',stage:'waiting-expiry'});await sleep(21000);check(!session.state(),'did not expire');check(JSON.stringify(kv.get('watchrss.reader-presets'))===before,'expiry changed stored preset');kv.set('reader-preview-result',{state:'passed',stage:'expired',full:true,delta:true,resourceHandoff:true,stop:true,expired:true,presetsUnchanged:true});
}
mount(()=><WatchRSS services={services}/>);
void run().catch(error=>kv.set('reader-preview-result',{state:'failed',error:String(error),stack:error instanceof Error?error.stack:''}));
