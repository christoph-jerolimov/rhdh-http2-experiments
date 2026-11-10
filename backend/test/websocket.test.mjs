import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { h1Request, h2Session, startBackend } from './helpers.mjs';

// WebSockets need the HTTP/1.1 Upgrade mechanism, which HTTP/2 doesn't have.
// RFC 8441 adds WebSockets over HTTP/2 via extended CONNECT, but only if the
// server advertises SETTINGS_ENABLE_CONNECT_PROTOCOL. Node's HTTP/2 server
// doesn't by default, so clients open a separate HTTP/1.1 connection for the
// WebSocket. These tests check that this works next to HTTP/2 traffic, using
// the signals plugin (Backstage's WebSocket push channel).

async function guestToken(h2) {
  const res = await h2.request('/api/auth/guest/refresh', {
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  });
  assert.equal(res.status, 200);
  return res.json.backstageIdentity.token;
}

/** Opens a WebSocket; resolves with { ws } on open or { status } on rejection. */
function connect(backend, path, protocols) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(backend.url.replace('https:', 'wss:') + path, protocols, {
      ca: backend.ca,
    });
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    ws.once('error', reject);
  });
}

function nextMessage(ws, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no WebSocket message')), timeout);
    ws.once('message', data => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

async function publish(h2, channel, message) {
  const res = await h2.request('/api/probe/signal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, message }),
  });
  assert.equal(res.status, 202);
}

describe('WebSockets on the HTTP/2 backend', () => {
  let backend, h2, token;

  before(async () => {
    backend = await startBackend();
    h2 = h2Session(backend.url, backend.ca);
    token = await guestToken(h2);
  });

  after(async () => {
    h2?.close();
    await backend?.stop();
  });

  // Keep this test first: it relies on no request having reached the signals
  // plugin yet.
  it('rejects the very first upgrade, like stock Backstage does', async () => {
    // The signals plugin only subscribes to the server's 'upgrade' event
    // when the first ordinary request passes through its router. Until then
    // Node treats the upgrade as a normal request, which ends in a 404.
    // Stock Backstage on HTTP/1.1 behaves the same; the frontend retries.
    const { status } = await connect(backend, '/api/signals', [token]);
    assert.equal(status, 404);
  });

  it('does not offer WebSockets over HTTP/2 (RFC 8441)', async () => {
    await h2.request('/api/signals/health');
    assert.equal(h2.remoteSettings().enableConnectProtocol, false);
  });

  it('subscribes the signals plugin to upgrades from an HTTP/2 request', async () => {
    // The plugin finds the server through req.socket.server. Over HTTP/2,
    // req.socket is a proxy for the TLS socket, and that still works.
    const res = await h2.request('/api/signals/health');
    assert.equal(res.status, 200);
    assert.equal(res.protocol, 'h2');

    const { ws, status } = await connect(backend, '/api/signals', [token]);
    assert.equal(status, undefined, `upgrade rejected with ${status}`);
    ws.close();
  });

  it('delivers a signal published over HTTP/2 to the WebSocket', async () => {
    const { ws } = await connect(backend, '/api/signals', [token]);
    ws.send(JSON.stringify({ action: 'subscribe', channel: 'probe' }));
    // Give the server a moment to process the subscription.
    await new Promise(r => setTimeout(r, 100));

    const received = nextMessage(ws);
    await publish(h2, 'probe', { hello: 'over h2' });
    assert.deepEqual(await received, { channel: 'probe', message: { hello: 'over h2' } });
    ws.close();
  });

  it('rejects upgrades without a valid token', async () => {
    assert.equal((await connect(backend, '/api/signals', ['not-a-token'])).status, 401);
  });

  it('keeps HTTP/1.1 and HTTP/2 requests working while WebSockets are open', async () => {
    const sockets = await Promise.all(
      Array.from({ length: 5 }, () => connect(backend, '/api/signals', [token])),
    );
    const [r2, r1] = await Promise.all([
      h2.request('/api/probe/info'),
      h1Request(backend.url, '/api/probe/info', { ca: backend.ca }),
    ]);
    assert.equal(r2.json.httpVersion, '2.0');
    assert.equal(r1.json.httpVersion, '1.1');
    sockets.forEach(({ ws }) => ws.close());
  });

  it('works from Chromium: page over h2, WebSocket alongside', async t => {
    let chromium;
    try {
      ({ chromium } = createRequire(import.meta.url)('playwright'));
    } catch {
      t.skip('playwright is not installed');
      return;
    }
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      await page.goto(`${backend.url}/api/probe/info`);
      const pageProtocol = await page.evaluate(
        () => performance.getEntriesByType('navigation')[0].nextHopProtocol,
      );
      assert.equal(pageProtocol, 'h2');

      const received = page.evaluate(
        token =>
          new Promise((resolve, reject) => {
            const ws = new WebSocket(`wss://${location.host}/api/signals`, [token]);
            ws.onopen = () => {
              ws.send(JSON.stringify({ action: 'subscribe', channel: 'browser' }));
              // Ask the page to publish over its HTTP/2 connection.
              setTimeout(() => {
                fetch('/api/probe/signal', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ channel: 'browser', message: { from: 'chromium' } }),
                });
              }, 100);
            };
            ws.onmessage = e => {
              resolve(JSON.parse(e.data));
              ws.close();
            };
            ws.onerror = () => reject(new Error('WebSocket error'));
            setTimeout(() => reject(new Error('no message')), 5000);
          }),
        token,
      );
      assert.deepEqual(await received, { channel: 'browser', message: { from: 'chromium' } });
    } finally {
      await browser.close();
    }
  });
});

describe('WebSockets on the stock HTTP/1.1 backend (for comparison)', () => {
  let backend;

  before(async () => {
    backend = await startBackend({ http2: false });
  });

  after(async () => {
    await backend?.stop();
  });

  it('also rejects the very first upgrade, then connects', async () => {
    const res = await h1Request(backend.url, '/api/auth/guest/refresh', {
      ca: backend.ca,
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    const token = res.json.backstageIdentity.token;

    assert.equal((await connect(backend, '/api/signals', [token])).status, 404);
    const { ws } = await connect(backend, '/api/signals', [token]);
    assert.ok(ws, 'second upgrade should succeed');
    ws.close();
  });
});
