import {test,expect} from 'bun:test';
import {once} from 'node:events';
import {pairedLoopback} from './paired-loopback';

test('foreign HTTP, bad tokens and stalled clients cannot consume a loopback pairing',async()=>{
 const server=await pairedLoopback();
 try {
  const token='a'.repeat(64),accepted=server.accept(token);
  const idle=server.dial();await once(idle,'connect');
  const http=server.dial();await once(http,'connect');
  const httpClosed=once(http,'close');http.write('GET / HTTP/1.1\r\n\r\n');await httpClosed;
  const wrong=await server.client('b'.repeat(64));await once(wrong,'close');
  const socket=await server.client(token),remote=await accepted;
  expect(remote.remotePort).toBe(socket.localPort);expect(remote.localPort).toBe(socket.remotePort);
  expect(remote.isPaused()).toBe(true);
  const received=once(remote,'data');remote.resume();socket.write('paired payload');
  expect(String((await received)[0])).toBe('paired payload');
  // A valid pair still works after the previous token has been consumed.
  const next=await server.pair();expect(next.remote.remotePort).toBe(next.socket.localPort);
 } finally {await server.close();}
});

test('fragmented handshake preserves coalesced frame bytes',async()=>{
 const server=await pairedLoopback();
 try {
  const token='c'.repeat(64),accepted=server.accept(token),socket=server.dial();
  await once(socket,'connect');socket.write('WRSS-');socket.write('LOOPBACK-1 '+token.slice(0,32));
  socket.write(token.slice(32)+'\nframe');const remote=await accepted;
  const received=once(remote,'data');remote.resume();expect(String((await received)[0])).toBe('frame');
 } finally {await server.close();}
});
