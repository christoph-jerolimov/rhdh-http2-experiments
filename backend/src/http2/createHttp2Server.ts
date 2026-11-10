import type { LoggerService } from '@backstage/backend-plugin-api';
import type { HttpServerOptions } from '@backstage/backend-defaults/rootHttpRouter';
import type { Socket } from 'node:net';
import * as http2 from 'node:http2';

export type Http2BackendServer = http2.Http2SecureServer & {
  start(): Promise<void>;
  stop(): Promise<void>;
  port(): number;
};

export interface Http2Options {
  /** HTTP/2 SETTINGS sent to every client (stream and header limits). */
  settings: http2.Settings;
  /**
   * Values accepted in `:authority` (`host` or `host:port`, lowercase).
   * Other HTTP/2 requests get 421 Misdirected Request. Undefined accepts all.
   */
  allowedAuthorities?: string[];
  /** Close HTTP/2 sessions that had no open stream for this long (ms). 0 = never. */
  idleSessionTimeout: number;
}

/**
 * Like `createHttpServer` from `@backstage/backend-defaults/rootHttpRouter`,
 * but creates a TLS server that speaks HTTP/2 and falls back to HTTP/1.1 for
 * clients that don't offer `h2` in ALPN.
 */
export function createHttp2Server(
  listener: (req: any, res: any) => void,
  options: HttpServerOptions,
  http2Options: Http2Options,
  deps: { logger: LoggerService },
): Http2BackendServer {
  const certificate = options.https?.certificate;
  if (!certificate) {
    throw new Error(
      'backend.http2 requires backend.https: browsers only use HTTP/2 over TLS',
    );
  }
  if (certificate.type !== 'pem') {
    throw new Error(
      'backend.http2 needs backend.https.certificate.cert/key; run scripts/generate-cert.sh for a local one',
    );
  }

  const server = http2.createSecureServer(
    {
      cert: certificate.cert,
      key: certificate.key,
      allowHTTP1: true,
      settings: http2Options.settings,
    },
    rejectMisdirectedRequests(listener, http2Options.allowedAuthorities, deps.logger),
  );

  // Track connections so stop() can close them. HTTP/2 connections show up
  // as sessions; HTTP/1.1 connections only as TLS sockets.
  const sessions = new Set<http2.ServerHttp2Session>();
  const sockets = new Set<Socket>();
  server.on('session', session => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
    closeWhenIdle(session, http2Options.idleSessionTimeout);
  });
  server.on('secureConnection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return Object.assign(server, {
    start() {
      return new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.close();
          reject(error);
        };
        server.on('error', onError);
        const { host, port } = options.listen;
        server.listen(port, host, () => {
          server.off('error', onError);
          deps.logger.info(`Listening on ${host}:${port} (HTTP/2 + HTTP/1.1)`);
          resolve();
        });
      });
    },
    stop() {
      return new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
        // Send GOAWAY: in-flight streams finish, no new ones are accepted.
        for (const session of sessions) {
          session.close();
        }
        // Give HTTP/1.1 keep-alive connections a moment, then cut them.
        setTimeout(() => {
          for (const socket of sockets) {
            socket.destroy();
          }
        }, process.env.NODE_ENV === 'development' ? 0 : 5000).unref();
      });
    },
    port() {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        throw new Error(`Unexpected server address '${address}'`);
      }
      return address.port;
    },
  });
}

/**
 * Browsers reuse an HTTP/2 connection for other hostnames when the
 * certificate covers them and they resolve to the same IP ("connection
 * coalescing"). With a wildcard certificate, requests for other apps (with
 * their cookies) could then arrive here. Answering 421 makes the browser
 * retry on a new connection to the right server (RFC 9110 15.5.20).
 *
 * Only HTTP/2 requests are checked: coalescing doesn't exist in HTTP/1.1.
 */
function rejectMisdirectedRequests(
  listener: (req: any, res: any) => void,
  allowedAuthorities: string[] | undefined,
  logger: LoggerService,
) {
  if (!allowedAuthorities) {
    return listener;
  }
  const allowed = new Set(allowedAuthorities.map(a => a.toLowerCase()));
  const warned = new Set<string>();
  return (req: any, res: any) => {
    if (req instanceof http2.Http2ServerRequest) {
      const authority = (req.authority ?? '').toLowerCase();
      if (!allowed.has(authority)) {
        // Log each unknown authority once (capped, it's client-controlled).
        if (warned.size < 100 && !warned.has(authority)) {
          warned.add(authority);
          logger.warn(
            `Rejected HTTP/2 request for authority '${authority}' with 421; add it to backend.http2.allowedHosts if it is expected`,
          );
        }
        res.writeHead(421, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              name: 'MisdirectedRequestError',
              message: 'This server does not serve the requested host',
            },
            response: { statusCode: 421 },
          }),
        );
        return;
      }
    }
    listener(req, res);
  };
}

/**
 * Closes the session gracefully (GOAWAY) once it has had no open stream for
 * `timeout` ms. Node's own server.timeout would destroy sessions even while
 * long-running streams (SSE, long polling) are open.
 */
function closeWhenIdle(session: http2.ServerHttp2Session, timeout: number) {
  if (timeout <= 0) {
    return;
  }
  let openStreams = 0;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    timer = setTimeout(() => session.close(), timeout);
    timer.unref();
  };
  arm();
  session.on('stream', stream => {
    openStreams += 1;
    clearTimeout(timer);
    stream.on('close', () => {
      openStreams -= 1;
      if (openStreams === 0 && !session.closed) {
        arm();
      }
    });
  });
  session.on('close', () => clearTimeout(timer));
}
