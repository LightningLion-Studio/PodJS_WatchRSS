import {expect, test} from 'bun:test';

test('host adapter uses real bounded GET download contract and explicitly lacks APK services', () => {
  // Isolate module mocks from the rest of the suite; never contact a server.
  const result = Bun.spawnSync(['bun', '--eval', `
    import {mock} from 'bun:test';
    import {strict as assert} from 'node:assert';
    const calls = [], removed = [];
    let body = Buffer.from('{"version":"2"}');
    mock.module('@podjs/framework/watch', () => ({kv: {get(){},set(){}}, hasCapability: () => true}));
    mock.module('@podjs/framework/services', () => ({
      hostOperation(method,args) {
        calls.push({method,args});
        assert.equal(method, 'http.download');
        assert.equal(args.method, 'GET');
        assert(args.maxBytes <= 64*1024*1024);
        return {result:Promise.resolve({status:200,headers:{},url:args.url,path:args.path,size:body.length})};
      },
      fileChunks: {
        async read(){ return {dataBase64:body.toString('base64'),size:body.length}; },
        async remove(path){removed.push(path);}
      },
      base64ToBytes: value => new Uint8Array(Buffer.from(value,'base64')),
    }));
    const {announcementTransport,createHostUpdatePort,createAnnouncementServices} = await import('./src/announcement/host.ts');
    const response = await announcementTransport.request({method:'GET',url:'https://example.test/a',headers:{'X-WatchRSS-App-Version':'watch-1+1'}});
    assert.equal(Buffer.from(response.body).toString(), body.toString());
    assert.equal(calls[0].args.timeoutMs, 5000);
    assert.equal(calls[0].args.readTimeoutMs, 5000);
    assert.equal(calls[0].args.headers['X-WatchRSS-App-Version'], 'watch-1+1');
    assert.equal(removed.length, 1);
    await assert.rejects(announcementTransport.request({method:'POST',url:'https://example.test/a',headers:{}}));
    const port = createHostUpdatePort();
    assert.deepEqual(port.capabilities,{download:true,progress:false,inspectApk:false,installApk:false});
    await assert.rejects(port.inspectApk('x'),{code:'unsupported'});
    await assert.rejects(port.launchInstaller('x'),{code:'unsupported'});
    const before = calls.length;
    assert.equal((await createAnnouncementServices().updater.download('https://example.test/a.apk')).code,'unsupported');
    assert.equal(calls.length,before);
    const progress = [];
    await port.download('https://example.test/a.apk',value=>progress.push(value));
    assert.equal(calls.at(-1).args.readTimeoutMs,60000);
    assert.equal(progress.length,1); // Only genuine completion, no fabricated intermediate progress.
    assert.equal(progress[0].bytesRead,body.length);
  `], {cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe'});
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
});
