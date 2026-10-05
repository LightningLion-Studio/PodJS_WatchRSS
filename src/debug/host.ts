import {application} from '@podjs/framework/services';
import {DebugGate} from './gate.ts';
export const debugGate=new DebugGate();
export const initializeDebugBuild=()=>debugGate.initialize(()=>application.buildInfo());
