// Preview server for the packaged XHS minitool (dist/xhs-tool).
// Static only; the package itself must stay offline-capable, this server is
// just a local preview harness. Rebuild with scripts/build-minitool.py first.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.env.FILMIFY_TEST_ROOT || path.join(__dirname, '..', 'dist', 'xhs-tool'));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
};

function arg(name, fallback) {
  const prefix = '--' + name + '=';
  const hit = process.argv.find(a => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = process.argv.indexOf('--' + name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env[name.toUpperCase()] || fallback;
}

const port = Number(arg('port', 7100));
// 默认监听全部 IPv4 接口以便手机测试；仅本机使用时传 --host 127.0.0.1。
const host = arg('host', '0.0.0.0');

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('dist/xhs-tool 不存在，请先运行: python3 scripts/build-minitool.py');
  process.exit(1);
}

const browserAdapter = path.resolve(__dirname, '../minitool/browser-save.js');
const nativePreview = arg('native', 'false') === 'true';

const PREVIEW = path.resolve(__dirname, 'preview');

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
  }
  let url;
  try { url = decodeURIComponent(req.url.split('?')[0]); }
  catch (_) { res.writeHead(400); res.end('bad request'); return; }
  if (url.includes('\0')) { res.writeHead(400); res.end('bad request'); return; }
  if (url === '/browser-save.js' && !nativePreview) {
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(browserAdapter)); return;
  }
  let base = ROOT, rel = url;
  if (url === '/preview' || url.startsWith('/preview/')) { base = PREVIEW; rel = url.slice(8) || '/'; }
  const candidate = rel === '' || rel === '/' ? path.join(base, 'index.html')
    : rel.endsWith('/') ? path.join(base, rel, 'index.html')
    : path.join(base, rel);
  let file;
  try {
    const realBase = fs.realpathSync(base);
    file = fs.realpathSync(candidate);
    const relative = path.relative(realBase, file);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !fs.statSync(file).isFile()) throw new Error('outside preview root');
  } catch (_) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') { res.end(); return; }
  if (!nativePreview && file === path.join(ROOT, 'index.html')) {
    const html = fs.readFileSync(file, 'utf8').replace('<script src="./app.js"></script>', '<script src="./browser-save.js"></script>\n <script src="./app.js"></script>');
    res.end(html); return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});
server.listen(port, host, () => {
  const actualPort = server.address().port;
  console.log('Filmify 小工具预览: http://' + host + ':' + actualPort + '/');
  console.log('屏幕尺寸测试台: http://' + host + ':' + actualPort + '/preview/');
  if (host === '0.0.0.0') {
    const nets = require('node:os').networkInterfaces();
    for (const list of Object.values(nets)) for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) console.log('局域网入口（手机浏览器打开）: http://' + n.address + ':' + actualPort + '/');
    }
  }
});
