// 复用持久手工测试库；与 scaffold 自动测试的清库启动分开。
import { spawn, execFileSync } from 'node:child_process';
import { access, mkdir, open, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = path.join(root, '.scaffold/test/profile');
const dataDir = path.join(root, '.scaffold/test/data');
// 手工入口和serve必须指向同一项目内保留库，配置漂移时拒绝另建。
try { process.loadEnvFile(path.join(root, '.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const [name, expected] of [
  ['ZOTERO_PLUGIN_PROFILE_PATH', profile], ['ZOTERO_PLUGIN_DATA_DIR', dataDir],
]) {
  if (process.env[name] && path.resolve(root, process.env[name]) !== expected) {
    throw new Error(`${name} 与项目内手工测试库不一致，请先统一 .env；未启动客户端。`);
  }
}
await access(path.join(dataDir, 'zmta-manual-fixtures.json'));
const manifest = JSON.parse(await readFile(path.join(root, 'addon/manifest.json'), 'utf8'));
await access(path.join(profile, 'extensions', manifest.applications.zotero.id + '.xpi')); 
const processes = execFileSync('ps', ['ax', '-o', 'pid=,command='], { encoding: 'utf8' });
const mains = processes.split('\n').filter(line => /\/Zotero\.app\/Contents\/MacOS\/zotero(?:\s|$)/.test(line));
const existing = mains.find(line => line.includes(profile) && line.includes(dataDir));
if (mains.length > 1 || (!existing && mains.length)) {
  throw new Error('已有其他 Zotero 客户端，请先核对；不会并开第二个测试客户端。');
}
if (existing) {
  console.log(`手工测试客户端已在运行（PID ${existing.trim().split(/\s+/)[0]}），复用现有窗口。`);
} else {
  const directory = path.join(root, '_tmp/manual-test');
  await mkdir(directory, { recursive: true });
  const log = await open(path.join(directory, 'host.log'), 'a');
  const child = spawn('/Applications/Zotero.app/Contents/MacOS/zotero', ['-no-remote', '-profile', profile, '--dataDir', dataDir, '--purgecaches'], {
    detached: true, stdio: ['ignore', log.fd, log.fd],
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  await log.close();
  await writeFile(path.join(directory, 'launch.json'), JSON.stringify({ pid: child.pid, profile, dataDir, startedAt: new Date().toISOString(), persistent: true }, null, 2));
  console.log(`已打开持久手工测试库（PID ${child.pid}）。分类：ZMTA 手工测试（保留）。`);
}
