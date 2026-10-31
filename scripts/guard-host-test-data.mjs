// scaffold会清空profile和data；不依赖可遗失的手工标记判定数据价值。
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function assertEmptyHostTestDirectories(root) {
  for (const name of ['profile', 'data']) {
    const directory = path.join(root, '.scaffold/test', name);
    let entries;
    try { entries = await readdir(directory); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (entries.length) {
      throw new Error(`自动宿主测试会清空 ${directory}，发现已有内容，本次已阻止。请用 npm run test:manual 打开保留的手工测试库；离线回归使用 npm run test:core / npm run test:ui。`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await assertEmptyHostTestDirectories(fileURLToPath(new URL('../', import.meta.url))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
