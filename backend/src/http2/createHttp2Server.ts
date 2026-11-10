import type { LoggerService } from '@backstage/backend-plugin-api';
import type { HttpServerOptions } from '@backstage/backend-defaults/rootHttpRouter';
import type { Socket } from 'node:net';
import * as http2 from 'node:http2';

export type Http2BackendServer = http2.Http2SecureServer & {
  start(): Promise<void>;
  stop(): Promise<void>;
  port(): number;
};

/**
 * Like `createHttpServer` from `@backstage/backend-defaults/rootHttpRouter`,
 * but creates a TLS server that speaks HTTP/2 and falls back to HTTP/1.1 for
 * clients that don't offer `h2` in ALPN.
 */
export function createHttp2Server(
  listener: (req: any, res: any) => void,
  options: HttpServerOptions,
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
    { cert: certificate.cert, key: certificate.key, allowHTTP1: true },
    listener,
  );

  // Track connections so stop() can close them. HTTP/2 connections show up
  // as sessions; HTTP/1.1 connections only as TLS sockets.
  const sessions = new Set<http2.ServerHttp2Session>();
  const sockets = new Set<Socket>();
  server.on('session', session => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
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
