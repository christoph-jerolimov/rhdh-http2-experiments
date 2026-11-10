import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http2 from 'node:http2';
import * as tls from 'node:tls';
import { h2Session, startBackend } from './helpers.mjs';

// Short timeouts, so the tests don't have to wait long.
describe('Connection timeouts on the HTTP/2 backend', () => {
  let backend;

  before(async () => {
    backend = await startBackend({
      config: {
        backend: {
          server: { headersTimeout: 1000 },
          http2: { idleSessionTimeout: 500 },
        },
      },
    });
  });

  after(async () => {
    await backend?.stop();
  });

  // Node checks HTTP/1.1 header timeouts every 30 seconds and that interval
  // can't be changed on an HTTP/2 server, so this test takes ~30s.
  it('closes HTTP/1.1 connections that never finish their headers (slowloris)', { timeout: 45_000 }, async () => {
    const { port } = new URL(backend.url);
    const socket = tls.connect({ port, ca: backend.ca, servername: 'localhost', ALPNProtocols: ['http/1.1'] });
    socket.on('error', () => {});
    await new Promise(r => socket.once('secureConnect', r));
    assert.equal(socket.alpnProtocol, 'http/1.1');

    const start = Date.now();
    socket.write('GET /api/probe/info HTTP/1.1\r\nHost: localhost\r\n');
    // Keep the connection busy with one header line every 500 ms, so idle
    // timeouts never fire; only the headers timeout can end this.
    const trickle = setInterval(() => socket.write(`x-slow-${Date.now()}: 1\r\n`), 500);
    try {
      await new Promise(r => socket.once('close', r));
    } finally {
      clearInterval(trickle);
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 1000, `closed too early (${elapsed}ms)`);
  });

  it('closes idle HTTP/2 connections with GOAWAY', async () => {
    const h2 = h2Session(backend.url, backend.ca);
    assert.equal((await h2.request('/api/probe/info')).status, 200);
    const start = Date.now();
    const code = await new Promise(r => h2.session.once('goaway', r));
    assert.equal(code, http2.constants.NGHTTP2_NO_ERROR);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 400 && elapsed < 3000, `GOAWAY after ${elapsed}ms`);
    h2.close();
  });

  it('keeps connections with an open stream, even when the stream is quiet', async () => {
    const h2 = h2Session(backend.url, backend.ca);
    let goaway = false;
    h2.session.once('goaway', () => (goaway = true));
    // Two events 800 ms apart: longer silences than the 500 ms idle timeout.
    const res = await h2.request('/api/probe/events?count=2&interval=800');
    assert.equal(res.text, 'data: 1\n\ndata: 2\n\n');
    assert.equal(goaway, false);
    h2.close();
  });
});
