/**
 * Virtual-host test server for the end-to-end suite. All test hostnames are routed here through a PAC proxy, so the
 * extension sees ordinary default-port origins. The request log is the ground truth for "was it blocked BEFORE the
 * network?": a blocked request must never show up in it.
 */
import http from 'node:http';
import { writeFileSync } from 'node:fs';
const PORT = Number(process.env.PROBE_PORT ?? 18790);
const requests = [];

// ---- cookie-banner fixtures: DOM reproduces the documented structure of each CMP; they are NOT the vendors' scripts.
// A click on [data-act] drives the fake CMP: "reject"/"accept" record the outcome in <html data-consent> and remove the dialog.
const CMP_SHARED = `
window.__set = (v) => { document.documentElement.dataset.consent = v; document.querySelectorAll('[data-cmp-root]').forEach((e) => e.remove()); };
const act = (e) => {
  const b = e.target.closest && e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'reject') window.__set('rejected');
  else if (a === 'accept') window.__set('accepted');
  else if (a === 'open-pc') { const pc = document.querySelector('[data-pc]'); if (pc) pc.style.display = 'block'; }
  else if (a === 'selection') window.__set('selection:' + [...document.querySelectorAll('[data-cmp-root] input[type=checkbox]')].filter((c) => c.checked).map((c) => c.name).join(','));
  else if (a === 'other') document.documentElement.dataset.other = '1';
};
document.addEventListener('click', act);
window.__mount = (html, delay) => setTimeout(() => { document.body.insertAdjacentHTML('beforeend', html); }, delay);
`;
const BAR = 'position:fixed;left:0;right:0;bottom:0;height:40px;background:#fff;border-top:1px solid #999;z-index:9999';
const CMPS = {
  onetrust: `<div data-cmp-root id="onetrust-consent-sdk"><div id="onetrust-banner-sdk" style="${BAR}"><button id="onetrust-pc-btn-handler" data-act="open-pc">Cookie Settings</button><button id="onetrust-reject-all-handler" data-act="reject">Reject All</button><button id="onetrust-accept-btn-handler" data-act="accept">Accept All Cookies</button></div></div>`,
  'onetrust-pc': `<div data-cmp-root id="onetrust-consent-sdk"><div id="onetrust-banner-sdk" style="${BAR}"><button id="onetrust-pc-btn-handler" data-act="open-pc">Cookie Settings</button><button id="onetrust-accept-btn-handler" data-act="accept">Accept All Cookies</button></div><div id="onetrust-pc-sdk" data-pc style="display:none;position:fixed;left:10px;top:10px;width:300px;height:200px;background:#fff;z-index:10000"><button class="ot-pc-refuse-all-handler" data-act="reject">Reject All</button><button class="save-preference-btn-handler" data-act="accept">Confirm My Choices</button></div></div>`,
  cookiebot: `<div data-cmp-root id="CybotCookiebotDialog" style="${BAR}"><button id="CybotCookiebotDialogBodyButtonDecline" data-act="reject">Decline</button><button id="CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll" data-act="accept">Allow all</button></div>`,
  'cookiebot-selection': `<div data-cmp-root id="CybotCookiebotDialog" style="${BAR}"><label><input type="checkbox" name="necessary" checked disabled>Necessary</label><label><input type="checkbox" name="preferences" checked>Preferences</label><label><input type="checkbox" name="statistics" checked>Statistics</label><label><input type="checkbox" name="marketing" checked>Marketing</label><button id="CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection" data-act="selection">Allow selection</button><button id="CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll" data-act="accept">Allow all</button></div>`,
  klaro: `<div data-cmp-root class="klaro"><div class="cookie-notice" style="${BAR}"><button class="cm-btn cm-btn-success cn-decline" data-act="reject">Decline</button><button class="cm-btn cm-btn-success cn-accept" data-act="accept">Accept</button></div></div>`,
  didomi: `<div data-cmp-root id="didomi-host"><div id="didomi-popup" style="${BAR}"><button id="didomi-notice-agree-button" data-act="accept">Agree &amp; close</button><button id="didomi-notice-disagree-button" data-act="reject">Disagree</button></div></div>`,
  quantcast: `<div data-cmp-root class="qc-cmp2-container" style="${BAR}"><div class="qc-cmp2-summary-buttons"><button mode="secondary" data-act="reject">DISAGREE</button><button mode="primary" data-act="accept">AGREE</button></div></div>`,
  'generic-de': `<div data-cmp-root id="cookie-banner" style="${BAR}"><p>Wir verwenden Cookies.</p><button data-act="accept">Alle akzeptieren</button><button data-act="reject">Nur notwendige</button><button data-act="other">Einstellungen</button></div>`,
  trap: `<div data-cmp-root class="cookie-banner" style="${BAR}"><p>We use cookies.</p><button data-act="accept">Accept all</button><button data-act="other">Customize</button></div>`,
  'trap-spoof': `<div data-cmp-root id="onetrust-consent-sdk"><div id="onetrust-banner-sdk" style="${BAR}"><button id="onetrust-reject-all-handler" data-act="accept">Accept all</button></div></div>`,
  wall: `<div data-cmp-root id="onetrust-consent-sdk"><div class="overlay-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9998"></div><div id="onetrust-banner-sdk" style="position:fixed;left:10%;top:10%;width:80%;height:80%;background:#fff;z-index:9999"><button id="onetrust-reject-all-handler" data-act="reject">Reject All</button><button id="onetrust-accept-btn-handler" data-act="accept">Accept All</button></div></div>`
};

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
    case '/__filter': return send('text/plain', process.env.E2E_FILTER ?? '');
    case '/__ping': console.log('PING', u.searchParams.get('m')); return send('text/plain', 'ok');
    case '/__log': return send('application/json', JSON.stringify(requests));
    case '/__reset': requests.length = 0; return send('text/plain', 'ok');
    case '/threat-sub.html': return send('text/html', '<!doctype html><title>page</title><script src="http://anofox-m.test/s.js"></script><img src="http://anofox-m.test/i.png"><p>content</p>');
    case '/cmp/page.html': { // generic dispatcher: /cmp/page.html?f=<fixture>
      const name = u.searchParams.get('f');
      const html = CMPS[name];
      if (!html) return send('text/plain', 'no such fixture', {}, 404);
      return send('text/html', `<!doctype html><title>${name}</title><body><p>page</p><script>${CMP_SHARED}window.__mount(${JSON.stringify(html)}, ${Number(u.searchParams.get('delay') ?? 600)});</script></body>`);
    }
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
    case '/cmp/usercentrics.html': return send('text/html', `<!doctype html><title>uc</title><body><p>page</p><div id="usercentrics-root"></div><script>${CMP_SHARED}
      setTimeout(() => { const host = document.getElementById('usercentrics-root'); const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<div data-cmp-root data-testid="uc-default-banner" style="${BAR}"><button data-testid="uc-more-button" data-act="open-pc">More</button><button data-testid="uc-deny-all-button" data-act="reject">Deny</button><button data-testid="uc-accept-all-button" data-act="accept">Accept All</button></div>';
        root.addEventListener('click', act); }, 600);
      window.__set = (v) => { document.documentElement.dataset.consent = v; const h = document.getElementById('usercentrics-root'); if (h && h.shadowRoot) h.shadowRoot.innerHTML = ''; };</script></body>`);
    case '/cmp/nonbanner.html': return send('text/html', '<!doctype html><title>article</title><body><article id="article"><h1>Terms</h1><form onsubmit="return false"><button id="accept-terms" onclick="document.documentElement.dataset.clicked=\'accept-terms\'">Accept terms</button><button id="reject-comment" onclick="document.documentElement.dataset.clicked=\'reject-comment\'">Reject comment</button></form></article></body>');
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
