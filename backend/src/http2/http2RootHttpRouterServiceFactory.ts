import {
  coreServices,
  createServiceFactory,
  type LoggerService,
} from '@backstage/backend-plugin-api';
import {
  DefaultRootHttpRouter,
  MiddlewareFactory,
  createHealthRouter,
  createHttpServer,
  readHttpServerOptions,
  type RootHttpRouterFactoryOptions,
} from '@backstage/backend-defaults/rootHttpRouter';
import { readDurationFromConfig, type Config } from '@backstage/config';
import { durationToMilliseconds } from '@backstage/types';
import express from 'express';
import { createExpressHttp2Listener } from './expressHttp2Bridge';
import { createHttp2Server } from './createHttp2Server';

/**
 * Drop-in replacement for `rootHttpRouterServiceFactory` from
 * `@backstage/backend-defaults` that serves HTTP/2.
 *
 * It is a trimmed copy of the upstream factory. The main change is the
 * server: `http2.createSecureServer({ allowHTTP1: true })` instead of
 * `https.createServer`, with the Express app wrapped by the HTTP/2 bridge.
 *
 * Config (custom, not part of Backstage), all under backend.http2:
 *   enabled              default true; false = stock HTTP/1.1 server
 *   expressBridge        default true; false = HTTP/2 requests fail (for comparison)
 *   allowedHosts         extra `host` / `host:port` values accepted in
 *                        `:authority`, besides backend.baseUrl's host.
 *                        Others get 421. ['*'] turns the check off.
 *   maxConcurrentStreams default 100 parallel requests per connection
 *   maxHeaderListSize    default 16384 bytes, like Node's HTTP/1.1 limit
 *   idleSessionTimeout   default 2 minutes; ms or a duration string
 *
 * backend.server.headersTimeout, requestTimeout, keepAliveTimeout,
 * maxHeadersCount and maxRequestsPerSocket apply to HTTP/1.1 connections,
 * as upstream. backend.server.timeout and
 * backend.lifecycle.serverShutdownDelay are not supported.
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
      const http2Config = config.getOptionalConfig('backend.http2');
      const http2Enabled = http2Config?.getOptionalBoolean('enabled') ?? true;
      const bridgeEnabled =
        http2Config?.getOptionalBoolean('expressBridge') ?? true;

      let server;
      if (http2Enabled) {
        const listener = bridgeEnabled
          ? createExpressHttp2Listener(app, { logger })
          : app;
        if (!bridgeEnabled) {
          logger.warn(
            'backend.http2.expressBridge is false: HTTP/2 requests will fail',
          );
        }
        server = createHttp2Server(
          listener,
          serverOptions,
          {
            settings: {
              maxConcurrentStreams:
                http2Config?.getOptionalNumber('maxConcurrentStreams') ?? 100,
              maxHeaderListSize:
                http2Config?.getOptionalNumber('maxHeaderListSize') ?? 16384,
            },
            allowedAuthorities: readAllowedAuthorities(config),
            idleSessionTimeout:
              readDuration(http2Config, 'idleSessionTimeout', logger) ??
              120_000,
          },
          { logger },
        );
      } else {
        server = await createHttpServer(app, serverOptions, { logger });
      }
      applyServerConfig(server, config, logger, http2Enabled);

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

/** backend.baseUrl's host (with and without a default port) plus allowedHosts. */
function readAllowedAuthorities(config: Config): string[] | undefined {
  const extra =
    config.getOptionalStringArray('backend.http2.allowedHosts') ?? [];
  if (extra.includes('*')) {
    return undefined;
  }
  const baseUrl = new URL(config.getString('backend.baseUrl'));
  const defaultPort = baseUrl.protocol === 'https:' ? '443' : '80';
  const authorities = [`${baseUrl.hostname}:${baseUrl.port || defaultPort}`];
  if (!baseUrl.port) {
    // Clients leave out the default port.
    authorities.push(baseUrl.hostname);
  }
  return [...authorities, ...extra];
}

/**
 * Same backend.server.* settings upstream applies. Node enforces them for the
 * HTTP/1.1 connections of the HTTP/2 server too (checked every 30 seconds).
 */
function applyServerConfig(
  server: any,
  config: Config,
  logger: LoggerService,
  http2Enabled: boolean,
) {
  const serverConfig = config.getOptionalConfig('backend.server');
  if (!serverConfig) {
    return;
  }
  for (const key of ['headersTimeout', 'requestTimeout', 'keepAliveTimeout']) {
    const value = readDuration(serverConfig, key, logger);
    if (value !== undefined) {
      server[key] = value;
    }
  }
  for (const key of ['maxHeadersCount', 'maxRequestsPerSocket']) {
    const value = serverConfig.getOptionalNumber(key);
    if (value !== undefined) {
      server[key] = value;
    }
  }
  if (serverConfig.has('timeout')) {
    if (!http2Enabled) {
      server.timeout = readDuration(serverConfig, 'timeout', logger);
      return;
    }
    logger.warn(
      'backend.server.timeout is not supported with backend.http2; use backend.http2.idleSessionTimeout',
    );
  }
}

/** Reads a number (ms) or a duration (e.g. '30s', { seconds: 30 }). */
function readDuration(
  config: Config | undefined,
  key: string,
  logger: LoggerService,
): number | undefined {
  if (!config?.has(key)) {
    return undefined;
  }
  const value = config.getOptional(key);
  if (typeof value === 'number') {
    return value;
  }
  try {
    return durationToMilliseconds(readDurationFromConfig(config, { key }));
  } catch (error) {
    logger.warn(`Ignoring invalid duration for ${key}: ${error}`);
    return undefined;
  }
}
