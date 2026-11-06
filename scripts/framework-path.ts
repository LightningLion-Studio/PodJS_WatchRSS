import {resolve} from 'node:path';
import frameworkLock from '../framework.lock.json';

// Resolve relative paths against the app, independent of the caller's cwd.
export const frameworkRoot=resolve(import.meta.dir,'..',frameworkLock.path);

if(import.meta.main)console.log(frameworkRoot);
