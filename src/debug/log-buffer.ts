import {BoundedLineBuffer} from '@podjs/framework/logging';
let enabled=false;
export function enableDebugLogBuffer(value:boolean){enabled=value;}
function requireDebug(){if(!enabled)throw Error('Debug tools unavailable in this build');}
// Bounded, already-redacted log lines from the existing logger output port.
const buffer=new BoundedLineBuffer({maxLineChars:4096,maxChars:50000,maxLines:400});
export const debugLogBuffer={
 append(line:string){if(!enabled)return;buffer.append(line);},
 dump(){requireDebug();return `DebugLogBuffer size=${buffer.size} max=400\n`+buffer.dump();},
 clear(){requireDebug();buffer.clear();},
};
