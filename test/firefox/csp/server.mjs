import http from 'node:http';
import { writeFileSync } from 'node:fs';
const PORT = Number(process.env.PROBE_PORT ?? 8777);
const page = (extraHead = '') => `<!doctype html><html><head><meta charset=utf-8><title>start</title>${extraHead}</head><body>
<script>document.title += ' inline-ran';</script>
<img src="/x.png" onerror="document.title += ' handler-ran'">
<script src="/marker.js"></script>
<script type="module">document.title += ' inline-module-ran';</script>
<noscript><style>body{background:rgb(255,0,0)}</style></noscript>
<a id="jsurl" href="javascript:void(0)">x</a>
</body></html>`;
const probeJs = `
const r = {};
const t = (n, f) => { try { r[n] = String(f()); } catch (e) { r[n] = 'ERR:' + e.name; } };
t('eval', () => eval('1+1'));
t('Function', () => new Function('return 3')());
t('wasm-sync', () => new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])) ? 'ok' : 'no');
t('blob-worker-ctor', () => { const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], {type:'text/javascript'}))); w.onerror = (e) => { document.documentElement.dataset.workerErr = 'blocked'; }; w.onmessage = () => { document.documentElement.dataset.workerOk = '1'; }; return 'created'; });
t('data-worker-ctor', () => { const w = new Worker('data:text/javascript,postMessage(1)'); w.onerror = () => { document.documentElement.dataset.dataWorkerErr = 'blocked'; }; w.onmessage = () => { document.documentElement.dataset.dataWorkerOk = '1'; }; return 'created'; });
t('same-origin-worker-ctor', () => { const w = new Worker('/worker.js'); w.onmessage = () => { document.documentElement.dataset.sameWorkerOk = '1'; }; return 'created'; });
import('/dyn.js').then(() => { document.documentElement.dataset.dynImport = 'ok'; }, () => { document.documentElement.dataset.dynImport = 'blocked'; });
import('http://127.0.0.1:${PORT + 1}/cross.js').then(() => { document.documentElement.dataset.crossImport = 'ok'; }, () => { document.documentElement.dataset.crossImport = 'blocked'; });
const s = document.createElement('script'); s.textContent = 'document.documentElement.dataset.dynInline = "ran"'; document.head.appendChild(s);
const s2 = document.createElement('script'); s2.src = '/dyn2.js'; document.head.appendChild(s2);
document.documentElement.dataset.probe = JSON.stringify(r);
`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (type, body, headers = {}) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(body); };
  switch (u.pathname) {
    case '/page.html': return send('text/html', page());
    case '/page-own-csp.html': return send('text/html', page(), { 'content-security-policy': "script-src 'self' 'unsafe-inline'" });
    case '/frame-host.html': return send('text/html', `<!doctype html><title>host</title><iframe src="/page.html"></iframe><script>document.title+=' host-inline-ran'</script>`);
    case '/probe.html': return send('text/html', `<!doctype html><title>probe</title><script src="/probe.js"></script>`);
    case '/marker.js': return send('text/javascript', "document.title += ' ext-ran';");
    case '/probe.js': return send('text/javascript', probeJs);
    case '/worker.js': return send('text/javascript', 'postMessage(1)');
    case '/dyn.js': case '/dyn2.js': return send('text/javascript', "document.documentElement.dataset.dyn2 = 'ran'");
    case '/x.png': res.writeHead(404); return res.end();
    case '/report': {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { writeFileSync(process.argv[2] ?? 'result.json', body); res.writeHead(200, { 'access-control-allow-origin': '*' }); res.end('ok'); console.log('REPORT RECEIVED'); setTimeout(() => process.exit(0), 200); });
      return;
    }
    default: res.writeHead(404); res.end();
  }
});
server.listen(PORT, '127.0.0.1', () => console.log('listening'));
// second origin for cross-origin import
http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }); res.end('1'); }).listen(PORT + 1, '127.0.0.1');
