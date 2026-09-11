import { createHash, createHmac, randomUUID } from 'node:crypto';

const endpoint = `${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/images/edits`;
const imageModel = 'gpt-image-2.5-sunburst';
const apiVersion = 'openai-sunburst-cos-v3';

const jsonError = (response, status, message, details = {}) => {
  response.status(status).json({ error: { message, ...details } });
};

const applyCors = (request, response) => {
  const allowed = process.env.ALLOWED_ORIGIN || 'https://r001a.github.io';
  const origin = request.headers?.origin;
  if (origin === allowed) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Vary', 'Origin');
};

const imageToPart = image => {
  const source = typeof image === 'string' ? image : image?.image;
  if (!source) return null;
  const match = source.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    inline_data: {
      mime_type: match[1],
      data: match[2],
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

const getPngDimensions = buffer => {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
};

const getJpegDimensions = buffer => {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
};

const getImageDimensions = dataUrl => {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  if (match[1].includes('png')) return getPngDimensions(buffer);
  if (match[1].includes('jpeg') || match[1].includes('jpg')) return getJpegDimensions(buffer);
  return null;
};

const selectLargestImages = images => {
  const measured = images.map((image, index) => {
    const dimensions = getImageDimensions(image);
    const area = dimensions ? dimensions.width * dimensions.height : 0;
    return { image, index, dimensions, area };
  });
  const maxArea = Math.max(...measured.map(item => item.area));
  if (maxArea <= 0) return images;
  const largest = measured
    .filter(item => item.area === maxArea)
    .sort((a, b) => a.index - b.index)
    .map(item => item.image);
  return largest.slice(0, 1);
};

const parseJsonResponse = async apiResponse => {
  const text = await apiResponse.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: { message: text || `API request failed (${apiResponse.status})` } };
  }
};

const hmacSha1 = (key, value, encoding = 'hex') => createHmac('sha1', key).update(value).digest(encoding);
const sha1 = value => createHash('sha1').update(value).digest('hex');
const encodeCosPath = key => `/${key.split('/').map(encodeURIComponent).join('/')}`;

const createCosAuthorization = ({ method, key, host, mimeType, secretId, secretKey }) => {
  const now = Math.floor(Date.now() / 1000);
  const signTime = `${now - 60};${now + 900}`;
  const pathname = `/${key}`;
  const headerList = 'host';
  const headers = `host=${host}`;
  const httpString = `${method.toLowerCase()}\n${pathname}\n\n${headers}\n`;
  const stringToSign = `sha1\n${signTime}\n${sha1(httpString)}\n`;
  const signKey = hmacSha1(secretKey, signTime);
  const signature = hmacSha1(signKey, stringToSign);
  return [
    'q-sign-algorithm=sha1',
    `q-ak=${secretId}`,
    `q-sign-time=${signTime}`,
    `q-key-time=${signTime}`,
    `q-header-list=${headerList}`,
    'q-url-param-list=',
    `q-signature=${signature}`,
  ].join('&');
};

export const uploadDataImageToCos = async (dataUrl, index) => {
  const secretId = process.env.COS_SECRET_ID?.trim();
  const secretKey = process.env.COS_SECRET_KEY?.trim();
  const bucket = process.env.COS_BUCKET?.trim().replace(/\s+/g, '');
  const region = (process.env.COS_REGION || 'ap-shanghai').trim().replace(/\s+/g, '');
  const prefix = (process.env.COS_UPLOAD_PREFIX || 'ai-virtual-director/generated').replace(/^\/+|\/+$/g, '');

  if (!secretId || !secretKey || !bucket) {
    throw new Error('Missing COS upload environment variables');
  }

  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return dataUrl;

  const mimeType = match[1] || 'image/jpeg';
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const buffer = Buffer.from(match[2], 'base64');
  const date = new Date().toISOString().slice(0, 10);
  const key = `${prefix}/${date}/${Date.now()}-${index + 1}-${randomUUID()}.${ext}`;
  const host = `${bucket}.cos.${region}.myqcloud.com`;
  const url = `https://${host}${encodeCosPath(key)}`;
  const authorization = createCosAuthorization({
    method: 'PUT',
    key,
    host,
    mimeType,
    secretId,
    secretKey,
  });

  const uploadResponse = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'Content-Type': mimeType,
      'Content-Length': String(buffer.length),
    },
    body: buffer,
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(`COS 上传失败 (${uploadResponse.status}): ${errorText.slice(0, 300)}`);
  }

  return url;
};

export default async function handler(request, response) {
  applyCors(request, response);
  if (request.method === 'OPTIONS') { response.status(204).end(); return; }
  if (request.method !== 'POST') {
    jsonError(response, 405, 'Method not allowed');
    return;
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const expectedPassword = process.env.GENERATE_PASSWORD || 'rock';
    if (!apiKey) {
      jsonError(response, 500, 'Missing OPENAI_API_KEY');
      return;
    }
    if (request.body?.password !== expectedPassword) {
      jsonError(response, 401, '生图密码错误');
      return;
    }

    const prompt = request.body?.prompt || '';
    const referenceImages = Array.isArray(request.body?.referenceImages) ? request.body.referenceImages : [];
    const requestedImageSize = '1344x2224';
    const requestedAspectRatio = '约 133:220';
    const form = new FormData();
    form.append('model', imageModel);
    form.append('prompt', prompt);
    form.append('size', requestedImageSize);
    form.append('quality', 'high');
    form.append('output_format', 'png');
    referenceImages.forEach((source, index) => {
      const match = String(source).match(/^data:([^;]+);base64,(.+)$/);
      if (match) form.append('image[]', new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }), `product-${index + 1}.png`);
    });

    const apiResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
    });

    const data = await parseJsonResponse(apiResponse);
    if (!apiResponse.ok) {
      jsonError(response, apiResponse.status, data?.error?.message || data?.error || `API 请求失败 (${apiResponse.status})`, {
        requestedImageSize,
        requestedAspectRatio,
      });
      return;
    }

    const images = (data.data || []).map(item => item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url).filter(Boolean);
    if (!images.length) {
      jsonError(response, 502, 'OpenAI did not return a usable image', {
        requestedImageSize,
        requestedAspectRatio,
      });
      return;
    }
    const selectedImages = selectLargestImages(images);
    const uploadedImages = await Promise.all(selectedImages.map(uploadDataImageToCos));
    response.status(200).json({
      images: uploadedImages,
      imageCount: uploadedImages.length,
      rawImageCount: images.length,
      requestedImageSize,
      requestedAspectRatio,
      apiVersion,
      imageModel,
    });
  } catch (error) {
    jsonError(response, 500, error?.message || '生图失败');
  }
}
