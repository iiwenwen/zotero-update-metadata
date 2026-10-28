#!/usr/bin/env python3
"""一键调度GitHub发版；CI以同一脚本验包并发布，不覆盖已发布版本。"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
REPO = 'iiwenwen/zotero-update-metadata'
API_VERSION = 'X-GitHub-Api-Version: 2026-03-10'
spec = importlib.util.spec_from_file_location('release_candidate', ROOT / 'scripts/prepare-release.py')
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def gh(*args):
    subprocess.run(['gh', *args], cwd=ROOT, check=True)


def api(endpoint, method='GET', body=None, optional=False):
    args = ['gh', 'api', endpoint, '--method', method, '-H', API_VERSION]
    if body is not None:
        args += ['--input', '-']
    p = subprocess.run(args, input=json.dumps(body) if body is not None else None,
                       cwd=ROOT, text=True, capture_output=True)
    if p.returncode:
        if optional and 'HTTP 404' in p.stderr:
            return None
        raise RuntimeError(f'GitHub API失败：{method} {endpoint}；{p.stderr.strip()}')
    return json.loads(p.stdout) if p.stdout.strip() else None


def dispatch(draft=False, wait=True):
    if git('status', '--porcelain') or git('branch', '--show-current') != 'main':
        raise ValueError('请先在main提交并推送本次代码、版本和CHANGELOG')
    commit = git('rev-parse', 'HEAD')
    remote = api(f'repos/{REPO}/branches/main')
    if remote['commit']['sha'] != commit:
        raise ValueError('本地与GitHub main不一致，请先完成普通推送')
    # 新API直接返回本次run id；不搜索“最近运行”，也不重复POST调度。
    run = api(f'repos/{REPO}/actions/workflows/release.yml/dispatches', 'POST',
              {'ref': 'main', 'inputs': {'publish': not draft}})
    run_id = (run or {}).get('workflow_run_id') or (run or {}).get('id')
    if not isinstance(run_id, int):
        raise ValueError('已发送调度，但未取得run id；请查看Actions，不要盲目重发')
    print((run or {}).get('html_url', f'https://github.com/{REPO}/actions/runs/{run_id}'), flush=True)
    # main可能在调度前推进，发现时取消该次运行，避免发出非本次本地提交。
    observed = api(f'repos/{REPO}/actions/runs/{run_id}')
    if observed['head_sha'] != commit:
        api(f'repos/{REPO}/actions/runs/{run_id}/cancel', 'POST')
        raise ValueError('调度时main已变化，已请求取消；核对后重试')
    if wait:
        gh('run', 'watch', str(run_id), '--repo', REPO, '--exit-status', '--compact', '--interval', '10')
        version = json.loads((ROOT / 'package.json').read_text())['version']
        print(f'https://github.com/{REPO}/releases/tag/v{version}')
    return run_id


def validate_binding(info, commit, tree, version, addon_id, license_present, publish):
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', version):
        raise ValueError('发布版本格式不合法')
    if info['sourceCommit'] != commit or info['sourceTree'] != tree or info['version'] != version or info['addonID'] != addon_id:
        raise ValueError('候选与本次工作流的源码／版本／ID不一致')
    beta = '-' in version
    if info['prereleaseVersion'] != beta or info['developmentID'] != addon_id.endswith('@local') or info['licenseFilePresent'] != license_present:
        raise ValueError('候选渠道或身份标记不一致')
    if publish and not beta and (not license_present or addon_id.endswith('@local')):
        raise ValueError('正式公开版须先确定项目许可和正式插件ID；开发身份可发明确的预发布版')
    return beta


def ensure_tag(tag, commit):
    endpoint = f'repos/{REPO}/git/ref/tags/{quote(tag, safe="")}'
    ref = api(endpoint, optional=True)
    if ref is None:
        api(f'repos/{REPO}/git/refs', 'POST', {'ref': f'refs/tags/{tag}', 'sha': commit})
        ref = api(endpoint)
    obj = ref['object']
    for _ in range(5):
        if obj['type'] != 'tag':
            break
        obj = api(f'repos/{REPO}/git/tags/{obj["sha"]}')['object']
    if obj['type'] != 'commit' or obj['sha'] != commit:
        raise ValueError('同名标签指向其他提交，拒绝移动或覆盖')


def find_release(tag):
    rows = api(f'repos/{REPO}/releases?per_page=100')
    matches = [x for x in rows if x['tag_name'] == tag]
    if len(matches) > 1:
        raise ValueError('同名Release不唯一，请先核对')
    return matches[0] if matches else None


def download_and_verify(tag, expected):
    with tempfile.TemporaryDirectory() as directory:
        gh('release', 'download', tag, '--repo', REPO, '--dir', directory, '--pattern', '*')
        actual = candidate.verify(Path(directory))
        if actual != expected:
            raise ValueError('GitHub下载资产与本次候选不一致')


def publish_artifacts(directory):
    if any(os.environ.get(key) != value for key, value in {
        'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
        'GITHUB_REF': 'refs/heads/main', 'GITHUB_REPOSITORY': REPO,
    }.items()):
        raise ValueError('发布阶段只允许本仓库main的手动工作流')
    publish_value = os.environ.get('RELEASE_PUBLISH')
    if publish_value not in {'true', 'false'}:
        raise ValueError('缺少明确的公开／草稿选择')
    publish = publish_value == 'true'
    directory = Path(directory).resolve()
    info = candidate.verify(directory)
    commit = git('rev-parse', 'HEAD')
    if os.environ.get('GITHUB_SHA') != commit:
        raise ValueError('checkout不是本次工作流的精确提交')
    package = json.loads((ROOT / 'package.json').read_text())
    addon = json.loads((ROOT / 'addon/manifest.json').read_text())['applications']['zotero']
    beta = validate_binding(info, commit, git('rev-parse', 'HEAD^{tree}'), package['version'], addon['id'], (ROOT / 'LICENSE').is_file(), publish)
    tag = info['tag']
    release = find_release(tag)
    if release and not release['draft']:
        raise ValueError('该版本已经公开；请升级版本，不能替换已发布资产')
    ensure_tag(tag, commit)
    if release is None:
        release = api(f'repos/{REPO}/releases', 'POST', {
            'tag_name': tag, 'target_commitish': commit,
            'name': f'Zotero 元数据更新 {info["version"]}',
            'body': (directory / candidate.NOTES).read_text(),
            'draft': True, 'prerelease': beta, 'make_latest': 'false',
        })
    files = {p.name: p for p in directory.iterdir()}
    remote = {a['name']: a for a in release['assets']}
    if not set(remote).issubset(files):
        raise ValueError('现有草稿含额外资产，拒绝自动删除')
    # 只补缺失资产；相同字节可重跑，不使用clobber改写已有资产。
    for name, asset in remote.items():
        expected = 'sha256:' + hashlib.sha256(files[name].read_bytes()).hexdigest()
        if asset.get('digest') != expected:
            raise ValueError('现有草稿资产不同或无可信摘要；请复用首次构建产物，不覆盖')
    missing = [str(path) for name, path in files.items() if name not in remote]
    if missing:
        gh('release', 'upload', tag, *missing, '--repo', REPO)
    download_and_verify(tag, info)
    ensure_tag(tag, commit)
    if publish:
        release = api(f'repos/{REPO}/releases/{release["id"]}', 'PATCH', {
            'draft': False, 'prerelease': beta, 'make_latest': 'false',
        })
    print(release['html_url'], flush=True)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a') as stream:
            stream.write(f'### {info["tag"]}\n\n[查看{"Release" if publish else "草稿"}]({release["html_url"]})\n\n已下载并核对XPI、摘要、源码提交及渠道。未修改Latest或自动更新入口。\n')
    return release


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--draft', action='store_true', help='只生成草稿')
    parser.add_argument('--no-wait', action='store_true', help='调度后返回Actions链接')
    parser.add_argument('--publish-directory', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if args.publish_directory:
            publish_artifacts(args.publish_directory)
        else:
            dispatch(draft=args.draft, wait=not args.no_wait)
        return 0
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'发版失败：{error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
