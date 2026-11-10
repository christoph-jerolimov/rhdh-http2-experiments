# rhdh-http2-experiments

Experiment: serve a Backstage (RHDH) backend over HTTP/2.

Express (4 and 5) does not support Node's `http2` module. If you pass an
Express app to `http2.createSecureServer()`, HTTP/1.1 requests work, but every
HTTP/2 request crashes with
`Cannot read properties of undefined (reading 'readable')`.
This repo shows a working setup with a small bridge and lists what to watch out for.

## Run it

```bash
./scripts/generate-cert.sh
```

```bash
cd backend && npm install
```

```bash
npm start
```

```bash
curl -k --http2 https://localhost:7007/api/probe/info
```

The response contains `"httpVersion":"2.0"`. With `--http1.1` it shows `"1.1"`.

Tests (start the backend in a child process, about 10 seconds):

```bash
cd backend && npm test
```

## How it works

| File | What it does |
|---|---|
| `backend/src/http2/http2RootHttpRouterServiceFactory.ts` | Replaces Backstage's `rootHttpRouter` service. It is a trimmed copy of the upstream factory that creates an HTTP/2 server instead of `https.createServer`. |
| `backend/src/http2/createHttp2Server.ts` | `http2.createSecureServer({ allowHTTP1: true })` with the `start`/`stop`/`port` methods Backstage expects. Clients without `h2` in ALPN still get HTTP/1.1. |
| `backend/src/http2/expressHttp2Bridge.ts` | Makes Express handle `Http2ServerRequest`/`Http2ServerResponse`. |
| `backend/src/plugins/probe.ts` | Test plugin at `/api/probe` (request info, JSON body, redirect, gzip, SSE, errors). |
| `backend/test/http2.test.mjs` | End-to-end tests over HTTP/2 and HTTP/1.1. |

Config (`backend/app-config.yaml`), custom keys:

```yaml
backend:
  http2:
    enabled: true        # false = stock HTTP/1.1 server
    expressBridge: true  # false = no bridge; HTTP/2 requests fail (for comparison)
```

HTTP/2 needs `backend.https` with a PEM certificate, because browsers only use
HTTP/2 over TLS. `backend.https: true` (generated certificate) is not supported here.

### The bridge

Express's init middleware runs `Object.setPrototypeOf(req, app.request)`, where
`app.request` inherits from `http.IncomingMessage.prototype`. `Http2ServerRequest`
keeps its state behind getters on its own prototype, so after the swap those
getters are gone. The same applies to the response.

The bridge builds a second copy of Express's request/response prototypes based
on `Http2ServerRequest.prototype` / `Http2ServerResponse.prototype`. It points
`app.request` / `app.response` at the right copy before each request enters the
app. For HTTP/2 requests it also:

- removes pseudo-headers (`:path`, `:method`, ...) from `req.headers`.
  Otherwise the proxy plugin forwards them upstream and Node fails with
  `Header name must be a valid HTTP token [":path"]`.
- sets `Host` from `:authority`, so `req.hostname` and redirects work.
- sets `Transfer-Encoding: chunked` when a body follows but there is no
  `Content-Length`. body-parser ignores bodies without one of those two
  headers, and HTTP/2 has no `Transfer-Encoding`. Without this, a streamed
  `fetch` body arrives as `{}`.

## Results

Covered by the tests, all over HTTP/2 unless noted:

| Feature | Result |
|---|---|
| ALPN: `h2` for HTTP/2 clients, HTTP/1.1 fallback on the same port | ✅ |
| Express `req.protocol`, `hostname`, `ip`, `query` same as over HTTP/1.1 | ✅ |
| Health endpoints, helmet, CORS, 404 and error middleware | ✅ |
| JSON bodies with and without `Content-Length` | ✅ (needs the bridge fix) |
| Redirects, gzip compression of a 1 MB response | ✅ |
| Server-sent events | ✅ Node drops the `Connection: keep-alive` header with an `UnsupportedWarning` |
| Guest sign-in, catalog reads (`GET /entities`, `POST /entities/by-refs`) | ✅ |
| Proxy plugin to an HTTP/1.1 upstream | ✅ (needs the pseudo-header fix). Node warns that HTTP/2 has no status message. |
| 100 multiplexed HTTP/2 streams on one connection, mixed with 20 HTTP/1.1 requests | ✅ |
| Without the bridge | HTTP/1.1 works; HTTP/2 crashes |

Also checked by hand: headless Chromium negotiates `h2`
(`nextHopProtocol === 'h2'`), and a `fetch` POST from the page works.

## Caveats

- **Plugin-to-plugin calls stay on HTTP/1.1.** Backstage calls its own plugins
  through `backend.baseUrl` with Node's `fetch`, which does not use HTTP/2.
  With a self-signed certificate, start Node with
  `NODE_EXTRA_CA_CERTS=../certs/cert.pem`, which `npm start` does. Otherwise
  the catalog can't verify user tokens (401).
- **WebSockets** need HTTP/1.1 `Upgrade`, which HTTP/2 doesn't have. Browsers
  open a separate HTTP/1.1 connection for them; that path was not tested here.
- **Express sub-apps.** Only the root app is patched. A plugin that mounts its
  own `express()` app (instead of `Router()`) would break over HTTP/2. None of
  the plugins here do. Check RHDH's dynamic plugins before relying on this.
- **Not ported from upstream:** `backend.server.*` timeouts and
  `backend.lifecycle.serverShutdownDelay`.
- `req.socket` / `req.connection` on HTTP/2 is a proxy for the shared session
  socket. Code that writes to it directly, or destroys it, affects every
  stream on the connection.

## Alternative

The low-risk way to get HTTP/2 to browsers is to terminate it at the edge
(OpenShift route/ingress, nginx, Envoy) and keep the backend on HTTP/1.1.
Most of the HTTP/2 benefit is between the browser and the edge.
