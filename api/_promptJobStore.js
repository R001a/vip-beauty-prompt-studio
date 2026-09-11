import { createHash, createHmac } from 'node:crypto';

const hmacSha1 = (key, value, encoding = 'hex') => createHmac('sha1', key).update(value).digest(encoding);
const sha1 = value => createHash('sha1').update(value).digest('hex');
const encodePath = key => `/${key.split('/').map(encodeURIComponent).join('/')}`;

const config = () => {
  const secretId = process.env.COS_SECRET_ID?.trim();
  const secretKey = process.env.COS_SECRET_KEY?.trim();
  const bucket = process.env.COS_BUCKET?.trim().replace(/\s+/g, '');
  const region = (process.env.COS_REGION || 'ap-shanghai').trim().replace(/\s+/g, '');
  const prefix = (process.env.COS_UPLOAD_PREFIX || 'beauty/generated').replace(/^\/+|\/+$/g, '');
  if (!secretId || !secretKey || !bucket) throw new Error('提示词任务存储尚未配置');
  return { secretId, secretKey, bucket, region, prefix };
};

const authorization = ({ method, key, host, secretId, secretKey }) => {
  const now = Math.floor(Date.now() / 1000);
  const signTime = `${now - 60};${now + 900}`;
  const httpString = `${method.toLowerCase()}\n/${key}\n\nhost=${host}\n`;
  const signKey = hmacSha1(secretKey, signTime);
  const signature = hmacSha1(signKey, `sha1\n${signTime}\n${sha1(httpString)}\n`);
  return `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${signTime}&q-key-time=${signTime}&q-header-list=host&q-url-param-list=&q-signature=${signature}`;
};

const jobTarget = id => {
  const settings = config();
  const key = `${settings.prefix}/prompt-jobs/${id}.json`;
  const host = `${settings.bucket}.cos.${settings.region}.myqcloud.com`;
  return { ...settings, key, host, url: `https://${host}${encodePath(key)}` };
};

export const writePromptJob = async (id, value) => {
  const target = jobTarget(id);
  const body = JSON.stringify(value);
  const result = await fetch(target.url, {
    method: 'PUT',
    headers: {
      Authorization: authorization({ method: 'PUT', ...target }),
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
  });
  if (!result.ok) throw new Error(`提示词任务保存失败（${result.status}）`);
};

export const readPromptJob = async id => {
  const target = jobTarget(id);
  const result = await fetch(target.url, {
    headers: { Authorization: authorization({ method: 'GET', ...target }) },
    cache: 'no-store',
  });
  if (result.status === 404) return null;
  if (!result.ok) throw new Error(`提示词任务读取失败（${result.status}）`);
  return result.json();
};
