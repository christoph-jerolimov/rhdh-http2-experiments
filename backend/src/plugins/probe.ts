import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { signalsServiceRef } from '@backstage/plugin-signals-node';
import express, { Router } from 'express';

/**
 * Small plugin that exercises the Express features plugins commonly use, so
 * the tests can check how they behave over HTTP/2. Mounted at /api/probe.
 */
export const probePlugin = createBackendPlugin({
  pluginId: 'probe',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        signals: signalsServiceRef,
      },
      async init({ httpRouter, httpAuth, signals }) {
        const router = Router();
        router.use(express.json());

        // What Express thinks about the request.
        router.get('/info', (req, res) => {
          res.json({
            httpVersion: req.httpVersion,
            protocol: req.protocol,
            secure: req.secure,
            hostname: req.hostname,
            ip: req.ip,
            originalUrl: req.originalUrl,
            query: req.query,
            userAgent: req.get('user-agent'),
          });
        });

        // Who Backstage thinks is calling, from this request's own token.
        router.get('/whoami', async (req, res) => {
          const credentials = await httpAuth.credentials(req, {
            allow: ['user', 'service', 'none'],
          });
          const p = credentials.principal as any;
          res.json({
            type: p.type,
            user: p.userEntityRef,
            subject: p.subject,
            tag: req.get('x-test-tag'),
          });
        });

        // JSON request body (body-parser reads the HTTP/2 stream).
        router.post('/echo', (req, res) => {
          res.status(201).json({ body: req.body });
        });

        router.get('/redirect', (_req, res) => {
          res.redirect('/api/probe/info?redirected=true');
        });

        // Large response: HTTP/2 flow control plus gzip.
        router.get('/big', (_req, res) => {
          res.type('text/plain').send('x'.repeat(1024 * 1024));
        });

        // Server-sent events, written the way many plugins do it, including
        // a `Connection: keep-alive` header that HTTP/2 forbids.
        // ?count= and ?interval= (ms) control the stream's length and gaps.
        router.get('/events', (req, res) => {
          const count = Number(req.query.count ?? 3);
          const interval = Number(req.query.interval ?? 20);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          let n = 0;
          const timer = setInterval(() => {
            n += 1;
            res.write(`data: ${n}\n\n`);
            if (n >= count) {
              clearInterval(timer);
              res.end();
            }
          }, interval);
        });

        // Sets HTTP/1 connection-specific headers, which HTTP/2 forbids.
        // Without the bridge's header filter, one HTTP/2 request here
        // crashes the whole backend. ?via= picks the Node API used.
        router.get('/hop-by-hop', (req, res) => {
          const forbidden: Record<string, string> = {
            'Transfer-Encoding': 'chunked',
            'Keep-Alive': 'timeout=5',
            Connection: 'keep-alive',
            'Proxy-Connection': 'keep-alive',
            Upgrade: 'h2c',
            TE: 'gzip',
          };
          const headers = { ...forbidden, 'X-Kept': 'yes', 'Content-Type': 'text/plain' };
          const body = 'hop-by-hop ok';
          switch (req.query.via) {
            case 'appendHeader':
              for (const [n, v] of Object.entries(headers)) res.appendHeader(n, v);
              res.end(body);
              return;
            case 'writeHead':
              res.writeHead(200, headers).end(body);
              return;
            case 'writeHeadTuples':
              res.writeHead(200, Object.entries(headers) as any).end(body);
              return;
            case 'writeHeadFlat':
              res.writeHead(200, Object.entries(headers).flat() as any).end(body);
              return;
            default:
              // setHeader via Express's res.set, then res.send.
              res.set(headers).send(body);
          }
        });

        // Broadcasts a signal. Clients receive it over the signals plugin's
        // WebSocket, so a test can trigger it over HTTP/2 and check that it
        // arrives over the WebSocket.
        router.post('/signal', async (req, res) => {
          const { channel, message } = req.body;
          await signals.publish({ recipients: { type: 'broadcast' }, channel, message });
          res.status(202).json({ published: true });
        });

        // Errors thrown in handlers go through Backstage's error middleware.
        router.get('/error', () => {
          throw new Error('probe failure');
        });

        httpRouter.use(router);
        httpRouter.addAuthPolicy({ path: '/', allow: 'unauthenticated' });
      },
    });
  },
});
