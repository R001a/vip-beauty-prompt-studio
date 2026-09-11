const applyCors = (request, response) => {
  const allowed = process.env.ALLOWED_ORIGIN || 'https://r001a.github.io';
  const origin = request.headers?.origin;
  if (origin === allowed) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Vary', 'Origin');
};

export default function handler(request, response) {
  applyCors(request, response);
  if (request.method === 'OPTIONS') { response.status(204).end(); return; }
  if (request.method !== 'GET') { response.status(405).json({ error: 'Method not allowed' }); return; }
  response.status(200).json({ providers: [
    { id: 'kimi', name: 'Kimi K3', model: process.env.KIMI_MODEL || 'kimi-k3', configured: Boolean(process.env.KIMI_API_KEY) },
    { id: 'openai', name: 'OpenAI GPT-5.6', model: process.env.OPENAI_MODEL || 'gpt-5.6', configured: Boolean(process.env.OPENAI_API_KEY) },
    { id: 'cpass', name: 'CPASS 平台 GPT-5.6 Terra', model: process.env.CPASS_MODEL || 'gpt-5.6-terra', configured: Boolean(process.env.CPASS_API_KEY) },
  ] });
}
