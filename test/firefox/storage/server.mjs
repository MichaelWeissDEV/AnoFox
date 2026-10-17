import http from 'node:http';
import { writeFileSync } from 'node:fs';
const PORT = Number(process.env.PROBE_PORT ?? 18780);
const TRACKER = process.env.TRACKER_HOST ?? 'anofox-t.net';
const SEED = `
const done = (k) => { document.documentElement.dataset[k] = '1'; };
(async () => {
  const out = {};
  try { localStorage.setItem('k', 'v-' + location.hostname); out.ls = 1; } catch (e) { out.ls = 'ERR'; }
  try { document.cookie = 'js=1; Max-Age=3600; path=/'; } catch (e) {}
  try {
    await new Promise((res, rej) => { const r = indexedDB.open('db', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { const tx = r.result.transaction('s', 'readwrite'); tx.objectStore('s').put('x', 'k'); tx.oncomplete = () => { r.result.close(); res(); }; }; r.onerror = () => rej(r.error); });
    out.idb = 1;
  } catch (e) { out.idb = 'ERR:' + e.name; }
  try { const c = await caches.open('c'); await c.put('/cached', new Response('x')); out.cache = 1; } catch (e) { out.cache = 'ERR:' + e.name; }
  try { const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; out.sw = 1; } catch (e) { out.sw = 'ERR:' + e.name; }
  document.documentElement.dataset.seedResult = JSON.stringify(out);
  done('seeded');
})();
`;
const STATE = `
(async () => {
  const s = {};
  try { s.ls = localStorage.getItem('k') ? 1 : 0; } catch (e) { s.ls = 'ERR'; }
  s.docCookie = document.cookie.split('; ').filter(Boolean).map((c) => c.split('=')[0]).sort().join(',');
  try { const dbs = await indexedDB.databases(); s.idb = dbs.some((d) => d.name === 'db') ? 1 : 0; } catch (e) { s.idb = 'ERR:' + e.name; }
  try { s.cache = (await caches.keys()).includes('c') ? 1 : 0; } catch (e) { s.cache = 'ERR:' + e.name; }
  try { s.sw = (await navigator.serviceWorker.getRegistrations()).length; } catch (e) { s.sw = 'ERR:' + e.name; }
  document.documentElement.dataset.state = JSON.stringify(s);
  document.documentElement.dataset.ready = '1';
  if (window.parent !== window) parent.postMessage({ state: s, host: location.hostname }, '*');
})();
`;
const server = http.createServer((req, res) => {
  if (process.env.PROBE_DEBUG) console.log('REQ', req.method, req.url, req.headers.host);
  const u = new URL(req.url, 'http://x');
  const host = (req.headers.host ?? '').split(':')[0];
  const send = (type, body, headers = {}) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(body); };
  const embed = u.searchParams.get('embed') === '1' && host !== TRACKER;
  switch (u.pathname) {
    case '/proxy.pac': return send('application/x-ns-proxy-autoconfig', `function FindProxyForURL(url, host) { if (host === '127.0.0.1' || host === 'localhost') return 'DIRECT'; return 'PROXY 127.0.0.1:${PORT}'; }`);
    case '/seed.html':
      return send('text/html', `<!doctype html><title>seed ${host}</title>${embed ? `<iframe src="http://${TRACKER}/seed.html"></iframe>` : ''}<script>${SEED}</script>`,
        { 'set-cookie': [`dom=1; Path=/; Domain=${host.split('.').slice(-2).join('.')}; Max-Age=3600`, `sid=1; Path=/; HttpOnly`, `pers=1; Path=/; Max-Age=3600`, `lax=1; Path=/; SameSite=Lax; Max-Age=3600`] });
    case '/state.html': return send('text/html', `<!doctype html><title>state ${host}</title><script>${STATE}</script>`);
    case '/frame-state.html': return send('text/html', `<!doctype html><title>fs</title><iframe src="http://${TRACKER}/state.html"></iframe><script>window.addEventListener('message', (e) => { document.documentElement.dataset.tracker = JSON.stringify(e.data.state); document.documentElement.dataset.ready = '1'; });</script>`);
    case '/sw.js': return send('text/javascript', "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));");
    case '/log': console.log('LOG', u.searchParams.get('m')); res.writeHead(200); return res.end('ok');
    case '/report': {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { writeFileSync(process.argv[2] ?? 'result.json', body); res.writeHead(200); res.end('ok'); setTimeout(() => process.exit(0), 200); });
      return;
    }
    default: res.writeHead(404); res.end();
  }
});
server.listen(PORT, '127.0.0.1');
