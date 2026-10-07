/** Build a standalone, instrumented copy; production sources are not patched.
 * bun scripts/bench/reader-scroll.ts --framework=... --out=.../baseline.js
 * bun baseline.js --html=... --timing=... --out=.../baseline.json
 */
import {createRequire} from "node:module";
import {resolve, dirname} from "node:path";
import {realpathSync} from "node:fs";
const arg=(name:string,fallback:string)=>process.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const framework=resolve(arg("framework","/home/wilf/data/PodJS/podjs-watch.wt-c"));
const pocket=resolve(framework,"vendor/pocketjs");
const require=createRequire(resolve(pocket,"package.json"));
const {transformSync}=require("@babel/core"),t=require("@babel/types");
const profile=(name:string,body:any)=>t.callExpression(t.memberExpression(t.memberExpression(t.identifier("globalThis"),t.identifier("__readerProfile")),t.identifier("time")),[t.stringLiteral(name),t.arrowFunctionExpression([],body)]);
const count=(name:string)=>t.expressionStatement(t.callExpression(t.memberExpression(t.memberExpression(t.identifier("globalThis"),t.identifier("__readerProfile")),t.identifier("count")),[t.stringLiteral(name)]));
const instrument=()=>({visitor:{
 FunctionDeclaration(path:any){
  if(path.node.id?.name==="ReaderTextRow")path.node.body=t.blockStatement([t.returnStatement(profile("readerTextRow",path.node.body))]);
  if(path.node.id?.name==="SystemTextLine")path.node.body=t.blockStatement([t.returnStatement(profile("systemTextLine",path.node.body))]);
 },
 VariableDeclarator(path:any){
  if(path.node.id?.name==="visible"&&path.node.init?.type==="CallExpression"){
   const fn=path.node.init.arguments[0];if(fn?.type==="ArrowFunctionExpression")fn.body=profile("visible",fn.body);
  }
  if(path.node.id?.name==="setter"&&path.getFunctionParent()?.node.id?.name==="createSignal"){
   const fn=path.node.init;if(fn?.body?.type==="BlockStatement")fn.body.body.unshift(count("signalWrites"));
  }
 },
 ReturnStatement(path:any){
  if(path.getFunctionParent()?.node.id?.name!=="mapArray"||path.node.argument?.type!=="ArrowFunctionExpression")return;
  const fn=path.node.argument;fn.body=profile("forDiff",fn.body);
 },
 CallExpression(path:any){
  if(path.node.callee?.type==="MemberExpression"&&path.node.callee.property?.name==="render"&&path.node.callee.object?.name==="row"){
   const original=t.cloneNode(path.node);path.replaceWith(profile("rowMount",original));path.skip();
  }
  if(path.node.callee?.name==="onCleanup"&&path.node.arguments[0]?.type==="ArrowFunctionExpression"){
   const fn=path.node.arguments[0];fn.body=profile("cleanup",fn.body);path.skip();
  }
 },
}});
const aliases:Record<string,string>={
 "solid-js":resolve(pocket,"node_modules/solid-js/dist/solid.js"),
 "solid-js/universal":resolve(pocket,"node_modules/solid-js/universal/dist/universal.js"),
 "@pocketjs/framework":resolve(pocket,"framework/src/index.ts"),
 "@podjs/framework":resolve(framework,"packages/framework/src/index.ts"),
};
const pkg=await Bun.file(resolve(pocket,"package.json")).json();
for(const [key,value] of Object.entries(pkg.exports) as [string,any][]){
 if(!key.startsWith("./"))continue;
 const file=typeof value==="string"?value:value.import??value.default;
 if(typeof file==="string")aliases[`@pocketjs/framework/${key.slice(2)}`]=resolve(pocket,file);
}
for(const name of ["watch","services","text","media-surface","debug-memory"])aliases[`@podjs/framework/${name}`]=resolve(framework,`packages/framework/src/${name}.${["text","media-surface"].includes(name)?"tsx":"ts"}`);
const {solidConditionalProps}=await import(resolve(pocket,"framework/compiler/solid-props.ts"));
const classLiterals=new Set<string>();
const native=arg("runtime","bun")==="quickjs";
const output=resolve(arg("out",native?"/tmp/reader-memory.js":"/tmp/reader-scroll.js"));
const sourceRef=arg("source-ref","");
const retainRows=arg("retain-rows","");
const appRoot=resolve(import.meta.dir,"../..");
const built=await Bun.build({entrypoints:[resolve(import.meta.dir,native?"reader-memory-runner.tsx":"reader-scroll-runner.ts")],outdir:dirname(output),naming:output.split("/").at(-1),target:native?"browser":"bun",format:native?"iife":"esm",conditions:["browser"],alias:aliases,minify:false,plugins:[{name:"reader-scroll-production-solid",setup(builder){
 builder.onResolve({filter:/.*/},args=>aliases[args.path]?{path:realpathSync(aliases[args.path])}:undefined);
 builder.onLoad({filter:/\.(tsx|ts|js)$/},async args=>{
  if(!args.path.includes("/src/")&&!args.path.endsWith("/solid.js")&&!(native&&args.path===resolve(import.meta.dir,"reader-memory-runner.tsx")))return;
  let source=await Bun.file(args.path).text();
  if(sourceRef&&["ScrollEntries.tsx","ReaderBody.tsx"].some(name=>args.path===resolve(appRoot,"src/ui",name))){
   const original=Bun.spawnSync(["git","show",`${sourceRef}:src/ui/${args.path.split("/").at(-1)}`],{cwd:appRoot});
   if(original.exitCode!==0)throw new Error(original.stderr.toString());source=original.stdout.toString();
  }
  if(retainRows&&args.path===resolve(appRoot,"src/ui/ReaderBody.tsx")){
   if(!/^\d+$/.test(retainRows))throw new Error("retain-rows must be a nonnegative integer");
   source=source.replace("retainRows={24}",`retainRows={${retainRows}}`);
  }
  if(native&&args.path===resolve(appRoot,"src/ui/ReaderBody.tsx"))source=source.replace("props.ref(handle);","props.ref(handle); globalThis.__readerHandle = handle;");
  if(!native&&args.path.endsWith("/frame.ts"))source=source.replace("callbacks.add(callback);",`const wrapped = (buttons: number) => { globalThis.__readerProfile.count("onFrameCallbacks"); return globalThis.__readerProfile.time("onFrame", () => callback(buttons)); }; callbacks.add(wrapped);`).replace("callbacks.delete(callback)","callbacks.delete(wrapped)");
  const isTs=/\.tsx?$/.test(args.path);
  // Strip types before the profiler moves bodies into wrapper functions.
  // Otherwise copied non-null assertions can escape the TypeScript visitor.
  const stripped=isTs?transformSync(source,{filename:args.path,babelrc:false,configFile:false,presets:[[require("@babel/preset-typescript"),{isTSX:args.path.endsWith(".tsx"),allExtensions:true}]]}).code:source;
  const result=transformSync(stripped,{filename:args.path,babelrc:false,configFile:false,plugins:[...(arg("conditional-memos","0")==="1"?[]:[solidConditionalProps]),...(native?[()=>({visitor:{StringLiteral(path:any){classLiterals.add(path.node.value);}}})]:[instrument])],presets:[...(args.path.endsWith(".tsx")?[[require("babel-preset-solid"),{generate:"universal",moduleName:"@pocketjs/framework/renderer"}]]:[])]});
  return {contents:result.code,loader:"js"};
 });
}}]});
if(!built.success)throw new Error(built.logs.join("\n"));
if(native){
 const {compileClasses}=await import(resolve(pocket,"framework/compiler/tailwind.ts"));
 const styles=compileClasses(classLiterals);
 const source=await Bun.file(output).text();
 await Bun.write(output,`globalThis.__readerStyles=${JSON.stringify({ids:styles.ids,bin:[...styles.bin]})};\n${source}`);
}
console.log(`Built ${native?"QuickJS ownership":"instrumented Bun"} ReaderBody/PocketJS/Solid/SystemTextLine: ${output}`);
