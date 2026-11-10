import type { Express } from 'express';
import * as http from 'node:http';
import * as http2 from 'node:http2';

type Listener = (
  req: http.IncomingMessage | http2.Http2ServerRequest,
  res: http.ServerResponse | http2.Http2ServerResponse,
) => void;

/**
 * Lets an Express 4/5 app handle requests from a `node:http2` server.
 *
 * The problem: Express's init middleware runs
 * `Object.setPrototypeOf(req, app.request)`, and `app.request` inherits from
 * `http.IncomingMessage.prototype`. An `Http2ServerRequest` keeps its state
 * behind getters on its own prototype, so after the swap those getters are
 * gone and Express crashes ("Cannot read properties of undefined (reading
 * 'readable')"). The same is true for the response.
 *
 * The fix: build a second copy of Express's request/response prototype chain
 * that ends in `Http2ServerRequest.prototype` / `Http2ServerResponse.prototype`
 * instead, and point `app.request` / `app.response` at the right copy right
 * before each request enters the app. Express reads them synchronously while
 * handling the first middleware, so the swap cannot leak between requests.
 *
 * Only the app passed in here is patched. Express sub-apps (`express()`
 * mounted inside another app) would need the same treatment; Backstage
 * plugins use `Router()`, which never touches the prototypes.
 */
export function createExpressHttp2Listener(app: Express): Listener {
  const http1Protos = { request: app.request, response: app.response };
  const http2Protos = {
    request: rebasePrototypeChain(
      app.request,
      http.IncomingMessage.prototype,
      http2.Http2ServerRequest.prototype,
    ),
    response: rebasePrototypeChain(
      app.response,
      http.ServerResponse.prototype,
      http2.Http2ServerResponse.prototype,
    ),
  };

  return (req, res) => {
    if (req instanceof http2.Http2ServerRequest) {
      // Give the request a headers object without HTTP/2 pseudo-headers
      // (`:path`, `:method`, ...). Code that forwards req.headers, like the
      // proxy plugin, otherwise fails with "Header name must be a valid HTTP
      // token". Node keeps req.url and req.method in its own internal copy,
      // which stays untouched.
      const headers: http.IncomingHttpHeaders = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (!name.startsWith(':')) {
          headers[name] = value as string | string[];
        }
      }
      Object.defineProperty(req, 'headers', {
        value: headers,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      // Express reads the Host header (req.hostname, req.host, redirects).
      // HTTP/2 clients send `:authority` instead.
      if (!headers.host && req.authority) {
        headers.host = req.authority;
      }
      // body-parser (via type-is) only reads a body if it sees Content-Length
      // or Transfer-Encoding. HTTP/2 has no Transfer-Encoding, so a body sent
      // without a length (e.g. a streamed fetch) would be silently ignored.
      // The stream knows whether a body follows the headers.
      if (
        headers['content-length'] === undefined &&
        headers['transfer-encoding'] === undefined &&
        !req.stream.endAfterHeaders
      ) {
        headers['transfer-encoding'] = 'chunked';
      }
      app.request = http2Protos.request;
      app.response = http2Protos.response;
    } else {
      app.request = http1Protos.request;
      app.response = http1Protos.response;
    }
    app(req as any, res as any);
  };
}

/**
 * Copies every object in `obj`'s prototype chain up to (not including)
 * `oldBase`, and re-links the copies on top of `newBase`.
 */
function rebasePrototypeChain<T extends object>(
  obj: T,
  oldBase: object,
  newBase: object,
): T {
  const chain: object[] = [];
  for (let o: object | null = obj; o !== oldBase; o = Object.getPrototypeOf(o)) {
    if (o === null) {
      throw new Error('Express prototype does not extend the expected Node.js base class');
    }
    chain.push(o);
  }
  return chain.reduceRight<object>(
    (base, o) => Object.create(base, Object.getOwnPropertyDescriptors(o)),
    newBase,
  ) as T;
}
