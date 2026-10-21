import {createCloudTransport} from '../cloud/transport';
import {WatchCloudClient} from '../cloud/client';
import type {HttpTransport} from '../cloud/types';
import {bytesToBase64,base64ToBytes} from '@podjs/framework/bytes';
import {utf8Encode} from '../cloud/types';
import type {CloudHostRequest} from '../cloud/host-ports';
import type {WatchAccountState} from './types';
/** Works during logout in release too; it never enables the cloud runtime. */
export async function clearAccountCloud(host:CloudHostRequest,account:Pick<WatchAccountState,'userId'|'backendBaseUrl'>){
 const base=account.backendBaseUrl.replace(/\/+$/,''),scope=JSON.stringify([base,account.userId]);
 const hash=async(value:string)=>Array.from(base64ToBytes((await host<{digestBase64:string}>('crypto.hash',{dataBase64:bytesToBase64(utf8Encode(value))})).digestBase64),v=>v.toString(16).padStart(2,'0')).join('');
 const scoped=await hash(scope),legacy=await hash(account.userId);
 await host('secure.update',{values:{},removePrefixes:[`watchrss.cloud.epoch.${scope}`,`watchrss.cloud.keys.${scoped}.`,`watchrss.cloud.keys.${legacy}`,`watchrss.cloud.state.${scope.slice(0,-1)},`,`watchrss.cloud.state.${JSON.stringify([account.userId]).slice(0,-1)},`]});
 const clear=async(path:string)=>{const {entries}=await host<{entries:{path:string;directory:boolean}[]}>('file.list',{path});for(const e of entries){if(!e.path.startsWith(path+'/'))throw Error('invalid_cleanup_path');if(e.directory)await clear(e.path);else await host('file.delete',{path:e.path});}};
 await clear(`watch-cloud-cache/${scoped.slice(0,32)}`);await clear(`watch-cloud-cache/${legacy.slice(0,32)}`);
}

/** Logout first attempts remote revocation, with a bounded transport; caller always continues local cleanup. */
export async function revokeAccountCloud(host:CloudHostRequest,account:WatchAccountState,http?:HttpTransport){
 const rows=await host<{device_id:string}[]>('sql.query',{sql:'SELECT device_id FROM sync_local_identity WHERE id=1',params:[]});const deviceId=rows[0]?.device_id;if(!deviceId)return;
 const guard={require(){}},transport=http??createCloudTransport(host,guard,{callTimeoutMs:5000});
 const client=new WatchCloudClient(transport,{baseUrl:account.backendBaseUrl,accessToken:account.watchDeviceToken},{sha256:async()=>{throw Error('unused');}},guard);
 const bootstrap=await client.bootstrap();if(!bootstrap.libraryEpoch)throw Error('client_upgrade_required');client.setEpoch(bootstrap.libraryEpoch);await client.revokeDevice(deviceId);
}
