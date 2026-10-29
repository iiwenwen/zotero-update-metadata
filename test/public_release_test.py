"""公开发布验证使用真实ZIP与清单夹具，网络替换为URL映射。"""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('public_release', Path(__file__).resolve().parents[1] / 'scripts/check-release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class PublicRelease(unittest.TestCase):
    def fixture(self, homepage=True):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dist = root / 'dist'
            dist.mkdir()
            addon = {'id': 'plugin@example.org', 'strict_min_version': '10.0', 'strict_max_version': '10.0.*',
                     'update_url': r.REPOSITORY + '/releases/latest/download/update.json'}
            manifest = {'version': '0.4.2', 'applications': {'zotero': addon}}
            if homepage:
                manifest['homepage_url'] = r.REPOSITORY
            xpi = dist / 'plugin.xpi'
            with zipfile.ZipFile(xpi, 'w') as archive:
                archive.writestr('manifest.json', json.dumps(manifest))
            feed = {'addons': {addon['id']: {'updates': [{'version': '0.4.2',
                    'update_link': r.REPOSITORY + '/releases/download/v0.4.2/plugin.xpi',
                    'update_hash': 'sha512:' + hashlib.sha512(xpi.read_bytes()).hexdigest(),
                    'applications': {'zotero': {k: addon[k] for k in ['strict_min_version', 'strict_max_version']}}}]}}}
            for name in ['update.json', 'update-beta.json']:
                (dist / name).write_text(json.dumps(feed))
            candidate = {'xpi': str(xpi), 'version': '0.4.2', 'id': addon['id'], 'sha256': hashlib.sha256(xpi.read_bytes()).hexdigest()}
            out = root / 'candidate'
            r.candidate.freeze(out, candidate, 'a' * 40, 'b' * 40, '## 0.4.2\n\n- Public change.\n', False)
            assets = [{'name': p.name, 'browser_download_url': r.REPOSITORY + '/releases/download/v0.4.2/' + p.name} for p in out.iterdir()]
            self.release = {'id': 1, 'tag_name': 'v0.4.2', 'name': 'v0.4.2', 'draft': False, 'prerelease': False, 'assets': assets, 'html_url': r.REPOSITORY + '/releases/tag/v0.4.2'}
            self.urls = {a['browser_download_url']: (out / a['name']).read_bytes() for a in assets}
            self.urls[r.API + '/releases/latest'] = json.dumps({'id': 1, 'tag_name': 'v0.4.2'}).encode()
            self.urls[r.REPOSITORY + '/releases/latest/download/update.json'] = (out / 'update.json').read_bytes()

    def read(self, url):
        if url == r.API + '/releases/tags/v0.4.2':
            return json.dumps(self.release).encode()
        return self.urls[url]

    def test_complete_public_release_passes(self):
        self.fixture()
        info = r.check('v0.4.2', self.read)
        self.assertEqual(info['homepage'], r.REPOSITORY)
        self.assertTrue(info['latestChecked'])

    def test_missing_homepage_cannot_pass(self):
        self.fixture(homepage=False)
        with self.assertRaisesRegex(ValueError, '主页'):
            r.check('v0.4.2', self.read)

    def test_wrong_latest_and_live_update_feed_cannot_pass(self):
        self.fixture()
        self.urls[r.API + '/releases/latest'] = json.dumps({'id': 2, 'tag_name': 'v0.4.1'}).encode()
        with self.assertRaisesRegex(ValueError, 'Latest'):
            r.check('v0.4.2', self.read)
        self.fixture()
        self.urls[r.REPOSITORY + '/releases/latest/download/update.json'] = b'wrong feed'
        with self.assertRaisesRegex(ValueError, '实际正式更新入口'):
            r.check('v0.4.2', self.read)

    def test_wrong_title_foreign_asset_and_modified_package_cannot_pass(self):
        self.fixture()
        self.release['name'] = 'wrong title'
        with self.assertRaisesRegex(ValueError, '标题'):
            r.check('v0.4.2', self.read)
        self.fixture()
        self.release['assets'][0]['browser_download_url'] = 'https://example.invalid/asset'
        with self.assertRaisesRegex(ValueError, '资产URL'):
            r.check('v0.4.2', self.read)
        self.fixture()
        self.urls[r.REPOSITORY + '/releases/download/v0.4.2/plugin.xpi'] += b'modified'
        with self.assertRaises(ValueError):
            r.check('v0.4.2', self.read)


if __name__ == '__main__':
    unittest.main()
