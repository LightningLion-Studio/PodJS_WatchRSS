/** Full production navigation on QuickJS; synthetic IO and scratch KV only. */
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {realpathSync} from 'node:fs';
const arg=(key:string,fallback:string)=>process.argv.find(v=>v.startsWith(`--${key}=`))?.slice(key.length+3)??fallback;
const framework=resolve(arg('framework','/home/wilf/data/PodJS/podjs-watch.wt-c-k21')),pocket=resolve(framework,'vendor/pocketjs'),app=resolve(import.meta.dir,'../..');
const req=createRequire(resolve(pocket,'package.json')),{transformSync}=req('@babel/core'),t=req('@babel/types');
const out=resolve(arg('out','/tmp/douyin-entry.js'));
const aliases:Record<string,string>={'@podjs/framework':resolve(framework,'packages/framework/src/index.ts'),'@pocketjs/framework':resolve(pocket,'framework/src/index.ts'),'solid-js':resolve(pocket,'node_modules/solid-js/dist/solid.js'),'solid-js/universal':resolve(pocket,'node_modules/solid-js/universal/dist/universal.js')};
for(const [root,prefix] of [[pocket,'@pocketjs/framework'],[resolve(framework,'packages/framework'),'@podjs/framework']])for(const [key,v] of Object.entries((await Bun.file(resolve(root,'package.json')).json()).exports) as [string,any][]){const file=typeof v==='string'?v:v.import??v.default;if(key.startsWith('./'))aliases[prefix+'/'+key.slice(2)]=resolve(root,file);}
const wrap=(name:string,body:any)=>t.callExpression(t.memberExpression(t.identifier('__entryProfile'),t.identifier('time')),[t.stringLiteral(name),t.arrowFunctionExpression([],body)]);
const names=new Set(['setPageImpl','saveActivity','routeMemory','captureActivityNavigationImpl','DouyinScreen','DouyinScreenImpl','ImmersiveEntry','ImmersiveEntryImpl','ScrollEntries','ScrollEntriesImpl','HomeScreen','renderPage','checkpointInformationSnapshot','resumeTargetForStack']);
const profile=(file:string)=>({visitor:{
 FunctionDeclaration(p:any){if(!p.node.async&&!p.node.generator&&names.has(p.node.id?.name))p.node.body=t.blockStatement([t.returnStatement(wrap(p.node.id.name,p.node.body))]);},
 VariableDeclarator(p:any){if(names.has(p.node.id?.name)&&p.node.init?.type==='ArrowFunctionExpression'&&!p.node.init.async)p.node.init.body=wrap(p.node.id.name,p.node.init.body);},
 ClassMethod(p:any){if(!p.node.async&&!p.node.generator&&p.node.kind!=='constructor'&&/activity-state|resume-state|account-telemetry|telemetry\/usage/.test(file))p.node.body=t.blockStatement([t.returnStatement(wrap(file.split('/').at(-1)+':'+p.node.key.name,p.node.body))]);},
 CallExpression(p:any){if(['createMemo','createEffect','onMount'].includes(p.node.callee?.name)&&/screen.tsx|ScrollEntries|douyin\//.test(file)){const fn=p.node.arguments[0];if(fn?.type==='ArrowFunctionExpression'&&!fn.async){fn.body=wrap(file.split('/').at(-1)+':'+(p.parentPath.node.id?.name??p.node.callee.name)+':'+p.node.loc.start.line,fn.body);p.skip();}}}
}});
const {solidConditionalProps}=await import(resolve(pocket,'framework/compiler/solid-props.ts'));
const literals=new Set<string>();
const result=await Bun.build({entrypoints:[resolve(import.meta.dir,'douyin-entry-runner.tsx')],target:'browser',format:'iife',conditions:['browser'],alias:aliases,outdir:dirname(out),naming:out.split('/').at(-1),plugins:[{name:'douyin-entry-profile',setup(b){b.onResolve({filter:/.*/},args=>aliases[args.path]?{path:realpathSync(aliases[args.path])}:undefined);b.onLoad({filter:/\.(tsx|ts|js)$/},async({path})=>{
 if(!path.includes('/src/')&&!path.includes('douyin-entry-runner'))return;
 let source=await Bun.file(path).text();const root=path.startsWith(app+'/src/')?app:path.startsWith(framework+'/packages/framework/src/')?framework:'';
 const ref=root===app?arg('source-ref',''):root===framework?arg('framework-ref',''):'';
 if(ref){const r=Bun.spawnSync(['git','show',`${ref}:${path.slice(root.length+1)}`],{cwd:root});if(r.exitCode)throw Error(r.stderr.toString());source=r.stdout.toString();}
 if(path.endsWith('/service-trace.ts'))source=source.replaceAll('Date.now()','__benchNow()');
 const stripped=/\.tsx?$/.test(path)?transformSync(source,{filename:path,babelrc:false,configFile:false,presets:[[req('@babel/preset-typescript'),{isTSX:path.endsWith('.tsx'),allExtensions:true}]]}).code:source;
 const compiled=transformSync(stripped,{filename:path,babelrc:false,configFile:false,plugins:[solidConditionalProps,()=>({visitor:{StringLiteral(p:any){literals.add(p.node.value);}}})],presets:path.endsWith('.tsx')?[[req('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}]]:[]}).code;
 return {loader:'js',contents:transformSync(compiled,{filename:path,babelrc:false,configFile:false,plugins:[profile(path)]}).code};
 });}}]});if(!result.success)throw Error(result.logs.join('\n'));
const {compileClasses}=await import(resolve(pocket,'framework/compiler/tailwind.ts'));const styles=compileClasses(literals);
await Bun.write(out,`globalThis.console={log(){},warn(){},error(){},info(){},debug(){}};globalThis.__entryStyles=${JSON.stringify({ids:styles.ids,bin:[...styles.bin]})};globalThis.__entryOriginal=${arg('original','true')==='true'};globalThis.__entryTracing=${arg('trace','true')==='true'};
globalThis.__entryProfile={stats:{},stack:[],time(name,fn){const start=__benchNow(),frame={child:0};this.stack.push(frame);try{return fn();}finally{const ms=__benchNow()-start;this.stack.pop();if(this.stack.length)this.stack[this.stack.length-1].child+=ms;const s=this.stats[name]??={calls:0,ms:0,exclusiveMs:0,maxMs:0};s.calls++;s.ms+=ms;s.exclusiveMs+=ms-frame.child;s.maxMs=Math.max(s.maxMs,ms);}}};\n`+await Bun.file(out).text());console.log(out);
