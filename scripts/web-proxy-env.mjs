import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';

/** Read the user's existing Windows proxy without writing network settings. */
export function readWindowsProxy() {
  try {
    const text = execFileSync('reg.exe', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
    { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(text)) return undefined;
    const server = text.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
    const address = server?.match(/(?:^|;)https=([^;]+)/i)?.[1]
      || server?.match(/(?:^|;)http=([^;]+)/i)?.[1] || server;
    if (!address || address.includes('=')) return undefined;
    return address.includes('://') ? address : `http://${address}`;
  } catch {
    return undefined;
  }
}

/** Parse only local HTTP proxies; remote and SOCKS settings remain untouched. */
function localProxy(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return undefined;
    return { host: url.hostname.replace(/[\[\]]/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
  } catch {
    return undefined;
  }
}

/** Check the existing local listener without changing its configuration. */
export function proxyIsListening(value) {
  const address = localProxy(value);
  if (!address) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = createConnection(address);
    const finish = (active) => { socket.destroy(); resolve(active); };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

/** Return child-process overrides; do not mutate env, credentials, or OS settings. */
export async function resolveWebProxyEnv(env, options = {}) {
  const overrides = {};
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? proxyIsListening;
  const inherited = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (platform === 'win32' && (!inherited || (localProxy(inherited) && !await probe(inherited)))) {
    const current = (options.readProxy ?? readWindowsProxy)();
    if (localProxy(current) && await probe(current)) {
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
        const previous = env[name] || env[name.toLowerCase()];
        if (!previous || (localProxy(previous) && !await probe(previous))) {
          overrides[name] = current;
          if (env[name.toLowerCase()]) overrides[name.toLowerCase()] = current;
        }
      }
    }
  }
  if (overrides.HTTPS_PROXY || inherited) {
    const supported = options.supported ?? process.allowedNodeEnvironmentFlags.has('--use-env-proxy');
    if (supported && env.NODE_USE_ENV_PROXY !== '0') overrides.NODE_USE_ENV_PROXY = '1';
    if (!env.NO_PROXY && !env.no_proxy) overrides.NO_PROXY = 'localhost,127.0.0.1,::1';
  }
  return overrides;
}
