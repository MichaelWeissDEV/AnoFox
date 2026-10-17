import http from 'node:http';
import { writeFileSync } from 'node:fs';
const PORT = Number(process.env.PROBE_PORT ?? 18796);
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (type, body, headers = {}) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(body); };
  switch (u.pathname) {
    case '/proxy.pac': return send('application/x-ns-proxy-autoconfig', `function FindProxyForURL(url, host) { if (host === '127.0.0.1' || host === 'localhost') return 'DIRECT'; return 'PROXY 127.0.0.1:${PORT}'; }`);
    case '/log': console.log('LOG', u.searchParams.get('m')); return send('text/plain', 'ok');
    case '/report': {
      let body = ''; req.on('data', (d) => { body += d; });
      req.on('end', () => { writeFileSync(process.argv[2] ?? 'result.json', body); res.writeHead(200); res.end('ok'); setTimeout(() => process.exit(0), 200); });
      return;
    }
    default: return send('text/html', `<!doctype html><title>reached ${req.headers.host}</title><body>reached`);
  }
});
server.listen(PORT, '127.0.0.1');
