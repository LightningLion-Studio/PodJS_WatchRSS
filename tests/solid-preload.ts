// Bun 1.4 lowers jsx:preserve as automatic JSX, while Solid requires its compiler.
// Compile application TSX for host tests using Solid's universal component calls.
import {plugin} from 'bun';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
plugin({name:'watchrss-solid-tests',setup(builder){builder.onLoad({filter:/\/(?:src\/ui|tests\/fixtures)\/.*\.tsx$/},async({path})=>({loader:'js',contents:require('@babel/core').transformSync(await Bun.file(path).text(),{filename:path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'solid-js'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code.replace(/import \{ memo as /g,'import { createMemo as ')}));}});
