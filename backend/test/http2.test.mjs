import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { h1Request, h2Session, startBackend, startUpstream } from './helpers.mjs';

describe('Backstage backend over HTTP/2 with the Express bridge', () => {
  let backend, upstream, h2;

  before(async () => {
    upstream = await startUpstream();
    backend = await startBackend({ upstreamPort: upstream.port });
    h2 = h2Session(backend.url, backend.ca);
  });

  after(async () => {
    h2?.close();
    upstream?.close();
    await backend?.stop();
  });

  it('negotiates h2 via ALPN and still serves HTTP/1.1 clients', async () => {
    const res2 = await h2.request('/api/probe/info');
    assert.equal(h2.alpn(), 'h2');
    assert.equal(res2.status, 200);
    assert.equal(res2.json.httpVersion, '2.0');

    const res1 = await h1Request(backend.url, '/api/probe/info', { ca: backend.ca });
    assert.equal(res1.status, 200);
    assert.equal(res1.json.httpVersion, '1.1');
  });

  it('gives Express the same request details over h2 as over h1', async () => {
    const path = '/api/probe/info?a=1&b=two';
    const res2 = await h2.request(path);
    const res1 = await h1Request(backend.url, path, { ca: backend.ca });
    const { httpVersion: _v2, ...info2 } = res2.json;
    const { httpVersion: _v1, ...info1 } = res1.json;
    assert.deepEqual(info2, info1);
    assert.equal(info2.protocol, 'https');
    assert.equal(info2.hostname, 'localhost');
    assert.deepEqual(info2.query, { a: '1', b: 'two' });
  });

  it('serves the health endpoints', async () => {
    const res = await h2.request('/.backstage/health/v1/readiness');
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'ok');
  });

  it('applies the default middleware (helmet, 404, error handler)', async () => {
    const ok = await h2.request('/api/probe/info');
    assert.ok(ok.headers['content-security-policy']);

    const missing = await h2.request('/api/does-not-exist');
    assert.equal(missing.status, 404);

    const failed = await h2.request('/api/probe/error');
    assert.equal(failed.status, 500);
    assert.equal(failed.json.error.message, 'probe failure');
  });

  it('parses JSON request bodies with and without Content-Length', async () => {
    const body = JSON.stringify({ hello: 'http2' });
    for (const headers of [
      { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      { 'content-type': 'application/json' },
    ]) {
      const res = await h2.request('/api/probe/echo', { method: 'POST', headers, body });
      assert.equal(res.status, 201);
      assert.deepEqual(res.json, { body: { hello: 'http2' } });
    }
  });

  it('redirects', async () => {
    const res = await h2.request('/api/probe/redirect');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/api/probe/info?redirected=true');
  });

  it('compresses large responses', async () => {
    const res = await h2.request('/api/probe/big', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(res.text.length, 1024 * 1024);
  });

  it('streams server-sent events (the Connection header is dropped)', async () => {
    const res = await h2.request('/api/probe/events');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/event-stream');
    assert.equal(res.headers.connection, undefined);
    assert.equal(res.text, 'data: 1\n\ndata: 2\n\ndata: 3\n\n');
  });

  it('signs in as guest and reads the catalog', async () => {
    const refresh = await h2.request('/api/auth/guest/refresh', {
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    assert.equal(refresh.status, 200);
    const token = refresh.json.backstageIdentity.token;
    const auth = { authorization: `Bearer ${token}` };

    // The catalog ingests examples/entities.yaml in the background.
    let items = [];
    for (let i = 0; i < 60 && items.length === 0; i++) {
      const res = await h2.request('/api/catalog/entities/by-refs', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ entityRefs: ['component:default/http2-backend'] }),
      });
      assert.equal(res.status, 200, res.text);
      items = res.json.items.filter(Boolean);
      if (items.length === 0) await new Promise(r => setTimeout(r, 500));
    }
    assert.equal(items[0]?.metadata.name, 'http2-backend');

    const list = await h2.request('/api/catalog/entities?fields=kind,metadata.name', {
      headers: auth,
    });
    assert.equal(list.status, 200);
    assert.ok(list.json.some(e => e.metadata.name === 'http2-backend'));
  });

  it('proxies to an HTTP/1.1 upstream', async () => {
    const res = await h2.request('/api/proxy/upstream/some/path?x=1');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers['x-upstream'], 'yes');
    assert.deepEqual(res.json, { upstream: true, url: '/some/path?x=1' });
    const seen = upstream.seen.at(-1);
    assert.equal(seen.httpVersion, '1.1');
    assert.ok(!Object.keys(seen.headers).some(h => h.startsWith(':')), 'no pseudo-headers upstream');
  });

  it('handles many multiplexed h2 streams mixed with h1 requests', async () => {
    const h2Calls = Array.from({ length: 100 }, (_, i) => h2.request(`/api/probe/info?i=${i}`));
    const h1Calls = Array.from({ length: 20 }, (_, i) =>
      h1Request(backend.url, `/api/probe/info?i=h1-${i}`, { ca: backend.ca }),
    );
    const [r2, r1] = await Promise.all([Promise.all(h2Calls), Promise.all(h1Calls)]);
    r2.forEach((res, i) => {
      assert.equal(res.status, 200);
      assert.equal(res.json.httpVersion, '2.0');
      assert.equal(res.json.query.i, String(i));
    });
    r1.forEach((res, i) => {
      assert.equal(res.status, 200);
      assert.equal(res.json.httpVersion, '1.1');
      assert.equal(res.json.query.i, `h1-${i}`);
    });
  });
});

describe('Backstage backend over HTTP/2 without the Express bridge', () => {
  let backend, h2;

  before(async () => {
    backend = await startBackend({ expressBridge: false });
    h2 = h2Session(backend.url, backend.ca);
  });

  after(async () => {
    h2?.close();
    await backend?.stop();
  });

  it('still serves HTTP/1.1', async () => {
    const res = await h1Request(backend.url, '/api/probe/info', { ca: backend.ca });
    assert.equal(res.status, 200);
  });

  it('fails HTTP/2 requests because Express breaks Http2ServerRequest', async () => {
    await assert.rejects(h2.request('/api/probe/info', { timeout: 3000 }));
    assert.match(backend.output(), /Cannot read properties of undefined/);
  });
});
