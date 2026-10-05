import type {DebugGate} from './gate.ts';
export class DouyinDebugController {
 private poisoned=new Set<string>();private autoMs=0;private last=0;private advancing=false;private poisonNext=false;private advancePending=false;private context={activeAwemeId:"",nextAwemeId:"",inVideoFlow:false};
 constructor(private gate:DebugGate){}
 updateContext(activeAwemeId:string,nextAwemeId:string,inVideoFlow:boolean){if(this.gate.allowed)this.context={activeAwemeId,nextAwemeId,inVideoFlow};}
 snapshot(){this.gate.require();return {...this.context};}
 requestAdvance(){this.gate.require();this.advancePending=true;}
 armNext(){this.gate.require();if(this.context.nextAwemeId)this.poisoned.add(this.context.nextAwemeId);else this.poisonNext=true;}
 playbackUrl(id:string,url:string,adjacent=false){return this.fail(id,adjacent)?`watchrss-debug://douyin/force-fail/${encodeURIComponent(id)}`:url;}
 poison(id:string){this.gate.require();if(id.trim())this.poisoned.add(id.trim());}
 fail(id:string,adjacent=false){if(!this.gate.allowed)return false;if(adjacent&&this.poisonNext){this.poisonNext=false;this.poisoned.add(id);}return this.poisoned.has(id);}
 setAuto(milliseconds:number){this.gate.require();if(!Number.isSafeInteger(milliseconds)||milliseconds<0)throw Error('自动换片间隔无效');this.autoMs=milliseconds;this.last=0;}
 get interval(){return this.gate.allowed?this.autoMs:0;}
 async tick(now:number,active:boolean,advance:()=>Promise<void>){if(!this.gate.allowed||!active||(!this.autoMs&&!this.advancePending)){this.last=0;return;}if(!this.last&&!this.advancePending){this.last=now;return;}if(this.advancing||(!this.advancePending&&now-this.last<this.autoMs))return;this.advancePending=false;this.last=now;this.advancing=true;try{await advance();}finally{this.advancing=false;}}
 async importCookie(raw:string,apply:(cookie:string)=>Promise<{ok:boolean;message?:string}>){this.gate.require();const cookie=raw.trim();if(!cookie)throw Error('missing_cookie');const result=await apply(cookie);if(!result.ok)throw Error(result.message||'apply_failed');return 'Cookie 已导入';}
 reset(){this.poisoned.clear();this.poisonNext=false;this.advancePending=false;this.autoMs=this.last=0;}
}
