import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STATIC_TOKENS, h1Request, h2Session, startBackend, startUpstream } from './helpers.mjs';

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

  it('drops HTTP/1 connection-specific headers instead of crashing', async () => {
    const forbidden = ['transfer-encoding', 'keep-alive', 'connection', 'proxy-connection', 'upgrade', 'te'];
    for (const via of ['setHeader', 'appendHeader', 'writeHead', 'writeHeadTuples', 'writeHeadFlat']) {
      const res = await h2.request(`/api/probe/hop-by-hop?via=${via}`);
      assert.equal(res.status, 200, `${via}: ${res.text}`);
      assert.equal(res.text, 'hop-by-hop ok', via);
      assert.equal(res.headers['x-kept'], 'yes', via);
      for (const name of forbidden) {
        assert.equal(res.headers[name], undefined, `${via}: ${name}`);
      }
    }
    // The backend is still alive.
    assert.equal((await h2.request('/api/probe/info')).status, 200);
    assert.match(backend.output(), /Dropped HTTP\/1 header 'transfer-encoding'/);
    assert.doesNotMatch(backend.output(), /ERR_HTTP2_INVALID_CONNECTION_HEADERS/);
  });

  it('leaves HTTP/1.1 responses alone', async () => {
    const res = await h1Request(backend.url, '/api/probe/hop-by-hop?via=writeHead', {
      ca: backend.ca,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['keep-alive'], 'timeout=5');
    assert.equal(res.headers['x-kept'], 'yes');
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

  it('keeps auth separate between concurrent requests from different users', async () => {
    // One connection carrying several users' requests at once, as a proxy
    // that multiplexes users onto one upstream HTTP/2 connection would.
    const guest = await h2.request('/api/auth/guest/refresh', {
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    const identities = {
      guest: { authorization: `Bearer ${guest.json.backstageIdentity.token}` },
      alice: { authorization: `Bearer ${STATIC_TOKENS.alice}` },
      bob: { authorization: `Bearer ${STATIC_TOKENS.bob}` },
      anonymous: {},
    };
    const names = Object.keys(identities);

    // What each identity resolves to on its own, one request at a time.
    const expected = {};
    for (const name of names) {
      const res = await h1Request(backend.url, '/api/probe/whoami', {
        ca: backend.ca,
        headers: identities[name],
      });
      assert.equal(res.status, 200, res.text);
      const { tag: _tag, ...principal } = res.json;
      expected[name] = principal;
    }
    assert.equal(expected.guest.type, 'user');
    assert.equal(expected.alice.type, 'service');
    assert.match(expected.alice.subject, /alice/);
    assert.match(expected.bob.subject, /bob/);
    assert.equal(expected.anonymous.type, 'none');

    // Now interleave them: 400 HTTP/2 requests on one connection plus 40
    // HTTP/1.1 requests, all in flight together.
    const calls = Array.from({ length: 440 }, (_, i) => {
      const name = names[i % names.length];
      const headers = { ...identities[name], 'x-test-tag': `${name}-${i}` };
      const res =
        i < 400
          ? h2.request('/api/probe/whoami', { headers })
          : h1Request(backend.url, '/api/probe/whoami', { ca: backend.ca, headers });
      return res.then(r => ({ name, i, r }));
    });
    for (const { name, i, r } of await Promise.all(calls)) {
      assert.equal(r.status, 200);
      const { tag, ...principal } = r.json;
      assert.equal(tag, `${name}-${i}`);
      assert.deepEqual(principal, expected[name], `request ${i} (${name})`);
    }
  });

  it('answers 421 for hosts this backend does not serve', async () => {
    const other = await h2.request('/api/probe/info', {
      headers: { ':authority': 'other-app.example.com' },
    });
    assert.equal(other.status, 421);
    assert.equal(other.json.error.name, 'MisdirectedRequestError');
    assert.match(backend.output(), /Rejected HTTP\/2 request for authority 'other-app.example.com'/);

    // baseUrl's host (any case) and backend.http2.allowedHosts are served.
    const port = new URL(backend.url).port;
    for (const authority of [`LOCALHOST:${port}`, 'alias.example.com']) {
      const res = await h2.request('/api/probe/info', { headers: { ':authority': authority } });
      assert.equal(res.status, 200, authority);
    }

    // HTTP/1.1 has no connection coalescing, so it isn't checked.
    const h1 = await h1Request(backend.url, '/api/probe/info', {
      ca: backend.ca,
      headers: { host: 'other-app.example.com' },
    });
    assert.equal(h1.status, 200);
  });

  it('limits parallel streams per connection and header size', async () => {
    const settings = h2.remoteSettings();
    assert.equal(settings.maxConcurrentStreams, 100);
    assert.equal(settings.maxHeaderListSize, 16384);

    // A client that ignores the limit gets the excess streams refused.
    // REFUSED_STREAM tells clients the request was not processed.
    // Node's client assumes 100 streams until the server's SETTINGS arrive;
    // assuming more makes it send all 150 right away, like a misbehaving client.
    const raw = h2Session(backend.url, backend.ca, { peerMaxConcurrentStreams: 1000 });
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 150 }, () =>
          raw.request('/api/probe/events?count=1&interval=200', { queue: false }),
        ),
      );
      const ok = results.filter(r => r.status === 'fulfilled');
      const refused = results.filter(r => r.status === 'rejected');
      assert.ok(ok.every(r => r.value.status === 200));
      assert.ok(ok.length >= 100, `only ${ok.length} succeeded`);
      assert.ok(refused.length > 0, 'nothing was refused');
      assert.ok(
        refused.every(r => r.reason.rstCode === 7),
        refused.map(r => r.reason.message).join(', '),
      );

      // Headers over the limit reset that stream only (ENHANCE_YOUR_CALM).
      await assert.rejects(
        raw.request('/api/probe/info', { headers: { 'x-big': 'a'.repeat(20_000) } }),
        e => e.rstCode === 11,
      );
      assert.equal((await raw.request('/api/probe/info')).status, 200);
    } finally {
      raw.close();
    }
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
