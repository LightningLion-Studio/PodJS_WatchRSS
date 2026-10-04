import {rfcomm,byteStreams} from '@podjs/framework/services';
import type {LibrarySessionRepository} from './session.ts';
import {RfcommLibraryListener} from './rfcomm.ts';
export function createRfcommLibraryListener(repository:LibrarySessionRepository){return new RfcommLibraryListener(repository,{radio:rfcomm,streams:byteStreams});}
