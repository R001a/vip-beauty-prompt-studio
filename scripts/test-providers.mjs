import { readFile } from 'node:fs/promises';

const parseEnv = text => Object.fromEntries(text.split(/\r?\n/).flatMap(line => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return [];
  const separator = trimmed.indexOf('=');
  return separator < 0 ? [] : [[trimmed.slice(0, separator), trimmed.slice(separator + 1).trim()]];
}));

const load = async name => parseEnv(await readFile(new URL(`../config/providers/.env.${name}.local`, import.meta.url), 'utf8'));
const request = async ({ name, url, key, body }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    const detail = payload?.error?.message || payload?.message || '';
    console.log(`${name}: ${response.ok ? 'connected' : `failed (${response.status})`}${detail ? ` - ${detail.slice(0, 180)}` : ''}`);
    return response.ok;
  } catch (error) {
    console.log(`${name}: failed - ${error.name === 'AbortError' ? 'request timed out' : error.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const cpass = await load('cpass');
const kimi = await load('kimi');
const openai = await load('openai');
const only = process.argv[2]?.toLowerCase();

const checks = [
  () => request({
    name: 'CPASS',
    url: `${cpass.CPASS_BASE_URL}${cpass.CPASS_CHAT_PATH}`,
    key: cpass.CPASS_API_KEY,
    body: { model: cpass.CPASS_MODEL, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 8 },
  }),
  () => request({
    name: 'Kimi',
    url: `${kimi.KIMI_BASE_URL}${kimi.KIMI_CHAT_PATH}`,
    key: kimi.KIMI_API_KEY,
    body: { model: kimi.KIMI_MODEL, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 8, reasoning_effort: 'low' },
  }),
  () => request({
    name: 'OpenAI',
    url: `${openai.OPENAI_BASE_URL}${openai.OPENAI_RESPONSES_PATH}`,
    key: openai.OPENAI_API_KEY,
    body: { model: openai.OPENAI_MODEL, input: 'Reply OK.', max_output_tokens: 16, reasoning: { effort: 'none' } },
  }),
];
const names = ['cpass', 'kimi', 'openai'];
const selectedChecks = only ? checks.filter((_, index) => names[index] === only) : checks;
if (!selectedChecks.length) throw new Error(`Unknown provider: ${only}`);
const results = await Promise.all(selectedChecks.map(check => check()));

process.exitCode = results.every(Boolean) ? 0 : 1;
