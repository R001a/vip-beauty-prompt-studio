const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const project = path.resolve(__dirname, '..');
const platform = process.argv[2];
if (!['win', 'mac'].includes(platform)) throw new Error('Expected build platform: win or mac');

// Some managed Windows filesystems allow copying extracted folders but deny the
// final atomic rename. Preserve electron-builder's behavior and add a safe copy fallback.
const helper = path.join(project, 'node_modules', 'app-builder-lib', 'out', 'util', 'electronGet.js');
const original = fs.readFileSync(helper, 'utf8');
const needle = '        await fs.rename(tmpDir, dir);';
if (original.includes(needle)) {
  const replacement = `        try {\n            await fs.rename(tmpDir, dir);\n        }\n        catch (error) {\n            if (error?.code !== "EPERM") throw error;\n            await fs.cp(tmpDir, dir, { recursive: true, force: true });\n            await fs.rm(tmpDir, { recursive: true, force: true });\n        }`;
  fs.writeFileSync(helper, original.replace(needle, replacement));
}

const cache = path.join(project, '.cache', 'electron-builder');
fs.mkdirSync(cache, { recursive: true });
const cli = path.join(project, 'node_modules', 'electron-builder', 'cli.js');
const args = platform === 'win' ? ['--win', 'nsis'] : ['--mac', 'dmg', 'zip', '--universal'];
args.push('--publish', 'never');
const localElectron = path.join(project, 'desktop', 'electron-dist-win');
if (platform === 'win' && fs.existsSync(path.join(localElectron, 'electron.exe'))) {
  args.push('--config.electronDist=desktop/electron-dist-win');
}
const result = spawnSync(process.execPath, [cli, ...args], {
  cwd: project,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_BUILDER_CACHE: cache },
});
process.exit(result.status ?? 1);
