import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertEmptyHostTestDirectories } from '../scripts/guard-host-test-data.mjs';

test('全新及空宿主目录可测试，已有内容即使没有标记也拒绝清库', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zmta-data-guard-'));
  try {
    await assertEmptyHostTestDirectories(root);
    for (const name of ['profile', 'data']) {
      await mkdir(path.join(root, '.scaffold/test', name), { recursive: true });
    }
    await assertEmptyHostTestDirectories(root);
    for (const [directory, filename] of [
      ['data', 'zotero.sqlite'], ['data', 'zmta-manual-fixtures.json'],
      ['profile', 'prefs.js'],
    ]) {
      const file = path.join(root, '.scaffold/test', directory, filename);
      await writeFile(file, '必须保留');
      await assert.rejects(assertEmptyHostTestDirectories(root), /已有内容/);
      assert.equal(await readFile(file, 'utf8'), '必须保留');
      await rm(file);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('数据路径异常时拒绝继续，不能误当成空目录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zmta-data-guard-'));
  try {
    await mkdir(path.join(root, '.scaffold/test'), { recursive: true });
    await writeFile(path.join(root, '.scaffold/test/data'), '非目录');
    await assert.rejects(assertEmptyHostTestDirectories(root), { code: 'ENOTDIR' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
