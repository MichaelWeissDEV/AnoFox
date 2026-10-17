/**
 * Virtual-host test server for the end-to-end suite. All test hostnames are routed here through a PAC proxy, so the
 * extension sees ordinary default-port origins. The request log is the ground truth for "was it blocked BEFORE the
 * network?": a blocked request must never show up in it.
 */
import http from 'node:http';
import { writeFileSync } from 'node:fs';
const PORT = Number(process.env.PROBE_PORT ?? 18790);
const requests = [];
const STATE = `(async () => { const s = {}; try { s.ls = localStorage.getItem('k') ? 1 : 0; } catch (e) { s.ls = 'ERR'; } s.cookies = document.cookie.split('; ').filter(Boolean).map((c) => c.split('=')[0]).sort().join(','); document.documentElement.dataset.state = JSON.stringify(s); document.documentElement.dataset.ready = '1'; })();`;
const server = http.createServer((req, res) => {
  const host = (req.headers.host ?? '').split(':')[0];
  const u = new URL(req.url, 'http://x');
  const send = (type, body, headers = {}, status = 200) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(body); };
  if (!u.pathname.startsWith('/__') && u.pathname !== '/proxy.pac' && u.pathname !== '/report' && u.pathname !== '/favicon.ico') {
    requests.push({ host, url: `${u.pathname}${u.search}`, ua: undefined });
  }
  switch (u.pathname) {
    case '/proxy.pac': return send('application/x-ns-proxy-autoconfig', `function FindProxyForURL(url, host) { if (host === '127.0.0.1' || host === 'localhost') return 'DIRECT'; return 'PROXY 127.0.0.1:${PORT}'; }`);
    case '/__ping': console.log('PING', u.searchParams.get('m')); return send('text/plain', 'ok');
    case '/__log': return send('application/json', JSON.stringify(requests));
    case '/__reset': requests.length = 0; return send('text/plain', 'ok');
    case '/clean': return send('text/html', '<!doctype html><title>clean</title>ok');
    case '/scripts.html': return send('text/html', `<!doctype html><html><head><title>s</title></head><body><script>document.title += ' inline';</script><script src="/first.js"></script><script src="http://anofox-t.net/third.js"></script></body></html>`);
    case '/first.js': return send('text/javascript', "document.title += ' first';");
    case '/third.js': return send('text/javascript', "document.title += ' third';");
    case '/ok.js': return send('text/javascript', "document.title += ' ok';");
    case '/ad-tracker.js': return send('text/javascript', "document.title += ' adtracker';");
    case '/imp.js': return send('text/javascript', "document.title += ' imp';");
    case '/embed.html': return send('text/html', '<!doctype html><title>embed</title><p id="x">page</p><iframe id="emb" src="http://player.twitch.tv/?channel=x" width="300" height="150"></iframe>');
    case '/': return send('text/html', '<!doctype html><title>twitch</title>player');
    case '/adblock.html': return send('text/html', '<!doctype html><title>ab</title><div class="ad-banner">AD</div><div class="site-ad">SA</div><div class="keep" id="content">C</div><script src="http://anofox-t.net/ad-tracker.js"></script><script src="http://anofox-t.net/ok.js"></script><script src="http://anofox-t.net/imp.js"></script>');
    case '/cookie.html': return send('text/html', '<!doctype html><title>cookie</title><script>localStorage.setItem("k","v"); document.cookie = "js=1; Max-Age=3600; path=/"; document.documentElement.dataset.ready = "1";</script>', { 'set-cookie': ['sid=1; Path=/; HttpOnly', 'pers=1; Path=/; Max-Age=3600'] });
    case '/state.html': return send('text/html', `<!doctype html><title>state</title><script>${STATE}</script>`);
    case '/favicon.ico': res.writeHead(404); return res.end();
    case '/report': {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { writeFileSync(process.argv[2] ?? 'result.json', body); res.writeHead(200); res.end('ok'); setTimeout(() => process.exit(0), 200); });
      return;
    }
    default: return send('text/plain', 'not found', {}, 404);
  }
});
server.listen(PORT, '127.0.0.1');
