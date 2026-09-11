import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import net from 'node:net';
import tls from 'node:tls';
import { compileWithProvider, getOpenAIImageProvider, publicProviders } from './server/providerRuntime.js';

const readJsonBody = request => new Promise((resolve, reject) => {
  let raw = '';
  request.on('data', chunk => {
    raw += chunk;
  });
  request.on('end', () => {
    try {
      resolve(raw ? JSON.parse(raw) : {});
    } catch (error) {
      reject(error);
    }
  });
  request.on('error', reject);
});

const decodeChunkedBody = body => {
  let offset = 0;
  const chunks = [];
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd === -1) break;
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString('ascii'), 16);
    if (!size) break;
    const chunkStart = lineEnd + 2;
    const chunkEnd = chunkStart + size;
    chunks.push(body.subarray(chunkStart, chunkEnd));
    offset = chunkEnd + 2;
  }
  return Buffer.concat(chunks);
};

const parseHttpResponse = raw => {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) throw new Error('Invalid HTTP response');
  const headerText = raw.subarray(0, headerEnd).toString('utf8');
  const body = raw.subarray(headerEnd + 4);
  const lines = headerText.split('\r\n');
  const status = Number.parseInt(lines[0].split(' ')[1], 10);
  const headers = Object.fromEntries(lines.slice(1).map(line => {
    const index = line.indexOf(':');
    return index === -1 ? null : [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
  }).filter(Boolean));
  const payload = headers['transfer-encoding']?.toLowerCase().includes('chunked') ? decodeChunkedBody(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(payload.toString('utf8') || '{}'),
  };
};

const readSocketResponse = socket => new Promise((resolve, reject) => {
  const chunks = [];
  socket.on('data', chunk => chunks.push(chunk));
  socket.on('end', () => resolve(Buffer.concat(chunks)));
  socket.on('error', reject);
});

const postJsonThroughHttpProxy = (endpoint, payload, headers, proxyUrl, timeout = 300000) => new Promise((resolve, reject) => {
  const target = new URL(endpoint);
  const proxy = new URL(proxyUrl);
  const body = JSON.stringify(payload);
  const proxySocket = net.connect(Number(proxy.port || 80), proxy.hostname);
  const timer = setTimeout(() => {
    proxySocket.destroy();
    reject(new Error('CPASS request timed out'));
  }, timeout);

  proxySocket.once('error', error => {
    clearTimeout(timer);
    reject(error);
  });
  proxySocket.once('connect', () => {
    proxySocket.write(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n\r\n`);
  });

  let connectBuffer = Buffer.alloc(0);
  proxySocket.on('data', function onProxyData(chunk) {
    connectBuffer = Buffer.concat([connectBuffer, chunk]);
    const headerEnd = connectBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    proxySocket.off('data', onProxyData);
    const header = connectBuffer.subarray(0, headerEnd).toString('ascii');
    if (!header.includes(' 200 ')) {
      clearTimeout(timer);
      proxySocket.destroy();
      reject(new Error(`Proxy CONNECT failed: ${header.split('\r\n')[0]}`));
      return;
    }

    const secureSocket = tls.connect({ socket: proxySocket, servername: target.hostname }, () => {
      const requestHeaders = {
        ...headers,
        Host: target.hostname,
        'Content-Length': Buffer.byteLength(body),
        Connection: 'close',
      };
      const request = [
        `POST ${target.pathname}${target.search} HTTP/1.1`,
        ...Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`),
        '',
        body,
      ].join('\r\n');
      secureSocket.write(request);
    });

    secureSocket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    readSocketResponse(secureSocket).then(raw => {
      clearTimeout(timer);
      resolve(parseHttpResponse(raw));
    }).catch(error => {
      clearTimeout(timer);
      reject(error);
    });
  });
});

