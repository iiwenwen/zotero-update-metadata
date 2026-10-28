"""公开树与历史的边界检查，不访问网络或真实工作区Git。"""
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest

CHECK = Path(__file__).resolve().parents[1] / 'scripts/check-publication.py'
MANIFEST = Path(__file__).resolve().parents[1] / 'scripts/check-manifests.py'


class PublicationBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.name', 'Public Tester')
        self.git('config', 'user.email', '1+tester@users.noreply.github.com')

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, stderr=subprocess.DEVNULL).decode().strip()

    def commit(self, path, content):
        p = self.root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        self.git('add', '--', path)
        self.git('commit', '-qm', 'test fixture')

    def scan(self, *args):
        return subprocess.run([sys.executable, str(CHECK), *args], cwd=self.root, capture_output=True, text=True)

    def test_clean_ref_does_not_include_other_local_history(self):
        self.commit('README.md', 'public')
        public = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-qb', 'local-history')
        self.commit('state/board.md', 'private')
        self.git('checkout', '-q', 'main')
        self.assertEqual(self.git('rev-parse', 'main'), public)
        self.assertEqual(self.scan('main').returncode, 0)
        self.assertEqual(self.scan('local-history').returncode, 1)

    def test_deleted_private_file_still_detected_in_history(self):
        self.commit('state/board.md', 'private')
        self.git('rm', '-q', 'state/board.md')
        self.git('commit', '-qm', 'remove private file')
        self.assertEqual(self.scan('--index').returncode, 0)
        result = self.scan('main')
        self.assertEqual(result.returncode, 1)
        self.assertIn('historical-private-workspace-path', result.stdout)

    def test_personal_paths_and_tokens_are_reported_without_values(self):
        secret = 'ghp_' + 'a' * 36
        personal = '/home/' + 'private-person/project'
        self.commit('README.md', personal + '\n' + secret)
        result = self.scan('main')
        self.assertEqual(result.returncode, 1)
        self.assertIn('personal-home-path', result.stdout)
        self.assertIn('provider-token', result.stdout)
        self.assertNotIn(secret, result.stdout)
        self.assertNotIn(personal, result.stdout)

    def test_renamed_identical_blob_does_not_hide_private_old_path(self):
        self.commit('state/board.md', 'same contents')
        self.git('mv', 'state/board.md', 'README.md')
        self.git('commit', '-qm', 'rename')
        result = self.scan('main')
        self.assertEqual(result.returncode, 1)
        self.assertIn('historical-private-workspace-path', result.stdout)

    def test_non_private_commit_email_is_rejected_without_echo(self):
        email = 'private-address@example.invalid'
        self.git('config', 'user.email', email)
        self.commit('README.md', 'public')
        result = self.scan('main')
        self.assertEqual(result.returncode, 1)
        self.assertIn('non-GitHub-private-email', result.stdout)
        self.assertNotIn(email, result.stdout)

    def test_unreadable_ref_fails_closed(self):
        self.assertEqual(self.scan('missing').returncode, 2)

    def test_version_check_needs_no_personal_ai_manifest(self):
        import json
        for path, data in {
            'package.json': {'version': '0.4.0'},
            'addon/manifest.json': {'version': '0.4.0'},
            'package-lock.json': {'version': '0.4.0', 'packages': {'': {'version': '0.4.0'}}},
        }.items():
            p = self.root / path
            p.parent.mkdir(exist_ok=True)
            p.write_text(json.dumps(data))
        run = lambda: subprocess.run([sys.executable, str(MANIFEST), str(self.root)], capture_output=True)
        self.assertEqual(run().returncode, 0)
        (self.root / 'plugin.json').write_text(json.dumps({'name': 'test', 'version': '0.3.0'}))
        self.assertEqual(run().returncode, 1)
        (self.root / 'plugin.json').unlink()
        (self.root / 'addon/manifest.json').write_text(json.dumps({'version': '0.3.0'}))
        self.assertEqual(run().returncode, 1)


if __name__ == '__main__':
    unittest.main()
