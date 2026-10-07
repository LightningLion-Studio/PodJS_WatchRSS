import {waitForFlush,ExitFlushGuard,type FlushOutcome,type FlushTimerFactory} from '@podjs/framework/async';
export type {FlushTimer as ReaderExitTimer,FlushTimerFactory as ReaderExitTimerFactory,FlushOutcome as ReaderProgressFlushOutcome} from '@podjs/framework/async';
export const READER_EXIT_FLUSH_TIMEOUT_MS=2_500;
/** Native failure still allows Back. Keep the app's 2.5s final-progress budget. */
export function waitForReaderProgressFlush(flush:()=>Promise<void>,timerFactory:FlushTimerFactory,timeoutMs=READER_EXIT_FLUSH_TIMEOUT_MS):Promise<FlushOutcome>{return waitForFlush(flush,timerFactory,timeoutMs);}
export class ReaderExitGuard<T extends object> extends ExitFlushGuard<T>{
 constructor(timerFactory:FlushTimerFactory,timeoutMs=READER_EXIT_FLUSH_TIMEOUT_MS){super(timerFactory,timeoutMs);}
}