const imageToGeminiPart = async image => {
  const source = typeof image === 'string' ? image : image?.image;
  if (!source) return null;

  if (source.startsWith('data:')) {
    const match = source.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    return {
      inline_data: {
        mime_type: match[1],
        data: match[2],
      },
    };
  }

  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`参考图读取失败: ${response.status}`);
  }

  const mimeType = response.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
  const data = Buffer.from(await response.arrayBuffer()).toString('base64');
  return {
    inline_data: {
      mime_type: mimeType,
      data,
    },
  };
};

const extractImages = data => {
  const parts = data?.candidates?.flatMap(candidate => candidate?.content?.parts || []) || [];
  return parts.flatMap(part => {
    const inline = part.inline_data || part.inlineData;
    const file = part.file_data || part.fileData;
    if (inline?.data) {
      const mimeType = inline.mime_type || inline.mimeType || 'image/png';
      return [`data:${mimeType};base64,${inline.data}`];
    }
    if (file?.file_uri || file?.fileUri) {
      return [file.file_uri || file.fileUri];
    }
    if (part.text) {
      return part.text.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g) || [];
    }
    return [];
  });
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    base: process.env.GITHUB_PAGES === 'true' ? '/vip-beauty-prompt-studio/' : '/',
    plugins: [
      react(),
      {
        name: 'beauty-prompt-provider-api',
        configureServer(server) {
          server.middlewares.use('/api/providers', async (request, response) => {
            response.setHeader('Content-Type', 'application/json');
            if (request.method !== 'GET') { response.statusCode = 405; response.end(JSON.stringify({ error: 'Method not allowed' })); return; }
            try { response.end(JSON.stringify({ providers: await publicProviders() })); }
            catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
          });
          server.middlewares.use('/api/compile-prompt', async (request, response) => {
            response.setHeader('Content-Type', 'application/json');
            if (request.method !== 'POST') { response.statusCode = 405; response.end(JSON.stringify({ error: 'Method not allowed' })); return; }
            try { response.end(JSON.stringify(await compileWithProvider(await readJsonBody(request)))); }
            catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message || '提示词生成失败' })); }
          });
        },
      },
      {
        name: 'local-generate-image-api',
        configureServer(server) {
          server.middlewares.use('/api/generate-image', async (request, response) => {
            if (request.method !== 'POST') {
              response.statusCode = 405;
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }

            try {
              const body = await readJsonBody(request);
              const expectedPassword = env.GENERATE_PASSWORD || 'rock';
              if (body.password !== expectedPassword) {
                response.statusCode = 401;
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({ error: '生图密码错误' }));
                return;
              }

              const prompt = body.prompt || '';
              const referenceImages = Array.isArray(body.referenceImages) ? body.referenceImages : [];
              const provider = await getOpenAIImageProvider();
              if (!provider.key) throw new Error('OpenAI API 尚未配置');
              const form = new FormData();
              form.append('model', provider.model);
              form.append('prompt', prompt);
              form.append('size', '1344x2224');
              form.append('quality', 'high');
              form.append('output_format', 'png');
              referenceImages.forEach((source, index) => {
                const match = String(source).match(/^data:([^;]+);base64,(.+)$/);
                if (match) form.append('image[]', new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }), `product-${index + 1}.png`);
              });
              const apiResponse = await fetch(`${provider.base}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${provider.key}` }, body: form, signal: AbortSignal.timeout(300000) });

              const data = await apiResponse.json();
              if (!apiResponse.ok) {
                throw new Error(data?.error?.message || `API 请求失败 (${apiResponse.status})`);
              }

              const images = (data.data || []).map(item => item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url).filter(Boolean);
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify({ images, raw: images.length ? undefined : data }));
            } catch (error) {
              response.statusCode = 500;
              response.setHeader('Content-Type', 'application/json');
              const message = error?.message === 'fetch failed'
                ? '无法连接到 OpenAI，请检查本机网络或代理设置'
                : error?.message || '生图失败';
              response.end(JSON.stringify({ error: message }));
            }
          });
        },
      },
    ],
  };
});
