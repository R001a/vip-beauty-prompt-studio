import { randomUUID } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { compilePrompt } from './_compilePromptCore.js';
import { readPromptJob, writePromptJob } from './_promptJobStore.js';

export const maxDuration = 300;

const applyCors = (request, response) => {
  const allowed = process.env.ALLOWED_ORIGIN || 'https://r001a.github.io';
  const origin = request.headers?.origin;
  if (origin === allowed) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Vary', 'Origin');
};

export default async function handler(request, response) {
  applyCors(request, response);
  if (request.method === 'OPTIONS') return response.status(204).end();
  if (request.method === 'GET') {
    const id = String(request.query?.id || '');
    if (!/^[a-f0-9-]{36}$/i.test(id)) return response.status(400).json({ error: '任务编号无效' });
    const job = await readPromptJob(id);
    return job ? response.status(200).json(job) : response.status(404).json({ error: '任务不存在或已过期' });
  }
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  await writePromptJob(id, { id, status: 'processing', createdAt });
  waitUntil((async () => {
    try {
      const result = await compilePrompt(request.body || {});
      await writePromptJob(id, { id, status: 'complete', createdAt, completedAt: new Date().toISOString(), ...result });
    } catch (error) {
      await writePromptJob(id, { id, status: 'error', createdAt, completedAt: new Date().toISOString(), error: error?.message || '提示词生成失败' });
    }
  })());
  return response.status(202).json({ id, status: 'processing' });
}
