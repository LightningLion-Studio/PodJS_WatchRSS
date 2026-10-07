/** Collect existing HTML fixture literals plus explicit local captures. Outputs
 * private content only to --out; never checks captured articles into git. */
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
const arg=(key:string,fallback:string)=>process.argv.find(v=>v.startsWith(`--${key}=`))?.slice(key.length+3)??fallback;
const framework=resolve(arg('framework','/home/wilf/data/PodJS/podjs-watch.wt-minor-rs1'));
const parser=createRequire(resolve(framework,'vendor/pocketjs/package.json'))('@babel/parser');
const root=resolve(import.meta.dir,'../..'),fixtures:{name:string;html:string}[]=[],seen=new Set<string>();
const add=(name:string,value:unknown)=>{if(typeof value==='string'&&/<\s*\/?\s*[a-z][\w:-]*\b/i.test(value)&&!seen.has(value)){seen.add(value);fixtures.push({name,html:value});}};
const walk=(value:any,path:string)=>{if(typeof value==='string'){add(path,value);return;}if(value&&typeof value==='object')for(const [key,next] of Object.entries(value))walk(next,path+'.'+key);};
for(const path of [...new Bun.Glob('tests/**/*.{json,ts,tsx,html}').scanSync({cwd:root})].sort()){
 const source=await Bun.file(resolve(root,path)).text();
 if(path.endsWith('.json'))walk(JSON.parse(source),path);
 else if(path.endsWith('.html'))add(path,source);
 else {
  const ast=parser.parse(source,{sourceType:'module',plugins:['typescript','jsx']});
  const visit=(node:any)=>{if(!node||typeof node!=='object')return;if(node.type==='StringLiteral')add(path+':'+node.loc.start.line,node.value);if(node.type==='TemplateLiteral'&&!node.expressions.length)add(path+':'+node.loc.start.line,node.quasis[0].value.cooked);for(const [key,next] of Object.entries(node))if(!['loc','start','end','extra'].includes(key)){if(Array.isArray(next))next.forEach(visit);else visit(next);}};visit(ast);
 }
}
for(const [name,path] of [['411',arg('411',root.replace('.wt-minor-rs1','')+'/.codex-tmp/k19-411.html')],['407',arg('407',root.replace('.wt-minor-rs1','')+'/.codex-tmp/k9-profile/article.html')]]){fixtures.push({name,html:await Bun.file(path).text()});}
const aliases:Record<string,string>={};
for(const [key,file] of Object.entries((await Bun.file(resolve(framework,'packages/framework/package.json')).json()).exports) as [string,string][]){if(key.startsWith('./'))aliases['@podjs/framework/'+key.slice(2)]=resolve(framework,'packages/framework',file);}
const out=resolve(arg('out',root.replace('.wt-minor-rs1','')+'/.codex-tmp/wrss-minor-rs2-html.js'));
const result=await Bun.build({entrypoints:[resolve(import.meta.dir,'html-fragment-runner.ts')],target:'browser',format:'iife',alias:aliases,outdir:dirname(out),naming:out.split('/').at(-1)});if(!result.success)throw Error(result.logs.join('\n'));
await Bun.write(out,`globalThis.__htmlFixtures=${JSON.stringify(fixtures)};\n`+await Bun.file(out).text());console.log(JSON.stringify({out,fixtures:fixtures.length,fixtureNames:fixtures.map(f=>f.name)}));
