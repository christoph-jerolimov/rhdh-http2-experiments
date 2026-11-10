import {
  coreServices,
  createServiceFactory,
} from '@backstage/backend-plugin-api';
import {
  DefaultRootHttpRouter,
  MiddlewareFactory,
  createHealthRouter,
  createHttpServer,
  readHttpServerOptions,
  type RootHttpRouterFactoryOptions,
} from '@backstage/backend-defaults/rootHttpRouter';
import express from 'express';
import { createExpressHttp2Listener } from './expressHttp2Bridge';
import { createHttp2Server } from './createHttp2Server';

/**
 * Drop-in replacement for `rootHttpRouterServiceFactory` from
 * `@backstage/backend-defaults` that serves HTTP/2.
 *
 * It is a trimmed copy of the upstream factory. The only real change is the
 * server: `http2.createSecureServer({ allowHTTP1: true })` instead of
 * `https.createServer`, with the Express app wrapped by the HTTP/2 bridge.
 *
 * Config (custom, not part of Backstage):
 *   backend.http2.enabled        default true; false = stock HTTP/1.1 server
 *   backend.http2.expressBridge  default true; false = pass HTTP/2 requests
 *                                to Express unpatched (they will fail)
 *
 * Not ported from upstream: backend.server.* timeouts and
 * backend.lifecycle.serverShutdownDelay.
 */
export const http2RootHttpRouterServiceFactory = (
  options?: RootHttpRouterFactoryOptions,
) =>
  createServiceFactory({
    service: coreServices.rootHttpRouter,
    deps: {
      config: coreServices.rootConfig,
      rootLogger: coreServices.rootLogger,
      lifecycle: coreServices.rootLifecycle,
      health: coreServices.rootHealth,
    },
    async factory({ config, rootLogger, lifecycle, health }) {
      const { indexPath, configure } = options ?? {};
      const logger = rootLogger.child({ service: 'rootHttpRouter' });
      const app = express();
      const router = DefaultRootHttpRouter.create({ indexPath });
      const middleware = MiddlewareFactory.create({ config, logger });
      const routes = router.handler();
      const healthRouter = createHealthRouter({ config, health });

      const serverOptions = readHttpServerOptions(
        config.getOptionalConfig('backend'),
      );
      const http2Enabled =
        config.getOptionalBoolean('backend.http2.enabled') ?? true;
      const bridgeEnabled =
        config.getOptionalBoolean('backend.http2.expressBridge') ?? true;

      let server;
      if (http2Enabled) {
        const listener = bridgeEnabled ? createExpressHttp2Listener(app) : app;
        if (!bridgeEnabled) {
          logger.warn(
            'backend.http2.expressBridge is false: HTTP/2 requests will fail',
          );
        }
        server = createHttp2Server(listener, serverOptions, { logger });
      } else {
        server = await createHttpServer(app, serverOptions, { logger });
      }

      const applyDefaults = () => {
        if (process.env.NODE_ENV === 'development') {
          app.set('json spaces', 2);
        }
        const trustProxy = config.getOptional('backend.trustProxy');
        if (trustProxy !== undefined) {
          app.set('trust proxy', trustProxy);
        }
        app.use(middleware.helmet());
        app.use(middleware.cors());
        app.use(middleware.compression());
        app.use(middleware.logging());
        app.use(middleware.rateLimit());
        app.use(healthRouter);
        app.use(routes);
        app.use(middleware.notFound());
        app.use(middleware.error());
      };

      if (configure) {
        configure({
          app,
          // The configure context is typed for http.Server; the HTTP/2
          // server has the same listen/close/address surface.
          server: server as any,
          routes,
          middleware,
          config,
          logger,
          lifecycle,
          healthRouter,
          applyDefaults,
        });
      } else {
        applyDefaults();
      }

      lifecycle.addShutdownHook(() => server.stop());
      await server.start();
      return router;
    },
  });
