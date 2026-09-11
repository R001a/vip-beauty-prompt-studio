import { compilePrompt } from './_compilePromptCore.js';

const applyCors = (request, response) => {
  const allowed = process.env.ALLOWED_ORIGIN || 'https://r001a.github.io';
  const origin = request.headers?.origin;
  if (origin === allowed) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Vary', 'Origin');
};

export default async function handler(request, response) {
  applyCors(request, response);
  if (request.method === 'OPTIONS') { response.status(204).end(); return; }
  if (request.method !== 'POST') { response.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    response.status(200).json(await compilePrompt(request.body || {}));
  } catch (error) { response.status(500).json({ error: error?.message || '提示词生成失败' }); }
}
