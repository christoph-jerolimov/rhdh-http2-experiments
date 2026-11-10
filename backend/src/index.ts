import { createBackend } from '@backstage/backend-defaults';
import { http2RootHttpRouterServiceFactory } from './http2/http2RootHttpRouterServiceFactory';
import { probePlugin } from './plugins/probe';

const backend = createBackend();

// Replaces the default rootHttpRouter, which only serves HTTP/1.1.
backend.add(http2RootHttpRouterServiceFactory());

backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));
backend.add(import('@backstage/plugin-permission-backend'));
backend.add(import('@backstage/plugin-permission-backend-module-allow-all-policy'));
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));
backend.add(import('@backstage/plugin-signals-backend'));
backend.add(probePlugin);

backend.start();
