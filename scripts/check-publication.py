#!/usr/bin/env python3
"""只读检查指定公开ref及其可达历史；--index只检查待提交树，不作历史放行。"""
import argparse
from pathlib import PurePosixPath
import re
import subprocess
import sys

PRIVATE_ROOTS = {
    '.42cog', '.agents', '.claude', '.codex', 'state', 'skills', 'notes',
    'vault', 'resources', 'docs', '_tmp', '_build', '_archive', '.scaffold', 'node_modules',
}
PRIVATE_FILES = {'AGENTS.md', 'CLAUDE.md', 'plugin.json', '42plugin.json'}
PUBLIC_DOC_ASSETS = {'docs/images/item-pane.jpg', 'docs/images/preferences.jpg'}
PATTERNS = {
    'personal-home-path': re.compile(r'(?:/Users|/home)/[A-Za-z0-9._-]+(?:/|$)|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+'),
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'),
    'provider-token': re.compile(r'(?<![\w-])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{25,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})'),
    'credential-url': re.compile(r'https?://[^\s/:]+:[^\s/@]+@'),
}


def git(*args):
    return subprocess.check_output(['git', *args], stderr=subprocess.DEVNULL)


def path_issue(path):
    parts = PurePosixPath(path).parts
    if not parts or '..' in parts or path.startswith('/'):
        return 'unsafe-path'
    if (parts[0] in PRIVATE_ROOTS and path not in PUBLIC_DOC_ASSETS) or path in PRIVATE_FILES:
        return 'private-workspace-path'
    if any(p.startswith('.env') and p != '.env.example' for p in parts):
        return 'environment-values-file'
    if path.endswith(('.sqlite', '.sqlite3', '.sqlite-wal', '.sqlite-shm', '.pem', '.key', '.log')):
        return 'local-data-or-credential-file'
    return None


def text_issues(data, label):
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return []
    return [f'{label}:{line_no}: {kind}'
            for line_no, line in enumerate(text.splitlines(), 1)
            for kind, pattern in PATTERNS.items() if pattern.search(line)]


def check(ref='main', index=False):
    issues = []
    files = []
    if index:
        records = git('ls-files', '-s', '-z').split(b'\0')
        for record in filter(None, records):
            header, path = record.decode().split('\t', 1)
            mode, oid, stage = header.split()
            if stage != '0':
                issues.append('index: unresolved-merge')
            files.append((mode, oid, path))
    else:
        records = git('ls-tree', '-r', '-z', ref).split(b'\0')
        for record in filter(None, records):
            header, path = record.decode().split('\t', 1)
            mode, kind, oid = header.split()
            if kind != 'blob':
                issues.append(f'{path}: unsupported-git-object')
                continue
            files.append((mode, oid, path))
    for mode, oid, path in files:
        issue = path_issue(path)
        if issue:
            issues.append(f'{path}: {issue}')
        if mode == '160000':
            issues.append(f'{path}: submodule-not-audited')
            continue
        data = git('cat-file', 'blob', oid)
        if len(data) > 10_000_000:
            issues.append(f'{path}: file-over-10MB')
        if mode == '120000':
            target = data.decode()
            if target.startswith(('/', '\\')) or re.match(r'^[A-Za-z]:', target) or '..' in PurePosixPath(target).parts:
                issues.append(f'{path}: nonportable-symlink')
        issues.extend(text_issues(data, path))
    if not index:
        # 同一blob可能在不同提交中使用不同路径，不能只信rev-list给出的一个名称。
        historical_paths = set()
        for commit in git('rev-list', ref).decode().splitlines():
            for record in filter(None, git('ls-tree', '-r', '-z', commit).split(b'\0')):
                _, path = record.decode().split('\t', 1)
                if path not in historical_paths:
                    historical_paths.add(path)
                    issue = path_issue(path)
                    if issue:
                        issues.append(f'{path}: historical-{issue}')
        # 只遍历即将公开的ref；本地归档分支不在该范围内。
        seen = {oid for _, oid, _ in files}
        for row in git('rev-list', '--objects', ref).decode().splitlines():
            fields = row.split(' ', 1)
            if len(fields) != 2:
                continue
            oid, path = fields
            # 树对象也可能带路径；只检查历史文件对象。
            if git('cat-file', '-t', oid).strip() != b'blob':
                continue
            issue = path_issue(path)
            if issue:
                issues.append(f'{path}: historical-{issue}')
            if oid not in seen:
                seen.add(oid)
                data = git('cat-file', 'blob', oid)
                if len(data) > 10_000_000:
                    issues.append(f'{path}: historical-file-over-10MB')
                else:
                    issues.extend(text_issues(data, f'history/{path}'))
        commits = git('log', ref, '--format=%H%x00%ae%x00%ce%x00%B%x00').decode().split('\x00')
        for offset in range(0, len(commits) - 3, 4):
            oid, author, committer, message = commits[offset:offset + 4]
            for email in (author, committer):
                if email != 'noreply@github.com' and not re.fullmatch(r'[^\s@]+@users\.noreply\.github\.com', email):
                    issues.append(f'commit {oid.strip()[:12]}: non-GitHub-private-email')
            issues.extend(text_issues(message.encode(), f'commit {oid.strip()[:12]}'))
    return sorted(set(issues)), len(files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ref', nargs='?', default='main')
    parser.add_argument('--index', action='store_true')
    args = parser.parse_args()
    try:
        issues, count = check(args.ref, args.index)
    except (subprocess.CalledProcessError, ValueError, UnicodeError):
        print('无法读取目标Git树；检查失败，不视为通过。', file=sys.stderr)
        return 2
    if issues:
        print('\n'.join(issues))
        print(f'未通过：{len(issues)}项；输出不包含命中行原文。')
        return 1
    print(f'通过：{count}个文件；范围为' + ('暂存树（未检查提交历史）' if args.index else f'{args.ref}及其可达历史') + '。')
    print('模式检查不保证穷尽所有秘密，也不表示许可或发布验收已完成。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
