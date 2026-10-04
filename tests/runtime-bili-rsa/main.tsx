import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {rsaOaepSha256,bytesToBase64,base64ToBytes} from '@podjs/framework/services';
const pem='-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwwoNdkpmxO4a+GcWzbpn\nwGkjKXHa51xabithrfI6abn3EOPYAAxvqbPRjCd9u9ndnoY3aJD+sGPPwEhvRd03\n4VbPUr+nhymBR3ZmGne/FlSKpY2+twqCuezPcIsJ8YhFy3xXt+RMJRi9n+QBx8Vf\nIVXQajQm4aR1WH1U+dKmNa3Mi4V3vKHa7Eplvcd7eEQJj0GX8A/FMsHWGrz9UslH\nKFrxNtgdtcypCVsKg8pJnIkYtlSUDbmVQnBm1TpfCp40B5EtRy0fmPtTIpzsfWdt\nrI2dcmK0Mpp+VK+1S0WgPL2LSKC877a6mziH0OVPgJrrFEJuiPIH/JdwViDQWXSB\nnQIDAQAB\n-----END PUBLIC KEY-----\n';
const key='bili-rsa-host-result';
async function run(){
 const plaintext=new Uint8Array([114,101,102,114,101,115,104,95,49,55,48,48,48,48,48,48,48,48,49,50,51]);
 const result=await rsaOaepSha256(pem,bytesToBase64(plaintext)).result;
 const ciphertext=base64ToBytes(result.ciphertextBase64);
 if(ciphertext.length!==256)throw new Error('Expected a 2048-bit RSA ciphertext');
 kv.set(key,{state:'passed',ciphertextBase64:result.ciphertextBase64,byteCount:ciphertext.length});
}
mount(()=><Text>Bili RSA host verification</Text>);
void run().catch(error=>kv.set(key,{state:'failed',error:String(error)}));
