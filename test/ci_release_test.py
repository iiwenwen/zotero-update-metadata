"""发版编排边界：所有GitHub／gh调用均替换为内存记录，不联网。"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ci_release', Path(__file__).resolve().parents[1] / 'scripts/release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
COMMIT, TREE = 'a' * 40, 'b' * 40


class CIRelease(unittest.TestCase):
    def setUp(self):
        quiet = patch("builtins.print")
        quiet.start()
        self.addCleanup(quiet.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'addon').mkdir()
        (self.root / 'package.json').write_text(json.dumps({'version': '0.4.1-beta.1'}))
        (self.root / 'addon/manifest.json').write_text(json.dumps({'applications': {'zotero': {'id': 'test@local'}}}))
        self.directory = self.root / 'candidate'
        self.directory.mkdir()
        (self.directory / 'plugin.xpi').write_bytes(b'orchestration fixture; verification mocked')
        (self.directory / r.candidate.NOTES).write_text('Public release notes')
        self.info = {'sourceCommit': COMMIT, 'sourceTree': TREE, 'version': '0.4.1-beta.1', 'tag': 'v0.4.1-beta.1', 'addonID': 'test@local', 'prereleaseVersion': True, 'developmentID': True, 'licenseFilePresent': False}
        self.env = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main', 'GITHUB_REPOSITORY': r.REPO, 'GITHUB_SHA': COMMIT, 'RELEASE_PUBLISH': 'true', 'GITHUB_STEP_SUMMARY': ''}
        self.events = []
        self.download_error = None
        self.existing = None
        self.remote = {'id': 1, 'tag_name': self.info['tag'], 'assets': [], 'draft': True, 'prerelease': True, 'html_url': 'https://github.com/example/release'}

    def tearDown(self):
        self.temp.cleanup()

    def api(self, endpoint, method='GET', body=None, optional=False):
        self.events.append((method, endpoint, body))
        if '/branches/main' in endpoint:return {'commit': {'sha': COMMIT}}
        if endpoint.endswith('/dispatches'):return {'workflow_run_id': 123}
        if endpoint.endswith('/actions/runs/123'):return {'head_sha': COMMIT}
        if '/git/ref/tags/' in endpoint:return {'object': {'type': 'commit', 'sha': COMMIT}}
        if endpoint.endswith('/releases?per_page=100'):return [self.existing] if self.existing else []
        if method in {'POST', 'PATCH'} and '/releases' in endpoint:return dict(self.remote, draft=method != 'PATCH')
        return None

    def publish(self):
        def download(*_):
            self.events.append(('download', None, None))
            if self.download_error:
                raise self.download_error
        with patch.object(r, 'ROOT', self.root), patch.dict(os.environ, self.env), patch.object(r.candidate, 'verify', return_value=self.info), patch.object(r, 'git', side_effect=lambda *args: TREE if 'HEAD^{tree}' in args else COMMIT), patch.object(r, 'api', side_effect=self.api), patch.object(r, 'gh', side_effect=lambda *args: self.events.append(('gh', args, None))), patch.object(r, 'download_and_verify', side_effect=download):
            return r.publish_artifacts(self.directory)

    def test_public_release_replay_rejects_different_bytes_without_mutation(self):
        self.existing = dict(self.remote, draft=False)
        self.download_error = ValueError('GitHub下载资产与本次候选不一致')
        with self.assertRaisesRegex(ValueError, '不一致'):
            self.publish()
        self.assertFalse(any(e[0] in {'POST', 'PATCH', 'gh'} for e in self.events))

    def test_beta_can_publish_but_stable_with_development_id_cannot(self):
        self.assertTrue(r.validate_binding(self.info, COMMIT, TREE, '0.4.1-beta.1', 'test@local', False, True))
        stable = dict(self.info, version='0.4.1', prereleaseVersion=False)
        with self.assertRaisesRegex(ValueError, '正式'):
            r.validate_binding(stable, COMMIT, TREE, '0.4.1', 'test@local', False, True)
        bad = dict(self.info, sourceCommit='c' * 40)
        with self.assertRaisesRegex(ValueError, '不一致'):
            r.validate_binding(bad, COMMIT, TREE, '0.4.1-beta.1', 'test@local', False, True)

    def test_stable_can_keep_license_undecided_without_claiming_one(self):
        stable = dict(self.info, version='0.4.1', prereleaseVersion=False,
                      addonID='test@example.org', developmentID=False)
        self.assertFalse(r.validate_binding(stable, COMMIT, TREE, '0.4.1', 'test@example.org', False, True))
        self.assertFalse(stable['licenseFilePresent'])

    def test_download_check_precedes_publish_and_latest_stays_false(self):
        result = self.publish()
        self.assertFalse(result['draft'])
        created = next(e for e in self.events if e[0] == 'POST' and e[1].endswith('/releases'))
        self.assertEqual(created[2]['name'], self.info['tag'])
        download = next(i for i, e in enumerate(self.events) if e[0] == 'download')
        published = next(i for i, e in enumerate(self.events) if e[0] == 'PATCH')
        self.assertLess(download, published)
        self.assertEqual(self.events[published][2], {'draft': False, 'prerelease': True, 'make_latest': 'false'})
        self.assertFalse(any('/git/refs' in str(e[1]) and e[0] == 'PATCH' for e in self.events))

    def test_download_failure_cannot_publish(self):
        with patch.object(r, 'ROOT', self.root), patch.dict(os.environ, self.env), patch.object(r.candidate, 'verify', return_value=self.info), patch.object(r, 'git', side_effect=lambda *args: TREE if 'HEAD^{tree}' in args else COMMIT), patch.object(r, 'api', side_effect=self.api), patch.object(r, 'gh'), patch.object(r, 'download_and_verify', side_effect=ValueError('bad downloaded hash')):
            with self.assertRaises(ValueError):r.publish_artifacts(self.directory)
        self.assertFalse(any(e[0] == 'PATCH' for e in self.events))

    def test_verified_stable_becomes_latest_but_draft_does_not(self):
        (self.root / 'LICENSE').write_text('fixture license')
        (self.root / 'package.json').write_text(json.dumps({'version': '2.0.0'}))
        (self.root / 'addon/manifest.json').write_text(json.dumps({'applications': {'zotero': {'id': 'test@example.org'}}}))
        self.info.update(version='2.0.0', tag='v2.0.0', addonID='test@example.org', prereleaseVersion=False, developmentID=False, licenseFilePresent=True)
        self.publish()
        published = next(i for i, e in enumerate(self.events) if e[0] == 'PATCH')
        self.assertLess(next(i for i, e in enumerate(self.events) if e[0] == 'download'), published)
        self.assertEqual(self.events[published][2], {'draft': False, 'prerelease': False, 'make_latest': 'true'})
        self.events.clear()
        self.env['RELEASE_PUBLISH'] = 'false'
        self.publish()
        self.assertFalse(any(e[0] == 'PATCH' for e in self.events))

    def test_draft_mode_does_not_publish_and_existing_public_release_is_immutable(self):
        self.env['RELEASE_PUBLISH'] = 'false'
        self.assertTrue(self.publish()['draft'])
        self.assertFalse(any(e[0] == 'PATCH' for e in self.events))
        self.events.clear();self.existing = dict(self.remote, draft=False)
        self.assertFalse(self.publish()['draft'])
        self.assertTrue(any(e[0] == 'download' for e in self.events))
        self.assertFalse(any(e[0] in {'POST', 'PATCH', 'gh'} for e in self.events))

    def test_wrong_workflow_or_commit_is_rejected(self):
        self.env['GITHUB_EVENT_NAME'] = 'pull_request'
        with self.assertRaisesRegex(ValueError, '手动'):self.publish()
        self.assertFalse(self.events)

    def test_conflicting_tag_never_moves(self):
        with patch.object(r, 'api', return_value={'object': {'type': 'commit', 'sha': 'c' * 40}}) as api:
            with self.assertRaisesRegex(ValueError, '拒绝'):r.ensure_tag('v0.4.1-beta.1', COMMIT)
        self.assertEqual(api.call_count, 1)

    def test_dispatch_uses_exact_returned_run_and_rejects_unpushed_code(self):
        def local_git(*args):
            if args[0] == 'status':return ''
            if args[0] == 'branch':return 'main'
            return COMMIT
        with patch.object(r, 'ROOT', self.root), patch.object(r, 'git', side_effect=local_git), patch.object(r, 'api', side_effect=self.api), patch.object(r, 'gh') as gh:
            self.assertEqual(r.dispatch(), 123)
            gh.assert_called_once()
            self.assertIn('123', gh.call_args.args)
        self.events.clear()
        with patch.object(r, 'git', side_effect=local_git), patch.object(r, 'api', return_value={'commit': {'sha': 'c' * 40}}) as api:
            with self.assertRaisesRegex(ValueError, '不一致'):r.dispatch()
            self.assertEqual(api.call_count, 1)

    def test_optional_api_only_accepts_404(self):
        with patch.object(r.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stdout='', stderr='HTTP 404')):
            self.assertIsNone(r.api('test', optional=True))
        with patch.object(r.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stdout='', stderr='HTTP 401')):
            with self.assertRaises(RuntimeError):r.api('test', optional=True)


if __name__ == '__main__':unittest.main()
