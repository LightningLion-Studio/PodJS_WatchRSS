export const repositoryStages=new Set(['snapshot-retry','cloudSnapshot','legacySnapshot','prepareFastProjection','localSnapshot','definitions','definitions-invalidate','projection-install','cloudSources','cloudMetadata','cloudReading']);
export type RepositoryDiagnostic=(fields:Record<string,string|number>)=>void;
export async function repositoryWork<T>(emit:RepositoryDiagnostic|undefined,stage:string,action:()=>Promise<T>,now=()=>Date.now()):Promise<T>{
 const at=now();const report=(outcome:string)=>{try{emit?.({event:'library-work',stage,outcome,durationMillis:Math.max(0,now()-at)});}catch{}};
 report('started');let success=false;try{const value=await action();success=true;return value;}finally{report(success?'complete':'failed');}
}
