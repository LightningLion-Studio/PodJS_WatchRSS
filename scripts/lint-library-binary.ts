/** Scoped unused-symbol/type lint for the new pure B2 core and its tests.
 * Existing app-wide types remain covered by `bun run typecheck`.
 */
import ts from 'typescript';
import {resolve} from 'node:path';
const root=resolve(import.meta.dir,'..'),config=ts.readConfigFile(resolve(root,'tsconfig.json'),ts.sys.readFile);
if(config.error)throw Error(ts.flattenDiagnosticMessageText(config.error.messageText,'\n'));
const parsed=ts.parseJsonConfigFileContent({...config.config,include:['src/sync/library-binary/**/*.ts','tests/library-binary/**/*.ts']},ts.sys,root);
const program=ts.createProgram(parsed.fileNames,{...parsed.options,noUnusedLocals:true,noUnusedParameters:true});
const owned=(path:string)=>path.startsWith(resolve(root,'src/sync/library-binary')+'/')||path.startsWith(resolve(root,'tests/library-binary')+'/');
const diagnostics=ts.getPreEmitDiagnostics(program).filter(d=>!d.file||owned(d.file.fileName));
if(diagnostics.length){console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>root,getCanonicalFileName:f=>f,getNewLine:()=> '\n'}));process.exitCode=1;}
else console.log(`B2 lint PASS (${parsed.fileNames.length} TypeScript files; types and unused symbols).`);
