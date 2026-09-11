const { app, BrowserWindow, dialog } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HOST = '127.0.0.1';
const PORT = 41733;
const CONFIG_PASSWORD = 'rock';

const parseEnv = text => Object.fromEntries(String(text).split(/\r?\n/).flatMap(line => {
  const value = line.trim();
  if (!value || value.startsWith('#')) return [];
  const index = value.indexOf('=');
  return index < 0 ? [] : [[value.slice(0, index).trim(), value.slice(index + 1).trim()]];
}));

const loadSecureConfig = () => {
  const encryptedPath = path.join(__dirname, 'secure-config.enc');
  const payload = JSON.parse(fs.readFileSync(encryptedPath, 'utf8'));
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const encrypted = Buffer.from(payload.data, 'base64');
  const key = crypto.pbkdf2Sync(CONFIG_PASSWORD, salt, 210000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decoded = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  const config = JSON.parse(decoded);
  for (const content of Object.values(config.files || {})) {
    for (const [name, value] of Object.entries(parseEnv(content))) {
      if (value) process.env[name] = value;
    }
  }
};

const readBody = request => new Promise((resolve, reject) => {
  const chunks = [];
  let length = 0;
  request.on('data', chunk => {
    length += chunk.length;
    if (length > 100 * 1024 * 1024) {
      reject(new Error('上传内容超过 100MB'));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
    catch { reject(new Error('请求内容格式错误')); }
  });
  request.on('error', reject);
});

const adaptResponse = response => {
  response.status = code => { response.statusCode = code; return response; };
  response.json = value => {
    if (!response.headersSent) response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(value));
    return response;
  };
  return response;
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

const createLocalServer = async () => {
  loadSecureConfig();
  const [{ default: providers }, { default: compilePrompt }, { default: generateImage }] = await Promise.all([
    import('../api/providers.js'), import('../api/compile-prompt.js'), import('../api/generate-image.js'),
  ]);
  const handlers = {
    '/api/providers': providers,
    '/api/compile-prompt': compilePrompt,
    '/api/generate-image': generateImage,
  };
  const dist = path.join(__dirname, '..', 'dist');
  const server = http.createServer(async (request, rawResponse) => {
    const response = adaptResponse(rawResponse);
    const url = new URL(request.url, `http://${HOST}:${PORT}`);
    try {
      const handler = handlers[url.pathname];
      if (handler) {
        request.query = Object.fromEntries(url.searchParams);
        request.body = request.method === 'POST' ? await readBody(request) : {};
        await handler(request, response);
        return;
      }
      const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const candidate = path.resolve(dist, requested);
      const safe = candidate.startsWith(`${path.resolve(dist)}${path.sep}`) || candidate === path.join(dist, 'index.html');
      const filePath = safe && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : path.join(dist, 'index.html');
      response.statusCode = 200;
      response.setHeader('Content-Type', mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
      fs.createReadStream(filePath).pipe(response);
    } catch (error) {
      if (!response.writableEnded) response.status(500).json({ error: error?.message || '本地服务异常' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  return server;
};

let localServer;
const smokeTest = process.argv.includes('--smoke-test');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.whenReady().then(async () => {
  try {
    localServer = await createLocalServer();
    const window = new BrowserWindow({
      width: 1440, height: 960, minWidth: 1100, minHeight: 720,
      title: '唯品会美妆工作台', backgroundColor: '#0b0908', show: !smokeTest,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await window.loadURL(`http://${HOST}:${PORT}`);
    if (smokeTest) setTimeout(() => app.quit(), 60000).unref();
  } catch (error) {
    dialog.showErrorBox('启动失败', error?.message || String(error));
    app.quit();
  }
});

app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => localServer?.close());
