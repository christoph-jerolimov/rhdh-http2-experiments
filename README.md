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

Tests (start the backend in child processes, about 40 seconds because the
slow-client test waits for Node's 30-second timeout check; the Chromium test is
skipped if Playwright isn't installed):

```bash
cd backend && npm test
```

## How it works

| File | What it does |
|---|---|
| `backend/src/http2/http2RootHttpRouterServiceFactory.ts` | Replaces Backstage's `rootHttpRouter` service. It is a trimmed copy of the upstream factory that creates an HTTP/2 server instead of `https.createServer`. |
| `backend/src/http2/createHttp2Server.ts` | `http2.createSecureServer({ allowHTTP1: true })` with the `start`/`stop`/`port` methods Backstage expects. Clients without `h2` in ALPN still get HTTP/1.1. |
| `backend/src/http2/expressHttp2Bridge.ts` | Makes Express handle `Http2ServerRequest`/`Http2ServerResponse`. |
| `backend/src/plugins/probe.ts` | Test plugin at `/api/probe` (request info, JSON body, redirect, gzip, SSE, errors, publishing a signal). |
| `backend/test/http2.test.mjs` | End-to-end tests over HTTP/2 and HTTP/1.1. |
| `backend/test/websocket.test.mjs` | WebSocket tests with the signals plugin, including headless Chromium. |
| `backend/test/timeouts.test.mjs` | Slow-client (slowloris) and idle-connection timeouts. |

Config (`backend/app-config.yaml`), custom keys:

```yaml
backend:
  http2:
    enabled: true        # false = stock HTTP/1.1 server
    expressBridge: true  # false = no bridge; HTTP/2 requests fail (for comparison)
    allowedHosts: []     # extra hosts besides backend.baseUrl's; ['*'] = no 421 check
    maxConcurrentStreams: 100  # parallel requests per connection
    maxHeaderListSize: 16384   # bytes, same as Node's HTTP/1.1 limit
    idleSessionTimeout: 2m     # close HTTP/2 connections with no open request
```

`backend.server.headersTimeout`, `requestTimeout`, `keepAliveTimeout`,
`maxHeadersCount` and `maxRequestsPerSocket` work as upstream and apply to
HTTP/1.1 connections. `backend.server.timeout` is not supported with HTTP/2,
because Node would also cut HTTP/2 connections with long-running requests.

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
- drops HTTP/1 connection-specific response headers (`Transfer-Encoding`,
  `Keep-Alive`, `Connection`, `Proxy-Connection`, `Upgrade`, `HTTP2-Settings`,
  and `TE` unless it is `trailers`), whether they are set via `setHeader`,
  `appendHeader` or `writeHead`. HTTP/2 forbids them. Node drops `Connection`
  with a warning but throws for the others, and Express's error handling then
  throws again outside any handler. **One HTTP/2 request to a route that sets
  e.g. `Transfer-Encoding` crashes the whole backend.** Each dropped header
  is logged once.

## Results

Covered by the tests, all over HTTP/2 unless noted:

| Feature | Result |
|---|---|
| ALPN: `h2` for HTTP/2 clients, HTTP/1.1 fallback on the same port | ✅ |
| Express `req.protocol`, `hostname`, `ip`, `query` same as over HTTP/1.1 | ✅ |
| Health endpoints, helmet, CORS, 404 and error middleware | ✅ |
| JSON bodies with and without `Content-Length` | ✅ (needs the bridge fix) |
| Redirects, gzip compression of a 1 MB response | ✅ |
| Server-sent events | ✅ (the bridge drops the `Connection: keep-alive` header) |
| Routes that set `Transfer-Encoding`, `Keep-Alive`, `Upgrade`, ... via any header API | ✅ headers dropped (needs the bridge fix; without it the backend crashes). HTTP/1.1 responses keep them. |
| Guest sign-in, catalog reads (`GET /entities`, `POST /entities/by-refs`) | ✅ |
| Proxy plugin to an HTTP/1.1 upstream | ✅ (needs the pseudo-header fix). Node warns that HTTP/2 has no status message. |
| 100 multiplexed HTTP/2 streams on one connection, mixed with 20 HTTP/1.1 requests | ✅ |
| Without the bridge | HTTP/1.1 works; HTTP/2 crashes |

### WebSockets

WebSockets use the HTTP/1.1 `Upgrade` mechanism, which HTTP/2 doesn't have.
RFC 8441 adds WebSockets over HTTP/2 (extended CONNECT), but only when the
server advertises `SETTINGS_ENABLE_CONNECT_PROTOCOL`. Node doesn't by default
and Backstage has no handler for it, so clients open a separate HTTP/1.1 TLS
connection to the same port for the WebSocket. The HTTP/2 server hands those
connections to Node's HTTP/1 code (`allowHTTP1`), which emits `upgrade` as usual.

Tested with the signals plugin (`/api/signals`):

| Check | Result |
|---|---|
| Server does not advertise RFC 8441, so clients fall back to HTTP/1.1 | ✅ |
| Signals subscribes to `upgrade` via `req.socket.server` from an HTTP/2 request | ✅ (`req.socket` is a proxy for the TLS socket; `.server` still works) |
| WebSocket connects; a signal published over HTTP/2 arrives on it | ✅ |
| Upgrade without a valid token is rejected with 401 | ✅ |
| HTTP/1.1 and HTTP/2 requests keep working while WebSockets are open | ✅ |
| Chromium: page loaded over `h2`, WebSocket opened from it, signal received | ✅ |
| Very first upgrade, before any request reached the signals plugin | 404, **same on stock Backstage** (tested). The plugin only subscribes to `upgrade` lazily; the frontend retries. |

## Caveats

- **Plugin-to-plugin calls stay on HTTP/1.1.** Backstage calls its own plugins
  through `backend.baseUrl` with Node's `fetch`, which does not use HTTP/2.
  With a self-signed certificate, start Node with
  `NODE_EXTRA_CA_CERTS=../certs/cert.pem`, which `npm start` does. Otherwise
  the catalog can't verify user tokens (401).
- **WebSockets** stay on HTTP/1.1 (see above). A proxy in front must allow
  HTTP/1.1 upgrades on the same host.
- **Express sub-apps.** Only the root app is patched. A plugin that mounts its
  own `express()` app (instead of `Router()`) would break over HTTP/2. None of
  the plugins here do. Check RHDH's dynamic plugins before relying on this.
- **Not ported from upstream:** `backend.server.timeout` (see above) and
  `backend.lifecycle.serverShutdownDelay`.
- `req.socket` / `req.connection` on HTTP/2 is a proxy for the shared session
  socket. Code that writes to it directly, or destroys it, affects every
  stream on the connection.

## Security

**Auth can't mix between users.** On HTTP/2 every request is its own stream
with its own headers, so `Authorization` and cookies are per request. The
bridge keeps no per-request state on shared objects. Test: 400 HTTP/2 requests
on one connection plus 40 HTTP/1.1 requests, interleaving a guest user, two
service tokens and anonymous calls, each resolve to their own principal.

What the server adds on top of the bridge:

| Risk | Protection | Tested |
|---|---|---|
| Connection coalescing: browsers reuse an HTTP/2 connection for other hostnames the certificate covers, so other apps' requests (with their cookies) could arrive here | HTTP/2 requests whose `:authority` isn't `backend.baseUrl`'s host or in `allowedHosts` get **421 Misdirected Request**; browsers retry on a new connection. HTTP/1.1 is not affected by coalescing and isn't checked. Also: don't use a wildcard certificate on the backend. | ✅ |
| Too many parallel streams (Node's default is unlimited) | `maxConcurrentStreams: 100`; excess streams get `REFUSED_STREAM`, browsers queue | ✅ |
| Huge headers (default unlimited) | `maxHeaderListSize: 16384`; that stream is reset (`ENHANCE_YOUR_CALM`), the connection survives | ✅ |
| Idle HTTP/2 connections held open forever (Node's default) | `idleSessionTimeout` closes connections with no open request (GOAWAY). Quiet long-running requests (SSE, long polling) keep it open. | ✅ |
| Slow HTTP/1.1 clients (slowloris) | Node's `headersTimeout` (60s) is enforced for HTTP/1.1 connections on the HTTP/2 server too, checked every 30s | ✅ with 1s |
| Request smuggling when the proxy plugin turns HTTP/2 into HTTP/1.1 | Node rejects a `Content-Length` that doesn't match the body; header values with CR/LF never reach the upstream; NUL is rejected | checked by hand |

Not covered here: HTTP/2-specific DoS bugs such as Rapid Reset
(CVE-2023-44487) and the CONTINUATION flood (CVE-2024-27983) are fixed in
Node itself, so keep Node up to date. Code that treats one connection as one
user (state keyed on `req.socket`, NTLM/Kerberos) is wrong behind any proxy
that reuses connections, HTTP/1.1 keep-alive included; check RHDH dynamic
plugins for it.

## Alternative

The low-risk way to get HTTP/2 to browsers is to terminate it at the edge
(OpenShift route/ingress, nginx, Envoy) and keep the backend on HTTP/1.1.
Most of the HTTP/2 benefit is between the browser and the edge.

## Excluding specific APIs from HTTP/2?

Not possible on the same host and port. The HTTP version is chosen per TLS
connection (ALPN) before the server sees a path, and the browser sends every
request for the origin over that one connection.

The only per-request escape is resetting the stream with `HTTP_1_1_REQUIRED`.
Tested in Chromium: the browser retries that request over HTTP/1.1, but then
stays on HTTP/1.1 for every later request from the page. One excluded route
turns HTTP/2 off for the whole app.

It isn't needed for upgrades: WebSockets already use a separate HTTP/1.1
connection (see above). If a plugin really needs HTTP/1.1, serve it from a
second, HTTP/1.1-only origin (another port or hostname) and point the frontend
at it with `discovery.endpoints`. That costs CORS and an extra route.
`backend.http2.enabled: false` is the global switch.
