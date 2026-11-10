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

/** Starts the backend in a child process with extra config layered on top. */
export async function startBackend({ expressBridge = true, upstreamPort } = {}) {
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
        http2: { enabled: true, expressBridge },
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

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/index.ts', '--config', 'app-config.yaml', '--config', configFile],
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

/** One HTTP/2 connection; returns a request function bound to it. */
export function h2Session(url, ca) {
  const session = http2.connect(url, { ca });
  session.on('error', () => {});
  const request = (path, { method = 'GET', headers = {}, body, timeout = 10_000 } = {}) =>
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
      stream.on('error', reject);
      stream.on('close', () => {
        if (!responseHeaders) reject(new Error(`stream closed without a response (code ${stream.rstCode})`));
      });
      stream.end(body);
    });
  return { request, alpn: () => session.alpnProtocol, close: () => session.close() };
}

/** HTTP/1.1 over TLS (the client offers only http/1.1 in ALPN). */
export function h1Request(url, path, { method = 'GET', headers = {}, body, ca } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(path, url), { method, headers, ca, agent: false }, res => {
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
