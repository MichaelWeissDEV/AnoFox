import http from 'node:http';
import { writeFileSync } from 'node:fs';
const PORT = Number(process.env.PROBE_PORT ?? 18778);
const referers = [];
const FP = `
const out = {};
const t = (n, f) => { try { const v = f(); out[n] = (v && typeof v === 'object') ? JSON.stringify(v) : String(v); } catch (e) { out[n] = 'ERR:' + e.name; } };
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); };
t('userAgent', () => navigator.userAgent);
t('platform', () => navigator.platform);
t('oscpu', () => navigator.oscpu);
t('appVersion', () => navigator.appVersion);
t('buildID', () => navigator.buildID);
t('languages', () => navigator.languages);
t('hardwareConcurrency', () => navigator.hardwareConcurrency);
t('deviceMemory', () => navigator.deviceMemory);
t('maxTouchPoints', () => navigator.maxTouchPoints);
t('plugins', () => navigator.plugins.length);
t('doNotTrack', () => navigator.doNotTrack);
t('globalPrivacyControl', () => navigator.globalPrivacyControl);
t('userAgentData', () => typeof navigator.userAgentData);
t('connection', () => typeof navigator.connection);
t('getBattery', () => typeof navigator.getBattery);
t('screen', () => [screen.width, screen.height, screen.availWidth, screen.availHeight, screen.colorDepth, screen.pixelDepth]);
t('window', () => [innerWidth, innerHeight, outerWidth, outerHeight, screenX, screenY]);
t('dpr', () => devicePixelRatio);
t('timezone', () => Intl.DateTimeFormat().resolvedOptions().timeZone);
t('tzOffset', () => new Date().getTimezoneOffset());
t('locale', () => Intl.DateTimeFormat().resolvedOptions().locale);
t('dateString', () => new Date(0).toString());
t('numberFormat', () => (1234567.891).toLocaleString());
t('colorScheme', () => matchMedia('(prefers-color-scheme: dark)').matches);
t('reducedMotion', () => matchMedia('(prefers-reduced-motion: reduce)').matches);
t('perfResolution', () => { const a = []; for (let i = 0; i < 50; i++) a.push(performance.now()); const d = a.slice(1).map((x, i) => x - a[i]).filter((x) => x > 0); return d.length ? Math.min(...d) : 0; });
t('dateNowMod', () => { const s = new Set(); for (let i = 0; i < 2000; i++) s.add(Date.now() % 100); return [...s].every((x) => x % 100 === 0) ? 'rounded-100' : (Math.max(...s) < 100 ? 'ms' : 'ms'); });
t('canvas', () => { const c = document.createElement('canvas'); c.width = 200; c.height = 50; const x = c.getContext('2d'); x.textBaseline = 'top'; x.font = '16px Arial'; x.fillStyle = '#f60'; x.fillRect(10, 5, 80, 30); x.fillStyle = '#069'; x.fillText('AnoFox fp \\u{1F98A} 123', 4, 8); x.strokeStyle = 'rgba(100,200,0,0.7)'; x.arc(120, 25, 15, 0, 6.28); x.stroke(); return hash(c.toDataURL()); });
t('canvasGetImageData', () => { const c = document.createElement('canvas'); c.width = 20; c.height = 20; const x = c.getContext('2d'); x.fillStyle = 'rgb(10,20,30)'; x.fillRect(0, 0, 20, 20); const d = x.getImageData(0, 0, 1, 1).data; return [...d]; });
t('webgl', () => { const g = document.createElement('canvas').getContext('webgl'); if (!g) return 'none'; const e = g.getExtension('WEBGL_debug_renderer_info'); return { vendor: g.getParameter(g.VENDOR), renderer: g.getParameter(g.RENDERER), unmasked: e ? [g.getParameter(e.UNMASKED_VENDOR_WEBGL), g.getParameter(e.UNMASKED_RENDERER_WEBGL)] : 'no-ext', maxTex: g.getParameter(g.MAX_TEXTURE_SIZE), ext: (g.getSupportedExtensions() || []).length }; });
t('fonts', () => { const base = ['monospace', 'sans-serif', 'serif']; const test = ['Arial', 'Helvetica', 'Times New Roman', 'Courier New', 'Verdana', 'Georgia', 'Menlo', 'Monaco', 'Consolas', 'Calibri', 'Cambria', 'Comic Sans MS', 'Impact', 'Lucida Grande', 'Segoe UI', 'Roboto', 'Ubuntu', 'DejaVu Sans', 'Noto Sans', 'SF Pro Text', 'Apple Color Emoji']; const c = document.createElement('canvas').getContext('2d'); const w = (f) => { c.font = '72px ' + f; return c.measureText('mmmmmmmmmmlli').width; }; const bw = base.map((b) => (c.font = '72px ' + b, c.measureText('mmmmmmmmmmlli').width)); return test.filter((f) => base.some((b, i) => (c.font = '72px "' + f + '",' + b, c.measureText('mmmmmmmmmmlli').width) !== bw[i])).length + '/' + test.length; });
t('speechVoices', () => (speechSynthesis.getVoices() || []).length);
t('mediaCapabilities', () => typeof navigator.mediaCapabilities);
t('canPlayH264', () => document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'));
t('canPlayOpus', () => document.createElement('audio').canPlayType('audio/ogg; codecs="opus"'));
t('webgpu', () => typeof navigator.gpu);
t('sharedArrayBuffer', () => typeof SharedArrayBuffer);
t('wasm', () => typeof WebAssembly);
t('gamepads', () => navigator.getGamepads ? navigator.getGamepads().length : 'n/a');
t('storageEstimate', () => typeof navigator.storage.estimate);
t('referrerPolicyMeta', () => document.referrer);
document.documentElement.dataset.fp = JSON.stringify(out);
const to = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(label), { name: 'Timeout' })), ms))]);
(async () => {
  const extra = {};
  try { const ctx = new OfflineAudioContext(1, 44100, 44100); const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 10000; const comp = ctx.createDynamicsCompressor(); o.connect(comp); comp.connect(ctx.destination); o.start(0); const buf = await to(ctx.startRendering(), 3000, 'audio'); const d = buf.getChannelData(0); let s = 0; for (let i = 4500; i < 5000; i++) s += Math.abs(d[i]); extra.audio = String(s); } catch (e) { extra.audio = 'ERR:' + e.name; }
  try { const devs = await to(navigator.mediaDevices.enumerateDevices(), 3000, 'devices'); extra.mediaDevices = devs.length; } catch (e) { extra.mediaDevices = 'ERR:' + e.name; }
  try { const p = await to(navigator.permissions.query({ name: 'geolocation' }), 3000, 'perm'); extra.permGeo = p.state; } catch (e) { extra.permGeo = 'ERR:' + e.name; }
  try { extra.rtc = await new Promise((resolve) => { const pc = new RTCPeerConnection({ iceServers: [] }); const cands = []; pc.createDataChannel('x'); pc.onicecandidate = (e) => { if (e.candidate) cands.push(e.candidate.candidate); else resolve(cands); }; pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => resolve(['ERR'])); setTimeout(() => resolve(cands), 3000); }); extra.rtcCount = extra.rtc.length; extra.rtcHasIpLiteral = extra.rtc.some((c) => /\\b\\d{1,3}(\\.\\d{1,3}){3}\\b/.test(c)); extra.rtcMdns = extra.rtc.some((c) => /\\.local\\b/.test(c)); delete extra.rtc; } catch (e) { extra.rtcCount = 'ERR:' + e.name; }
  document.documentElement.dataset.fpExtra = JSON.stringify(extra);
  document.documentElement.dataset.fpDone = '1';
})();
`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (type, body, headers = {}) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(body); };
  switch (u.pathname) {
    case '/fp.html': return send('text/html', `<!doctype html><title>fp</title><body><img src="/ref-target?t=${Date.now()}"><script src="/fp.js"></script></body>`);
    case '/fp.js': return send('text/javascript', FP);
    case '/link.html': return send('text/html', `<!doctype html><title>link</title><body>link page</body>`);
    case '/ref-target': referers.push(req.headers['referer'] ?? null); return send('text/html', '<!doctype html><title>target</title>ok');
    case '/ref-log': return send('application/json', JSON.stringify(referers));
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
