import { BEAUTY_V5_SYSTEM_PROMPT } from '../server/beautySkillPrompt.js';

const applyCors = (request, response) => {
  const allowed = process.env.ALLOWED_ORIGIN || 'https://r001a.github.io';
  const origin = request.headers?.origin;
  if (origin === allowed) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Vary', 'Origin');
};

const getProvider = id => ({
  openai: { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', path: '/responses', model: process.env.OPENAI_MODEL || 'gpt-5.6', name: 'OpenAI GPT-5.6', responses: true },
  kimi: { key: process.env.KIMI_API_KEY, base: process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1', path: '/chat/completions', model: process.env.KIMI_MODEL || 'kimi-k3', name: 'Kimi K3' },
  cpass: { key: process.env.CPASS_API_KEY, base: process.env.CPASS_BASE_URL || 'https://api.cpass.cc', path: '/v1/chat/completions', model: process.env.CPASS_MODEL || 'gpt-5.6-terra', name: 'CPASS 平台 GPT-5.6 Terra' },
})[id];

export default async function handler(request, response) {
  applyCors(request, response);
  if (request.method === 'OPTIONS') { response.status(204).end(); return; }
  if (request.method !== 'POST') { response.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const { providerId, mode, images, notes = {} } = request.body || {};
    const provider = getProvider(providerId);
    if (!provider?.key) throw new Error('所选解析模型尚未配置');
    if (!Array.isArray(images) || images.length < 3 || images.some(image => !String(image).startsWith('data:image/'))) throw new Error('图片读取失败或素材数量不足');
    const instruction = `输出模式：${mode === 'batch' ? 'batch（Lovart整套批量）' : 'pages（逐屏独立）'}。\n产品备注：${JSON.stringify(notes.productNotes || [])}\n运营补充：${notes.operationsNote || '无'}\n风格补充：${notes.styleNote || '无'}\n请先逐张确认图片可读，再严格执行V5编译。`;
    const body = provider.responses
      ? { model: provider.model, instructions: BEAUTY_V5_SYSTEM_PROMPT, input: [{ role: 'user', content: [{ type: 'input_text', text: instruction }, ...images.map(image_url => ({ type: 'input_image', image_url }))] }], reasoning: { effort: 'high' } }
      : { model: provider.model, messages: [{ role: 'system', content: BEAUTY_V5_SYSTEM_PROMPT }, { role: 'user', content: [{ type: 'text', text: instruction }, ...images.map(image => ({ type: 'image_url', image_url: { url: image } }))] }] };
    const upstream = await fetch(`${provider.base}${provider.path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(240000) });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) throw new Error(data?.error?.message || `模型请求失败（${upstream.status}）`);
    const text = provider.responses ? data.output_text || data.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text : data.choices?.[0]?.message?.content;
    if (!text) throw new Error('模型未返回可用提示词');
    response.status(200).json({ text, provider: provider.name, model: provider.model });
  } catch (error) { response.status(500).json({ error: error?.message || '提示词生成失败' }); }
}
