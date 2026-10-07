/** Mounted ReaderBody/NoteDetailScreen on the device runtime's QuickJS.
 * Native layout/raster/font/GPU timings are explicit synthetic IO boundaries.
 * Example: bun scripts/bench/reader-entry.ts --framework=... --out=/tmp/entry.js
 * Run podjs-runtime's reader-entry example with the bundle and app main.pak.
 * Timers obey the Android >=1ms contract.
 */
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {realpathSync} from 'node:fs';
import {memoPlainText} from '../../src/notes/text.ts';
const arg=(key:string,fallback:string)=>process.argv.find(v=>v.startsWith(`--${key}=`))?.slice(key.length+3)??fallback;
const framework=resolve(arg('framework','/home/wilf/data/PodJS/podjs-watch.wt-c-k19')),pocket=resolve(framework,'vendor/pocketjs');
const req=createRequire(resolve(pocket,'package.json')), {transformSync}=req('@babel/core'),t=req('@babel/types');
const out=resolve(arg('out','/tmp/reader-entry.js'));
const aliases:Record<string,string>={'@podjs/framework':resolve(framework,'packages/framework/src/index.ts'),'@pocketjs/framework':resolve(pocket,'framework/src/index.ts'),'solid-js':resolve(pocket,'node_modules/solid-js/dist/solid.js'),'solid-js/universal':resolve(pocket,'node_modules/solid-js/universal/dist/universal.js')};
for(const [root,prefix] of [[pocket,'@pocketjs/framework'],[resolve(framework,'packages/framework'),'@podjs/framework']]){
 for(const [key,v] of Object.entries((await Bun.file(resolve(root,'package.json')).json()).exports) as [string,any][]){const file=typeof v==='string'?v:v.import??v.default;if(key.startsWith('./'))aliases[prefix+'/'+key.slice(2)]=resolve(root,file);}
}
const names=new Set(['parseContent','layoutText','createContentLayouter','finishContentLayout','defaultReaderPreset','useReaderFonts','useReaderBackgrounds','ReaderBackground','ReaderBody','NoteDetailScreen','SystemTextLine','ReaderTextRow','createReaderTextEnvironment','createWindowRows','ScrollEntries','documentAnchorAt','offsetForDocumentAnchor','noteBlockSourceOffsets','noteMetadata','requiresSystemText','WatchRSS','ReaderScreenImpl','ReaderBodyImpl','mapArticle','setPage','captureActivityNavigationImpl']);
const wrap=(name:string,body:any)=>t.callExpression(t.memberExpression(t.identifier('__entryProfile'),t.identifier('time')),[t.stringLiteral(name),t.arrowFunctionExpression([],body)]);
const profile=(file:string)=>({visitor:{
 FunctionDeclaration(path:any){if(!path.node.generator&&!path.node.async&&names.has(path.node.id?.name))path.node.body=t.blockStatement([t.returnStatement(wrap(path.node.id.name,path.node.body))]);},
 NewExpression(path:any){if(path.node.callee?.name==='RegExp'&&file.endsWith('lazy-regexp.ts')){path.replaceWith(wrap('unicodeRegExpCompile',t.cloneNode(path.node)));path.skip();}},
 CallExpression(path:any){if(['createMemo','createEffect','onMount'].includes(path.node.callee?.name)&&/ReaderBody|NotesScreen|ScrollEntries|windowed-list/.test(file)){
  const fn=path.node.arguments[0];if(fn?.type==='ArrowFunctionExpression'&&!fn.async){fn.body=wrap(file.split('/').at(-1)+':'+(path.parentPath.node.id?.name??path.node.callee.name)+':'+path.node.loc.start.line,fn.body);path.skip();}
 }}
}});
const {solidConditionalProps}=await import(resolve(pocket,'framework/compiler/solid-props.ts'));
const literals=new Set<string>();
const result=await Bun.build({entrypoints:[resolve(arg('runner',resolve(import.meta.dir,'reader-entry-runner.tsx')))],target:'browser',format:'iife',conditions:['browser'],alias:aliases,outdir:dirname(out),naming:out.split('/').at(-1),plugins:[{name:'production-solid-entry-profile',setup(b){b.onResolve({filter:/.*/},args=>aliases[args.path]?{path:realpathSync(aliases[args.path])}:undefined);b.onLoad({filter:/\.(tsx|ts|js)$/},async({path})=>{
 if(!path.includes('/src/')&&!path.includes('reader-entry-runner')&&!path.includes('sql-turn-runner'))return;
 let source=await Bun.file(path).text();
 if(source.includes('/* SQL_LOADER */'))source=source.replace('/* SQL_LOADER */',await Bun.file(arg('sql-loader')).text());
 const appRoot=resolve(import.meta.dir,'../..'),appRef=arg('source-ref',''),frameworkRef=arg('framework-ref','');
 const ref=path.startsWith(appRoot+'/src/')?appRef:path===resolve(framework,'packages/framework/src/text-layout.ts')?frameworkRef:'';
 if(ref){const root=path.startsWith(appRoot+'/src/')?appRoot:framework;const before=Bun.spawnSync(['git','show',`${ref}:${path.slice(root.length+1)}`],{cwd:root});if(before.exitCode)throw Error(before.stderr.toString());source=before.stdout.toString();}
 if(path.endsWith('/NotesScreen.tsx'))source=source.replace('const task=prepareTextLayout(prepareNotePreviewSteps(',"const task=__entryProfile.job('note.parse',prepareTextLayout,prepareNotePreviewSteps(").replace('const task=prepareTextLayout(notePreviewEntrySteps(',"const task=__entryProfile.job('note.preview',prepareTextLayout,notePreviewEntrySteps(").replace('const bodyPrepare=prepareTextLayout(steps,',"const bodyPrepare=__entryProfile.job('note.nativeInput',prepareTextLayout,steps,").replace('const headerTask=requestReaderLayout(',"const headerTask=__entryProfile.job('note.header',requestReaderLayout,").replace('bodyTask=requestReaderLayoutBatched(',"bodyTask=__entryProfile.job('note.nativeBatches',requestReaderLayoutBatched,");
 if(path.endsWith('/text-layout.ts'))source=source.replace('const began=clock();','const began=clock(),wallBegan=__benchNow();').replace('const next=steps.next();',"const next=__entryProfile.time('layoutStep',()=>steps.next());").replace('options.onSlice?.(elapsed,count);',"options.onSlice?.(elapsed,count);const wallMs=__benchNow()-wallBegan;const phase=__entryProfile.stats.layoutSlice??={calls:0,ms:0,exclusiveMs:0,maxMs:0};phase.calls++;phase.ms+=wallMs;phase.exclusiveMs+=wallMs;phase.maxMs=Math.max(phase.maxMs,wallMs);").replace('callbacks.publish({layout:finished.value,entries,indices});',"__entryProfile.time('layoutPublish',()=>callbacks.publish({layout:finished.value,entries,indices}));");
 const stripped=/\.tsx?$/.test(path)?transformSync(source,{filename:path,babelrc:false,configFile:false,presets:[[req('@babel/preset-typescript'),{isTSX:path.endsWith('.tsx'),allExtensions:true}]]}).code:source;
 const compiled=transformSync(stripped,{filename:path,babelrc:false,configFile:false,plugins:[solidConditionalProps,()=>({visitor:{StringLiteral(p:any){literals.add(p.node.value);}}})],presets:path.endsWith('.tsx')?[[req('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}]]:[]}).code;
 return {loader:'js',contents:transformSync(compiled,{filename:path,babelrc:false,configFile:false,plugins:[profile(path)]}).code};
 });}}]});
if(!result.success)throw Error(result.logs.join('\n'));
const html=await Bun.file(arg('html','/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/.codex-tmp/k19-411.html')).text();
const note=await Bun.file(arg('note','/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/.codex-tmp/wrss-minor-rs1-readme.md')).text();
const {compileClasses}=await import(resolve(pocket,'framework/compiler/tailwind.ts'));const styles=compileClasses(literals);
const sqlFixture=arg('sql-fixture','');
const config={...(sqlFixture?await Bun.file(sqlFixture).json():{}),html,note,notePlain:memoPlainText(note),mode:arg('mode','reader'),nativeDelay:Number(arg('native-delay','16')),timerFloor:Number(arg('timer-floor','1')),savedProgress:Number(arg('progress','0')),cpuScale:Number(arg('cpu-scale','1'))};
await Bun.write(out,`globalThis.console={log(){},warn(...v){__benchPrint(JSON.stringify({warning:v}));},error(...v){__benchPrint(JSON.stringify({error:v}));},info(){},debug(){}};globalThis.__entryFixture=${JSON.stringify(config)};globalThis.__entryStyles=${JSON.stringify({ids:styles.ids,bin:[...styles.bin]})};
 globalThis.__entryProfile={stats:{},spans:[],stack:[],jobs:[],job(name,fn,...args){const record={name,startMs:__benchNow()};this.jobs.push(record);const work=fn(...args);work.done.then(()=>{record.endMs=__benchNow();if(work.stats)record.stats={...work.stats};});return work;},time(name,fn){const start=__benchNow(),frame={child:0};this.stack.push(frame);try{const value=fn();if(name.startsWith('ReaderBody.tsx:layout:'))globalThis.__entryLayout=value;return value;}finally{const ms=__benchNow()-start;this.stack.pop();if(this.stack.length)this.stack[this.stack.length-1].child+=ms;const s=this.stats[name]??={calls:0,ms:0,exclusiveMs:0,maxMs:0};s.calls++;s.ms+=ms;s.exclusiveMs+=ms-frame.child;s.maxMs=Math.max(s.maxMs,ms);if(ms>1)this.spans.push({name,start,ms});}}};\n`+await Bun.file(out).text());console.log(out);
