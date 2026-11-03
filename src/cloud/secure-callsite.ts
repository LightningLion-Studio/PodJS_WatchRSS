/** Closed numeric provenance; never send store keys or values to diagnostics. */
export function secureCallsite(method:string,args:Record<string,unknown>):Record<string,unknown>{
 if(!method.startsWith('secure.')&&!['crypto.ecdhPublicKey','crypto.ecdhUnwrap','crypto.ecdhPossessionProof'].includes(method))return args;
 const key=typeof args.key==='string'?args.key:undefined;
 const category=(name:string)=>name==='state_json'||name==='watchrss.library.owner'?1:name==='watchrss.cloud.manual.v1'?2:name.startsWith('watchrss.cloud.keys.')?3:name.startsWith('watchrss.cloud.state.')&&name.includes('.restore-')?4:name.startsWith('watchrss.cloud.')?5:0;
 const sites=key?[category(key)]:args.values&&typeof args.values==='object'?Object.keys(args.values).map(category):[];
 const secureSite=method.startsWith('crypto.ecdh')?6:sites.length&&sites.every(n=>n===sites[0])?sites[0]:0;
 return {...args,secureSite};
}
