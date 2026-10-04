import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {acquireIpDescriptor,IP_BLE_DISCOVERY} from '../../src/sync/ip-discovery.ts';
import {Clock,deferred,flush} from '../helpers/ip-fixture.ts';
import type {discovery} from '@podjs/framework/services';
const granted={available:true,enabled:true,permission:'granted' as const};
const payload=(value:unknown,bonded=true)=>({address:'test-peer',bonded,dataBase64:Buffer.from(JSON.stringify(value)).toString('base64')});
const operation=<T>(value:T)=>({result:Promise.resolve(value),cancel:()=>{}});
test('BLE request matches native UUIDs, debounces, and decodes the descriptor',async()=>{
 const source=readFileSync(new URL('../../../Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/phoneconnection/ip/IpSyncProtocol.kt',import.meta.url),'utf8');
 for(const [field,name] of [['advertisedServiceUuid','ADVERTISED_BLE_SERVICE_UUID'],['serviceUuid','BLE_DISCOVERY_SERVICE_UUID'],['characteristicUuid','BLE_ENDPOINT_CHARACTERISTIC_UUID']] as const){const match=source.match(new RegExp('val '+name+': UUID =\\s*UUID.fromString\\("([^"]+)"\\)'));expect(match).not.toBeNull();expect(String(IP_BLE_DISCOVERY[field])).toBe(match![1]!);}
 const clock=new Clock();let checks=0,scans=0;const descriptor={v:2,id:'配对手机'};
 const radio:Pick<typeof discovery,'status'|'bleReadCharacteristic'>={status:async()=>{checks++;return granted;},bleReadCharacteristic:options=>{scans++;expect(options.bondedOnly).toBe(true);expect(options.manufacturerId).toBe(65535);expect(Buffer.from(options.manufacturerDataBase64,'base64').toString()).toBe('WRS3');return operation(payload(descriptor));}};
 const op=acquireIpDescriptor(radio,clock.delay);await clock.advance(349);expect(checks).toBe(0);await clock.advance(1);await expect(op.result).resolves.toEqual(descriptor);expect(checks).toBe(1);expect(scans).toBe(1);
});
test('missing discovery permission retains the Bluetooth fallback without scanning',async()=>{
 const clock=new Clock();let scans=0;const op=acquireIpDescriptor({status:async()=>({...granted,permission:'required'}),bleReadCharacteristic:()=>{scans++;return operation(payload({}));}},clock.delay);await clock.advance(350);await expect(op.result).resolves.toBeNull();expect(scans).toBe(0);
});
test('cancellation propagates through debounce and the pending BLE read',async()=>{
 for(const scanning of [false,true]){const clock=new Clock(),read=deferred<ReturnType<typeof payload>>();let checks=0,cancelled=false;const op=acquireIpDescriptor({status:async()=>{checks++;return granted;},bleReadCharacteristic:()=>({result:read.result,cancel:()=>{cancelled=true;read.reject(new Error('scan cancelled'));}})},clock.delay);if(scanning)await clock.advance(350);op.cancel();await expect(op.result).rejects.toThrow();expect(checks).toBe(scanning?1:0);expect(cancelled).toBe(scanning);}
});
test('unbonded results and invalid descriptor shapes are rejected',async()=>{
 for(const value of [payload({},false),payload([]),payload('string')]){const clock=new Clock(),op=acquireIpDescriptor({status:async()=>granted,bleReadCharacteristic:()=>operation(value)},clock.delay);await clock.advance(350);await expect(op.result).rejects.toThrow();}
});
