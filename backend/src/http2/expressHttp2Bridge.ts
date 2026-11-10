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
 * HTTP/2 responses also drop HTTP/1 connection-specific headers (see
 * createHeaderFilter below).
 *
 * Only the app passed in here is patched. Express sub-apps (`express()`
 * mounted inside another app) would need the same treatment; Backstage
 * plugins use `Router()`, which never touches the prototypes.
 */
export function createExpressHttp2Listener(
  app: Express,
  options: { logger?: { warn(message: string): void } } = {},
): Listener {
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
      createHeaderFilter(http2.Http2ServerResponse.prototype, options.logger),
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

/**
 * HTTP/2 forbids HTTP/1 connection-specific headers (RFC 9113 8.2.2). Node
 * drops `Connection` with a warning but throws ERR_HTTP2_INVALID_CONNECTION_HEADERS
 * for the others when the response is sent. Express catches that, tries to
 * send an error response with the same headers, which throws again outside
 * any handler and crashes the whole process. One request to a route that sets
 * e.g. `Transfer-Encoding` would take down the backend.
 *
 * Returns a prototype layer on top of Http2ServerResponse.prototype that
 * silently drops these headers in setHeader, appendHeader and writeHead.
 * HTTP/2 handles framing and connection management itself, so dropping them
 * does not change what the client receives.
 */
function createHeaderFilter(
  base: http2.Http2ServerResponse,
  logger?: { warn(message: string): void },
): object {
  const warned = new Set<string>();
  const isForbidden = (name: unknown, value: unknown) => {
    if (typeof name !== 'string') return false;
    const lower = name.toLowerCase();
    if (lower === 'te') return String(value).toLowerCase() !== 'trailers';
    return CONNECTION_SPECIFIC_HEADERS.has(lower);
  };
  const drop = (name: string) => {
    const lower = name.toLowerCase();
    if (logger && !warned.has(lower)) {
      warned.add(lower);
      logger.warn(
        `Dropped HTTP/1 header '${lower}' from an HTTP/2 response; logged once per header`,
      );
    }
  };

  return Object.create(base, {
    setHeader: {
      value(this: http2.Http2ServerResponse, name: string, value: any) {
        if (isForbidden(name, value)) {
          drop(name);
          return this;
        }
        return base.setHeader.call(this, name, value);
      },
      writable: true,
      configurable: true,
    },
    appendHeader: {
      value(this: http2.Http2ServerResponse, name: string, value: any) {
        if (isForbidden(name, value)) {
          drop(name);
          return this;
        }
        return base.appendHeader.call(this, name, value);
      },
      writable: true,
      configurable: true,
    },
    writeHead: {
      value(
        this: http2.Http2ServerResponse,
        statusCode: number,
        statusMessage?: any,
        headers?: any,
      ) {
        if (headers === undefined && typeof statusMessage === 'object') {
          headers = statusMessage;
          statusMessage = undefined;
        }
        if (Array.isArray(headers)) {
          if (headers.length > 0 && Array.isArray(headers[0])) {
            // [[name, value], ...]
            headers = headers.filter(([n, v]: [string, unknown]) =>
              isForbidden(n, v) ? (drop(n), false) : true,
            );
          } else {
            // [name, value, name, value, ...]
            const flat: unknown[] = [];
            for (let i = 0; i < headers.length; i += 2) {
              if (isForbidden(headers[i], headers[i + 1])) drop(headers[i]);
              else flat.push(headers[i], headers[i + 1]);
            }
            headers = flat;
          }
        } else if (headers) {
          headers = Object.fromEntries(
            Object.entries(headers).filter(([n, v]) =>
              isForbidden(n, v) ? (drop(n), false) : true,
            ),
          );
        }
        // HTTP/2 has no status message; Node only warns about it.
        return (base.writeHead as Function).call(this, statusCode, headers);
      },
      writable: true,
      configurable: true,
    },
  });
}

// The headers Node rejects in HTTP/2 responses, besides `te` (allowed only
// with the value "trailers").
const CONNECTION_SPECIFIC_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
]);
