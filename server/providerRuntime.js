import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BEAUTY_V5_SYSTEM_PROMPT } from './beautySkillPrompt.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const parseEnv = text => Object.fromEntries(text.split(/\r?\n/).flatMap(line => {
  const value = line.trim();
  if (!value || value.startsWith('#')) return [];
  const index = value.indexOf('=');
  return index < 0 ? [] : [[value.slice(0, index), value.slice(index + 1).trim()]];
}));
const load = async name => parseEnv(await readFile(`${root}config/providers/.env.${name}.local`, 'utf8'));

export const getProviders = async () => {
  const [cpass, kimi, openai] = await Promise.all(['cpass', 'kimi', 'openai'].map(load));
  return {
    cpass: { id: 'cpass', key: cpass.CPASS_API_KEY, base: cpass.CPASS_BASE_URL, path: cpass.CPASS_CHAT_PATH, model: cpass.CPASS_MODEL, name: cpass.CPASS_DISPLAY_NAME, api: 'chat' },
    kimi: { id: 'kimi', key: kimi.KIMI_API_KEY, base: kimi.KIMI_BASE_URL, path: kimi.KIMI_CHAT_PATH, model: kimi.KIMI_MODEL, name: kimi.KIMI_DISPLAY_NAME, api: 'chat', reasoning: kimi.KIMI_REASONING_EFFORT },
    openai: { id: 'openai', key: openai.OPENAI_API_KEY, base: openai.OPENAI_BASE_URL, path: openai.OPENAI_RESPONSES_PATH, model: openai.OPENAI_MODEL, name: openai.OPENAI_DISPLAY_NAME, api: 'responses', reasoning: openai.OPENAI_REASONING_EFFORT },
  };
};

const configured = provider => Boolean(provider.key && !provider.key.includes('请在这里'));
export const publicProviders = async () => Object.values(await getProviders()).map(({ key, base, path, ...provider }) => ({ ...provider, configured: configured({ key }) }));

export const getOpenAIImageProvider = async () => {
  const env = await load('openai');
  return { key: env.OPENAI_API_KEY, base: env.OPENAI_BASE_URL || 'https://api.openai.com/v1', model: 'gpt-image-2.5-sunburst' };
};

const imagePart = dataUrl => ({ type: 'image_url', image_url: { url: dataUrl } });
const userInstruction = ({ mode, notes }) => `输出模式：${mode === 'batch' ? 'batch（Lovart整套批量）' : 'pages（逐屏独立）'}。\n产品备注：${JSON.stringify(notes.productNotes || [])}\n运营补充：${notes.operationsNote || '无'}\n风格补充：${notes.styleNote || '无'}\n请先逐张确认图片可读，再严格执行V5编译。`;

export const compileWithProvider = async ({ providerId, mode, images, notes }) => {
  const providers = await getProviders();
  const provider = providers[providerId];
  if (!provider || !configured(provider)) throw new Error('模型尚未正确配置');
  if (!Array.isArray(images) || images.length < 3 || images.some(image => !String(image).startsWith('data:image/'))) throw new Error('图片读取失败或素材数量不足，请重新上传');
  const instruction = userInstruction({ mode, notes });
  const body = provider.api === 'responses'
    ? { model: provider.model, instructions: BEAUTY_V5_SYSTEM_PROMPT, input: [{ role: 'user', content: [{ type: 'input_text', text: instruction }, ...images.map(image_url => ({ type: 'input_image', image_url }))] }], reasoning: { effort: provider.reasoning || 'high' } }
    : { model: provider.model, messages: [{ role: 'system', content: BEAUTY_V5_SYSTEM_PROMPT }, { role: 'user', content: [{ type: 'text', text: instruction }, ...images.map(imagePart)] }], ...(provider.reasoning ? { reasoning_effort: provider.reasoning } : {}) };
  const response = await fetch(`${provider.base}${provider.path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `模型请求失败（${response.status}）`);
  const text = provider.api === 'responses'
    ? data.output_text || data.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text
    : data.choices?.[0]?.message?.content;
  if (!text) throw new Error('模型未返回可用提示词');
  return { text, provider: provider.name, model: provider.model };
};
