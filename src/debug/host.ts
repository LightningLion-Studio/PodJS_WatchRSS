import {enableDebugLogBuffer} from './log-buffer.ts';
import {application} from '@podjs/framework/services';
import {installDebugMemoryStats} from '@podjs/framework/debug-memory';
import {debugGate} from './gate.ts';
export {debugGate} from './gate.ts';
export const initializeDebugBuild=()=>debugGate.initialize(()=>application.buildInfo()).then(enabled=>{enableDebugLogBuffer(enabled);if(enabled)installDebugMemoryStats();return enabled;});
