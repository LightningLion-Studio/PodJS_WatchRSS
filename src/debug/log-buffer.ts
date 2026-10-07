let enabled=false;
export function enableDebugLogBuffer(value:boolean){enabled=value;}
function requireDebug(){if(!enabled)throw Error('Debug tools unavailable in this build');}
// Bounded, already-redacted log lines from the existing logger output port.
let lines:string[]=[],chars=0;
export const debugLogBuffer={
 append(line:string){if(!enabled)return;const value=line.slice(-4096);lines.push(value);chars+=value.length;while(chars>50000||lines.length>400)chars-=lines.shift()!.length;},
 dump(){requireDebug();return `DebugLogBuffer size=${lines.length} max=400\n`+lines.join('\n');},
 clear(){requireDebug();lines=[];chars=0;},
};
