import http from 'node:http';
import { writeFileSync } from 'node:fs';
const PORT = Number(process.env.PROBE_PORT ?? 18779);
const DETECT = `
const R = {};
const t = (n, f) => { try { const v = f(); R[n] = (v && typeof v === 'object') ? JSON.stringify(v) : String(v); } catch (e) { R[n] = 'ERR:' + e.name + ':' + String(e.message).slice(0, 120); } };
t('early.hw', () => window.__earlyHw);           // captured by an inline script that ran first
t('hw', () => navigator.hardwareConcurrency);
t('ua', () => navigator.userAgent);
t('platform', () => navigator.platform);
t('languages', () => navigator.languages);
t('language', () => navigator.language);
const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency');
t('desc.keys', () => Object.keys(desc).sort());
t('desc.enumerable', () => desc.enumerable);
t('desc.configurable', () => desc.configurable);
t('getter.name', () => desc.get.name);
t('getter.length', () => desc.get.length);
t('getter.toString', () => Function.prototype.toString.call(desc.get));
t('getter.hasPrototype', () => 'prototype' in desc.get);
t('getter.wrongReceiver', () => desc.get.call({}));
t('getter.ownKeys', () => Reflect.ownKeys(desc.get));
t('instance.ownProps', () => Object.getOwnPropertyNames(navigator));
t('proto.keys', () => Object.getOwnPropertyNames(Navigator.prototype).join(','));
t('instance.hasOwn.hw', () => Object.prototype.hasOwnProperty.call(navigator, 'hardwareConcurrency'));
t('window.globals', () => Object.getOwnPropertyNames(window).filter((k) => /anofox|hook|spoof|__/i.test(k)));
t('iframe.blank.sync', () => { const f = document.createElement('iframe'); document.body.appendChild(f); const v = f.contentWindow.navigator.hardwareConcurrency; return v; });
t('iframe.blank.before-append', () => { const f = document.createElement('iframe'); document.body.appendChild(f); const w = f.contentWindow; return [w.navigator.userAgent === navigator.userAgent, w.navigator.hardwareConcurrency]; });
t('uaVsHeader', () => 'pending');
const run = async () => {
  // iframe srcdoc
  try { R['iframe.srcdoc'] = await new Promise((res) => { const f = document.createElement('iframe'); f.srcdoc = '<script>parent.postMessage({hw: navigator.hardwareConcurrency, ua: navigator.userAgent}, "*")<\\/script>'; window.addEventListener('message', (e) => { if (e.source === f.contentWindow) res(JSON.stringify(e.data)); }); document.body.appendChild(f); setTimeout(() => res('timeout'), 3000); }); } catch (e) { R['iframe.srcdoc'] = 'ERR'; }
  // blob worker
  const workerSrc = 'postMessage({hw: navigator.hardwareConcurrency, ua: navigator.userAgent, lang: navigator.languages, platform: navigator.platform})';
  try { R['worker.blob'] = await new Promise((res, rej) => { const w = new Worker(URL.createObjectURL(new Blob([workerSrc]))); w.onmessage = (e) => res(JSON.stringify(e.data)); w.onerror = () => res('worker-error'); setTimeout(() => res('timeout'), 3000); }); } catch (e) { R['worker.blob'] = 'ERR:' + e.name; }
  try { R['worker.file'] = await new Promise((res) => { const w = new Worker('/worker.js'); w.onmessage = (e) => res(JSON.stringify(e.data)); w.onerror = () => res('worker-error'); setTimeout(() => res('timeout'), 3000); }); } catch (e) { R['worker.file'] = 'ERR:' + e.name; }
  try { R['serviceWorker'] = typeof navigator.serviceWorker; } catch (e) {}
  try { const r = await fetch('/ua'); R['uaHeader'] = await r.text(); } catch (e) { R['uaHeader'] = 'ERR'; }
  R['uaVsHeader'] = String(navigator.userAgent === R['uaHeader']);
  try { const r = await fetch('/al'); R['acceptLanguageHeader'] = await r.text(); } catch (e) { R['acceptLanguageHeader'] = 'ERR'; }
  document.documentElement.dataset.detect = JSON.stringify(R);
  document.documentElement.dataset.done = '1';
};
run();
`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (type, body, headers = {}) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(body); };
  switch (u.pathname) {
    case '/detect.html': return send('text/html', `<!doctype html><html><head><meta charset=utf-8><title>detect</title><script>window.__earlyHw = navigator.hardwareConcurrency;</script></head><body><script src="/detect.js"></script></body></html>`);
    case '/detect.js': return send('text/javascript', DETECT);
    case '/worker.js': return send('text/javascript', 'postMessage({hw: navigator.hardwareConcurrency, ua: navigator.userAgent, lang: navigator.languages, platform: navigator.platform})');
    case '/ua': return send('text/plain', req.headers['user-agent'] ?? '');
    case '/al': return send('text/plain', req.headers['accept-language'] ?? '');
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
