import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import express, { Router } from 'express';

/**
 * Small plugin that exercises the Express features plugins commonly use, so
 * the tests can check how they behave over HTTP/2. Mounted at /api/probe.
 */
export const probePlugin = createBackendPlugin({
  pluginId: 'probe',
  register(env) {
    env.registerInit({
      deps: { httpRouter: coreServices.httpRouter },
      async init({ httpRouter }) {
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
        router.get('/events', (_req, res) => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          let n = 0;
          const timer = setInterval(() => {
            n += 1;
            res.write(`data: ${n}\n\n`);
            if (n === 3) {
              clearInterval(timer);
              res.end();
            }
          }, 20);
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
