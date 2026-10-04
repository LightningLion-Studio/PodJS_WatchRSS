import {mount} from '@pocketjs/framework/solid';
import {View} from '@pocketjs/framework/components';
import {createSignal,Show} from 'solid-js';
import {kv,getDisplayMetrics} from '@podjs/framework/watch';
import {delay} from '@podjs/framework/services';
import {TiledImage} from '../../src/ui/TiledImage.tsx';

const metrics=getDisplayMetrics();
const images=[
  {path:'image-cycle-small.jpg',width:2053,height:1027},
  {path:'image-cycle-large.jpg',width:4096,height:3072}
];
const [cycle,setCycle]=createSignal(-1);
let readyCycle=-1,failed=false,resolveReady:(()=>void)|undefined;
const report=(state:string,index:number,error?:unknown)=>kv.set('image-cycle-result',{state,index,readyCycle,error:error===undefined?undefined:String(error)});
const sleep=(ms:number)=>delay(ms).result;

mount(()=><View class="absolute inset-0 bg-black"><Show when={cycle()>=0}>
  <TiledImage url={images[Math.max(0,cycle())%images.length].path} filePath={images[Math.max(0,cycle())%images.length].path}
    geometry={{width:metrics.logicalWidth,height:metrics.logicalHeight,imageWidth:images[Math.max(0,cycle())%images.length].width,imageHeight:images[Math.max(0,cycle())%images.length].height,density:metrics.density}}
    state={{scale:1,x:0,y:0}} onSize={()=>{}}
    onVisibleTilesReady={()=>{const index=cycle();readyCycle=index;report('ready',index);resolveReady?.();resolveReady=undefined;}}
    onError={error=>{const index=cycle();failed=true;report('failed',index,error);resolveReady?.();resolveReady=undefined;}}/>
</Show></View>);

void (async()=>{
  for(let index=0;index<6;index++){
    report('opening',index);
    const ready=new Promise<void>(resolve=>{resolveReady=resolve;});
    setCycle(index);
    await Promise.race([ready,sleep(45000)]);
    if(failed||readyCycle!==index){report('failed',index,'tiles_timeout');return;}
    await sleep(600);
    setCycle(-1);
    await sleep(1200);
    report('idle',index);
    await sleep(600);
  }
  report('passed',5);
})().catch(error=>report('failed',cycle(),error));
