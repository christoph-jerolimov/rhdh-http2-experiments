import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as http2 from 'node:http2';
import * as https from 'node:https';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const backendDir = resolve(import.meta.dirname, '..');
const certDir = resolve(backendDir, '../certs');

export function ensureCert() {
  if (!existsSync(join(certDir, 'cert.pem'))) {
    execFileSync(resolve(backendDir, '../scripts/generate-cert.sh'), { stdio: 'ignore' });
  }
  return readFileSync(join(certDir, 'cert.pem'));
}

export async function freePort() {
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise(r => server.close(r));
  return port;
}

/** Plain HTTP/1.1 server the proxy plugin forwards to. Records what it saw. */
export async function startUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ httpVersion: req.httpVersion, url: req.url, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-upstream', 'yes');
    res.end(JSON.stringify({ upstream: true, url: req.url }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => server.close() };
}

/** Static tokens accepted by every test backend (service principals). */
export const STATIC_TOKENS = {
  alice: 'alice-static-token-0001',
  bob: 'bob-static-token-0002',
};

/**
 * Starts the backend in a child process. `config` is layered on top of the
 * test config (Backstage deep-merges config files).
 */
export async function startBackend({ http2 = true, expressBridge = true, upstreamPort, config } = {}) {
  const ca = ensureCert();
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'h2-backend-'));
  const configFile = join(dir, 'app-config.test.yaml');
  writeFileSync(
    configFile,
    JSON.stringify({
      backend: {
        baseUrl: `https://localhost:${port}`,
        listen: { port },
        http2: { enabled: http2, expressBridge, allowedHosts: ['alias.example.com'] },
        auth: {
          externalAccess: Object.entries(STATIC_TOKENS).map(([subject, token]) => ({
            type: 'static',
            options: { token, subject },
          })),
        },
      },
      proxy: {
        endpoints: {
          '/upstream': {
            target: `http://127.0.0.1:${upstreamPort ?? 1}`,
            credentials: 'dangerously-allow-unauthenticated',
            allowedHeaders: ['x-upstream'],
          },
        },
      },
    }),
  );

  const configArgs = ['--config', 'app-config.yaml', '--config', configFile];
  if (config) {
    const extraFile = join(dir, 'app-config.extra.yaml');
    writeFileSync(extraFile, JSON.stringify(config));
    configArgs.push('--config', extraFile);
  }

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/index.ts', ...configArgs],
    {
      cwd: backendDir,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: join(certDir, 'cert.pem'), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  const onData = d => (output += d.toString());
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`backend did not start:\n${output}`)), 60_000);
    const check = () => {
      if (output.includes('Listening on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', check);
    child.on('exit', code => reject(new Error(`backend exited with ${code}:\n${output}`)));
  });

  // The server listens before plugins have started; wait until it is ready.
  const url = `https://localhost:${port}`;
  for (let i = 0; ; i++) {
    const res = await h1Request(url, '/.backstage/health/v1/readiness', { ca }).catch(() => null);
    if (res?.status === 200) break;
    if (i > 120) throw new Error(`backend never became ready:\n${output}`);
    await new Promise(r => setTimeout(r, 250));
  }

  return {
    url,
    ca,
    output: () => output,
    async stop() {
      child.kill('SIGTERM');
      await new Promise(r => child.once('exit', r));
    },
  };
}

/**
 * One HTTP/2 connection; returns a request function bound to it.
 *
 * Like browsers, requests wait when the server's maxConcurrentStreams is
 * reached (Node's client doesn't do that itself). `queue: false` sends
 * immediately, to test what the server does with excess streams.
 */
export function h2Session(url, ca, connectOptions = {}) {
  const session = http2.connect(url, { ca, ...connectOptions });
  session.on('error', () => {});

  let limit = Infinity;
  let active = 0;
  const waiting = [];
  const settingsReceived = new Promise(r =>
    session.once('remoteSettings', settings => {
      limit = settings.maxConcurrentStreams;
      r();
    }),
  );
  const acquire = async () => {
    await settingsReceived;
    if (active < limit) {
      active += 1;
      return;
    }
    // release() hands its slot over, so `active` stays the same.
    await new Promise(r => waiting.push(r));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  const request = async (path, { queue = true, ...options } = {}) => {
    if (!queue) return send(path, options);
    await acquire();
    try {
      return await send(path, options);
    } finally {
      release();
    }
  };

  const send = (path, { method = 'GET', headers = {}, body, timeout = 10_000 } = {}) =>
    new Promise((resolve, reject) => {
      const stream = session.request({ ':method': method, ':path': path, ...headers });
      stream.setTimeout(timeout, () => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        reject(new Error(`timeout: ${method} ${path}`));
      });
      let responseHeaders;
      const chunks = [];
      stream.on('response', h => (responseHeaders = h));
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        if (responseHeaders) {
          resolve(toResponse(responseHeaders[':status'], responseHeaders, chunks, 'h2'));
        }
      });
      stream.on('error', error => {
        error.rstCode = stream.rstCode;
        reject(error);
      });
      stream.on('close', () => {
        if (!responseHeaders) {
          const error = new Error(`stream closed without a response (code ${stream.rstCode})`);
          error.rstCode = stream.rstCode;
          reject(error);
        }
      });
      stream.end(body);
    });
  return {
    request,
    alpn: () => session.alpnProtocol,
    remoteSettings: () => session.remoteSettings,
    session,
    close: () => session.close(),
  };
}

/** HTTP/1.1 over TLS (the client offers only http/1.1 in ALPN). */
export function h1Request(url, path, { method = 'GET', headers = {}, body, ca } = {}) {
  return new Promise((resolve, reject) => {
    // servername: verify the certificate against the URL even when a test
    // overrides the Host header.
    const servername = new URL(url).hostname;
    const req = https.request(new URL(path, url), { method, headers, ca, servername, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () =>
        resolve(toResponse(res.statusCode, res.headers, chunks, `h${res.httpVersion}`)),
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

function toResponse(status, headers, chunks, protocol) {
  let buffer = Buffer.concat(chunks);
  if (headers['content-encoding'] === 'gzip') buffer = gunzipSync(buffer);
  const text = buffer.toString();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status, headers, text, json, protocol };
}
