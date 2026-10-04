import {sharing} from '@podjs/framework/services';
import {hasCapability} from '@podjs/framework/watch';
import {systemShareSupported} from './policy.ts';
export async function supportsSystemShare():Promise<boolean>{return hasCapability('system.share')?systemShareSupported(await sharing.environment()):false;}
export function openSystemShare(text:string):Promise<void>{return sharing.text(text,'分享').result;}
