const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const sourceRoot = process.argv[2] ? path.resolve(process.argv[2]) : root;
const output = path.join(__dirname, 'secure-config.enc');
const password = process.env.DESKTOP_CONFIG_PASSWORD || 'rock';
const candidates = [
  '.env.local',
  'config/providers/.env.openai.local',
  'config/providers/.env.kimi.local',
  'config/providers/.env.cpass.local',
];
const files = Object.fromEntries(candidates.flatMap(relative => {
  const file = path.join(sourceRoot, relative);
  return fs.existsSync(file) ? [[relative, fs.readFileSync(file, 'utf8')]] : [];
}));
if (!Object.keys(files).length) throw new Error('No local configuration files were found');
const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256');
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const data = Buffer.concat([cipher.update(JSON.stringify({ version: 1, files }), 'utf8'), cipher.final()]);
const payload = { version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
fs.writeFileSync(output, JSON.stringify(payload));
console.log(`Encrypted ${Object.keys(files).length} configuration files for desktop packaging.`);

