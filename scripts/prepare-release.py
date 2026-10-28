#!/usr/bin/env python3
"""本地校验并固定Release候选；不改版本、不提交／打tag／推送或调用GitHub发布API。"""
import argparse
from datetime import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import unquote, urlsplit
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'https://github.com/iiwenwen/zotero-update-metadata'
MANIFEST = 'release-manifest.json'
CHECKSUMS = 'SHA256SUMS'
NOTES = 'RELEASE-NOTES.md'


def run(args, root=ROOT):
    subprocess.run(args, cwd=root, check=True)


def git(*args, root=ROOT):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def release_notes(changelog, version, commit):
    match = re.search(r'^## ' + re.escape(version) + r'(?=[ \t]|\r?$)[^\r\n]*\r?\n(.*?)(?=^## |\Z)', changelog, re.M | re.S)
    if not match or not match[1].strip():
        raise ValueError('CHANGELOG.md缺少当前版本的发布说明')
    return f'# Zotero 元数据更新 {version}\n\n{match[1].strip()}\n\n源码提交：[\u0060{commit[:12]}\u0060]({REPOSITORY}/commit/{commit})\n'


def checked_name(name):
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name) or name in {MANIFEST, CHECKSUMS}:
        raise ValueError('候选文件名不合法')
    return name


def feeds_for(version):
    return ['update-beta.json'] if '-' in version else ['update.json', 'update-beta.json']


def freeze(directory, candidate, commit, tree, changelog, license_present):
    """复制已校验字节，完成标志最后写入；从不覆盖已有候选目录。"""
    source = Path(candidate['xpi'])
    name = checked_name(source.name)
    data = source.read_bytes()
    if sha(data) != candidate['sha256']:
        raise ValueError('校验后XPI发生变化，拒绝固定候选')
    files = {name: data}
    for feed in feeds_for(candidate['version']):
        files[feed] = (source.parent / feed).read_bytes()
    files[NOTES] = release_notes(changelog, candidate['version'], commit).encode()
    info = {
        'formatVersion': 1,
        'version': candidate['version'],
        'tag': 'v' + candidate['version'],
        'sourceCommit': commit,
        'sourceTree': tree,
        'repository': REPOSITORY,
        'addonID': candidate['id'],
        'xpi': name,
        'prereleaseVersion': '-' in candidate['version'],
        'licenseFilePresent': license_present,
        'developmentID': candidate['id'].endswith('@local'),
        'scope': 'local candidate, not release approval or host acceptance',
        'sha256': {n: sha(b) for n, b in files.items()},
    }
    manifest = (json.dumps(info, ensure_ascii=False, indent=2) + '\n').encode()
    sums = ''.join(f'{sha(content)}  {filename}\n' for filename, content in {**files, MANIFEST: manifest}.items()).encode()
    directory.mkdir(parents=False, exist_ok=False)
    for filename, content in files.items():
        (directory / filename).write_bytes(content)
    (directory / CHECKSUMS).write_bytes(sums)
    (directory / MANIFEST).write_bytes(manifest)
    verify(directory)
    return info


def verify(directory):
    directory = Path(directory)
    for p in directory.iterdir():
        if p.is_symlink() or not p.is_file():
            raise ValueError('候选目录只允许普通文件')
    info = json.loads((directory / MANIFEST).read_text())
    if not isinstance(info, dict) or info.get('formatVersion') != 1 or not isinstance(info.get('version'), str) or info.get('tag') != 'v' + info['version']:
        raise ValueError('候选格式或版本标签不一致')
    commit = info.get('sourceCommit')
    if info.get('repository') != REPOSITORY or not isinstance(commit, str) or not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('候选仓库或源码提交不明确')
    hashes = info.get('sha256')
    if not isinstance(hashes, dict) or any(not isinstance(v, str) or not re.fullmatch(r'[0-9a-f]{64}', v) for v in hashes.values()):
        raise ValueError('候选摘要不合法')
    names = set(hashes)
    for name in names:
        checked_name(name)
    xpi = checked_name(info.get('xpi'))
    if names != {xpi, NOTES, *feeds_for(info['version'])}:
        raise ValueError('候选文件列表不完整或含额外内容')
    if {p.name for p in directory.iterdir()} != names | {MANIFEST, CHECKSUMS}:
        raise ValueError('候选目录有缺失或额外文件')
    actual = {}
    for name in names:
        data = (directory / name).read_bytes()
        actual[name] = sha(data)
        if actual[name] != info['sha256'][name]:
            raise ValueError(f'候选文件已变化：{name}')
    actual[MANIFEST] = sha((directory / MANIFEST).read_bytes())
    sums = {}
    for line in (directory / CHECKSUMS).read_text().splitlines():
        digest, name = line.split('  ', 1)
        if name in sums:
            raise ValueError('校验和文件含重复条目')
        sums[name] = digest
    if sums != actual:
        raise ValueError('SHA256SUMS与候选不一致')
    with zipfile.ZipFile(directory / xpi) as archive:
        if archive.testzip() is not None:
            raise ValueError('XPI损坏')
        manifest = json.loads(archive.read('manifest.json'))
        addon = manifest['applications']['zotero']
        if manifest['version'] != info['version'] or addon['id'] != info['addonID']:
            raise ValueError('XPI版本／ID与候选不一致')
    digest = 'sha512:' + hashlib.sha512((directory / xpi).read_bytes()).hexdigest()
    for feed in feeds_for(info['version']):
        payload = json.loads((directory / feed).read_text())
        updates = payload['addons'][info['addonID']]['updates']
        entry = next(x for x in updates if x['version'] == info['version'])
        if entry['update_hash'] != digest or not entry['update_link'].endswith('/' + xpi):
            raise ValueError('自动更新文件与固定XPI不一致')
        link = urlsplit(entry['update_link'])
        repo = urlsplit(REPOSITORY)
        if link.scheme != 'https' or link.netloc != repo.netloc or link.query or link.fragment or unquote(link.path) != repo.path + '/releases/download/' + info['tag'] + '/' + xpi:
            raise ValueError('自动更新文件指向错误的仓库／标签')
        if entry['applications']['zotero'] != {k: addon[k] for k in ['strict_min_version', 'strict_max_version']}:
            raise ValueError('自动更新文件兼容范围与XPI不一致')
    return info


