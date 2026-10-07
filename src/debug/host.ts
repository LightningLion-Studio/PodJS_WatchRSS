import {enableDebugLogBuffer} from './log-buffer.ts';
import {application} from '@podjs/framework/services';
import {installDebugMemoryStats} from '@podjs/framework/debug-memory';
import {DebugGate} from './gate.ts';
export const debugGate=new DebugGate();
export const initializeDebugBuild=()=>debugGate.initialize(()=>application.buildInfo()).then(enabled=>{enableDebugLogBuffer(enabled);if(enabled)installDebugMemoryStats();return enabled;});
