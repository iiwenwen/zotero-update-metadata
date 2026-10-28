"""Release固定字节、渠道和失败关闭回归；不联网、不启动宿主或创建真实Release。"""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('release_process', Path(__file__).resolve().parents[1] / 'scripts/prepare-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseProcess(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.dist = self.root / 'dist'
        self.dist.mkdir()
        self.out = self.root / 'candidate'

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self, version='0.4.0', repository=release.REPOSITORY):
        package = self.dist / 'plugin.xpi'
        addon = {'id': 'example@local', 'strict_min_version': '10.0', 'strict_max_version': '10.0.*'}
        with zipfile.ZipFile(package, 'w') as archive:
            archive.writestr('manifest.json', json.dumps({'version': version, 'applications': {'zotero': addon}}))
        data = package.read_bytes()
        feed = {'addons': {addon['id']: {'updates': [{
            'version': version, 'update_link': f'{repository}/releases/download/v{version}/{package.name}',
            'update_hash': 'sha512:' + hashlib.sha512(data).hexdigest(),
            'applications': {'zotero': {k: addon[k] for k in ['strict_min_version', 'strict_max_version']}},
        }]}}}
        for name in ['update.json', 'update-beta.json']:
            (self.dist / name).write_text(json.dumps(feed))
        return {'xpi': str(package), 'version': version, 'id': addon['id'], 'sha256': hashlib.sha256(data).hexdigest()}

    def freeze(self, candidate):
        return release.freeze(self.out, candidate, 'a' * 40, 'b' * 40, f'## {candidate["version"]}\n\n- A user-visible change.\n', False)

    def test_stable_freezes_same_bytes_and_two_feeds(self):
        candidate = self.fixture()
        info = self.freeze(candidate)
        self.assertEqual(release.verify(self.out), info)
        self.assertEqual((self.out / 'plugin.xpi').read_bytes(), Path(candidate['xpi']).read_bytes())
        self.assertEqual(info['sourceCommit'], 'a' * 40)
        self.assertIn('update.json', info['sha256'])
        self.assertIn('update-beta.json', info['sha256'])
        self.assertTrue(info['developmentID'])
        self.assertFalse(info['licenseFilePresent'])
        self.assertNotIn(str(self.root), (self.out / release.MANIFEST).read_text())

    def test_beta_does_not_copy_stale_stable_feed(self):
        candidate = self.fixture('0.4.1-beta.1')
        (self.dist / 'update.json').write_text('stale stable content')
        info = self.freeze(candidate)
        self.assertNotIn('update.json', info['sha256'])
        self.assertFalse((self.out / 'update.json').exists())
        self.assertTrue(info['prereleaseVersion'])
        self.assertEqual(release.verify(self.out), info)

    def test_modified_candidate_file_is_rejected(self):
        self.freeze(self.fixture())
        with (self.out / 'plugin.xpi').open('ab') as output:
            output.write(b'modified')
        with self.assertRaisesRegex(ValueError, '变化'):
            release.verify(self.out)

    def test_checksum_file_and_extra_file_are_rejected(self):
        self.freeze(self.fixture())
        sums = (self.out / release.CHECKSUMS).read_text()
        (self.out / release.CHECKSUMS).write_text(('0' if sums[0] != '0' else '1') + sums[1:])
        with self.assertRaisesRegex(ValueError, 'SHA256SUMS'):
            release.verify(self.out)
        (self.out / release.CHECKSUMS).write_text(sums)
        (self.out / 'unreviewed.txt').write_text('extra')
        with self.assertRaisesRegex(ValueError, '额外'):
            release.verify(self.out)

    def test_symlink_and_path_escape_are_rejected(self):
        for name in ['../plugin.xpi', '/plugin.xpi', 'x\\plugin.xpi', 'line\nbreak.xpi']:
            with self.assertRaises(ValueError):
                release.checked_name(name)
        self.freeze(self.fixture())
        p = self.out / release.NOTES
        p.unlink()
        p.symlink_to(self.dist / 'update.json')
        with self.assertRaisesRegex(ValueError, '普通文件'):
            release.verify(self.out)

    def test_wrong_repository_feed_is_rejected(self):
        with self.assertRaisesRegex(ValueError, '仓库'):
            self.freeze(self.fixture(repository='https://github.com/another/repository'))

    def test_changes_before_freeze_and_existing_destination_are_rejected(self):
        candidate = self.fixture()
        Path(candidate['xpi']).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, '变化'):
            self.freeze(candidate)
        self.assertFalse(self.out.exists())
        candidate = self.fixture()
        self.freeze(candidate)
        with self.assertRaises(FileExistsError):
            self.freeze(candidate)

    def test_notes_require_exact_current_version(self):
        with self.assertRaises(ValueError):
            release.release_notes('## 0.4.0-beta.1\n\n- Beta only.', '0.4.0', 'a' * 40)
        notes = release.release_notes('## 0.4.0\n- First line.\n\n## 0.3.0\n- Old.', '0.4.0', 'a' * 40)
        self.assertIn('- First line.', notes)
        self.assertNotIn('- Old.', notes)

    def test_dirty_worktree_stops_before_any_checks_or_build(self):
        with patch.object(release, 'git', return_value=' M README.md'), patch.object(release, 'run') as run:
            with self.assertRaisesRegex(ValueError, '干净'):
                release.prepare()
            run.assert_not_called()

    def test_source_commit_change_stops_before_freezing(self):
        with patch.object(release, 'git', side_effect=['', 'a' * 40, 'b' * 40, 'c' * 40]), patch.object(release.shutil, 'which', return_value='npm'), patch.object(release, 'run'), patch.object(release, 'freeze') as freeze:
            with self.assertRaisesRegex(ValueError, '变化'):
                release.prepare()
            freeze.assert_not_called()

    def test_source_change_after_freeze_invalidates_created_directory(self):
        candidate = self.fixture()
        (self.root / 'CHANGELOG.md').write_text('## 0.4.0\n\n- A user-visible change.\n')
        checker = SimpleNamespace(check=lambda _: candidate)
        loader = SimpleNamespace(exec_module=lambda _: None)
        with patch.object(release, 'ROOT', self.root), patch.object(release, 'git', side_effect=['', 'a' * 40, 'b' * 40, 'a' * 40, '', 'c' * 40]), patch.object(release.shutil, 'which', return_value='npm'), patch.object(release, 'run'), patch.object(release.importlib.util, 'spec_from_file_location', return_value=SimpleNamespace(loader=loader)), patch.object(release.importlib.util, 'module_from_spec', return_value=checker):
            with self.assertRaisesRegex(ValueError, '变化'):
                release.prepare()
        candidates = list((self.root / '_build').iterdir())
        self.assertEqual(len(candidates), 1)
        self.assertTrue((candidates[0] / 'PREPARE-FAILED.txt').is_file())
        with self.assertRaisesRegex(ValueError, '额外'):
            release.verify(candidates[0])


if __name__ == '__main__':
    unittest.main()