def check_source():
    if git('status', '--porcelain'):
        raise ValueError('先提交待发布的代码和版本说明；工作区必须干净')
    commit = git('rev-parse', 'HEAD')
    tree = git('rev-parse', 'HEAD^{tree}')
    npm = shutil.which('npm')
    if not npm:
        raise ValueError('找不到npm')
    # 不调用脚手架release命令；检查和构建完成后才读取候选。
    for args in [
        [sys.executable, 'scripts/check-publication.py', commit],
        [sys.executable, 'scripts/check-manifests.py'],
        [npm, 'run', 'test:core'],
        [npm, 'run', 'test:ui'],
        [sys.executable, '-m', 'unittest', 'discover', '-s', 'test', '-p', '*_test.py'],
        [npm, 'run', 'check'],
    ]:
        run(args)
    if git('rev-parse', 'HEAD') != commit or git('status', '--porcelain'):
        raise ValueError('准备期间源码或生成的跟踪文件变化，请核对后重新准备')
    spec = importlib.util.spec_from_file_location('candidate_check', ROOT / 'scripts/check-candidate.py')
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    candidate = checker.check(ROOT / '.scaffold/build')
    return commit, tree, candidate


def prepare():
    commit, tree, candidate = check_source()
    directory = ROOT / '_build' / datetime.now().strftime('%Y%m%d-%H%M%S')
    directory.parent.mkdir(exist_ok=True)
    info = freeze(directory, candidate, commit, tree, (ROOT / 'CHANGELOG.md').read_text(), (ROOT / 'LICENSE').is_file())
    if git('rev-parse', 'HEAD') != commit or git('status', '--porcelain'):
        (directory / 'PREPARE-FAILED.txt').write_text('准备期间源码变化；该目录不作为可交付候选。\n')
        raise ValueError('固定候选期间源码变化；候选不予交付，请重新准备')
    print(f'本地候选已准备：{directory.relative_to(ROOT)}')
    print(f'版本 {info["version"]}；标签 {info["tag"]}；提交 {commit}')
    print('尚未创建标签、推送或发布Release。下一步见RELEASING.md。')
    if info['developmentID'] or not info['licenseFilePresent']:
        print('当前仍含开发ID或未确定项目许可；正式发布前须处理。')
    return directory, info


def github_output(directory):
    output = os.environ.get('GITHUB_OUTPUT')
    if not output:
        raise ValueError('缺少GITHUB_OUTPUT')
    relative = directory.relative_to(ROOT).as_posix()
    if '\n' in relative or '\r' in relative:
        raise ValueError('候选目录不能包含换行')
    with open(output, 'a') as stream:
        stream.write(f'directory={relative}\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['check', 'prepare', 'verify'], nargs='?', default='prepare')
    parser.add_argument('directory', nargs='?', type=Path)
    parser.add_argument('--github-output', action='store_true')
    args = parser.parse_args()
    try:
        if args.command == 'verify':
            if args.directory is None:
                parser.error('verify需要候选目录')
            info = verify(args.directory)
            print(f'固定候选校验通过：{info["version"]}，源码{info["sourceCommit"][:12]}')
        elif args.directory is not None:
            parser.error('prepare不接受目录参数')
        elif args.command == 'check':
            check_source()
            print('CI检查与生产构建通过。')
        else:
            directory, _ = prepare()
            if args.github_output:
                github_output(directory)
        return 0
    except (AssertionError, OSError, ValueError, TypeError, KeyError, StopIteration, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        print(f'Release准备／校验失败：{error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
