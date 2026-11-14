import {expect,mock,test} from 'bun:test';
import {createRoot,onCleanup} from 'solid-js';
let gesture:any,frame:()=>void=()=>{},needs:()=>boolean=()=>false,disposed=false,registered=0;
mock.module('@pocketjs/framework/gesture',()=>({createGesture:(options:any)=>{gesture=options;return{dispose(){disposed=true;options.onCancel?.();}};}}));
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame(fn:any,demand:any){registered++;frame=fn;needs=demand??(()=>true);onCleanup(()=>{registered--;frame=()=>{};needs=()=>false;});}}));
const {createHoldPress}=await import('../src/ui/hold-press.ts');
test('held button stops repeating when disabled and releases its frame demand',()=>{
 let enabled=true,calls=0,end=0,stop!:()=>void;
 createRoot(dispose=>{stop=dispose;createHoldPress(()=>({} as any),{enabled:()=>enabled,onPress(){},onHold(){calls++;},onHoldEnd(){end++;}});});
 gesture.onLongPress();frame();expect(calls).toBe(1);enabled=false;frame();expect(end).toBe(1);expect(needs?.()).toBe(false);stop();expect(disposed).toBe(true);
});
test('idle holds do not request frames, cancellation and disposal stop callbacks',()=>{
 let calls=0,stop!:()=>void;
 createRoot(dispose=>{stop=dispose;createHoldPress(()=>({} as any),{onPress(){calls++;},onHold(){calls++;}});});
 expect(registered).toBe(0);expect(needs?.()).toBe(false);gesture.onLongPress();expect(registered).toBe(1);expect(needs?.()).toBe(true);gesture.onCancel();expect(registered).toBe(0);frame();expect(calls).toBe(0);stop();frame();expect(calls).toBe(0);
});
