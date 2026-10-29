#!/usr/bin/env python3
"""只读核对公开Release、安装包信息与正式更新入口；不改Git或远端状态。"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import tempfile
from urllib.request import Request, urlopen
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'https://github.com/iiwenwen/zotero-update-metadata'
API = 'https://api.github.com/repos/iiwenwen/zotero-update-metadata'
LIMIT = 20 * 1024 * 1024
spec = importlib.util.spec_from_file_location('public_candidate', ROOT / 'scripts/prepare-release.py')
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


def read_url(url):
    request = Request(url, headers={'User-Agent': 'zotero-update-metadata-release-check'})
    with urlopen(request, timeout=45) as response:
        data = response.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError('远端文件超过检查上限')
    return data


def check(tag, read=read_url):
    if not re.fullmatch(r'v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', tag):
        raise ValueError('需要明确的v版本号')
    release = json.loads(read(f'{API}/releases/tags/{tag}'))
    beta = '-' in tag
    if release['draft'] or release['prerelease'] != beta or release['tag_name'] != tag or release['name'] != tag:
        raise ValueError('Release标题、标签或公开渠道不一致')
    assets = release['assets']
    if not 1 <= len(assets) <= 6 or len({a['name'] for a in assets}) != len(assets):
        raise ValueError('资产数量或名称不合法')
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        for asset in assets:
            name = asset['name']
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name):
                raise ValueError('资产文件名不合法')
            url = f'{REPOSITORY}/releases/download/{tag}/{name}'
            if asset['browser_download_url'] != url:
                raise ValueError('资产URL不属于当前仓库／版本')
            (directory / name).write_bytes(read(url))
        info = candidate.verify(directory)
        if info['tag'] != tag:
            raise ValueError('资产清单与公开版本不一致')
        with zipfile.ZipFile(directory / info['xpi']) as archive:
            manifest = json.loads(archive.read('manifest.json'))
        if manifest.get('homepage_url') != REPOSITORY:
            raise ValueError('公开安装包缺少正确主页')
        addon = manifest['applications']['zotero']
        if not beta:
            if info['developmentID'] or addon['id'].endswith('@local'):
                raise ValueError('正式版使用了开发身份')
            latest = json.loads(read(f'{API}/releases/latest'))
            if latest['id'] != release['id'] or latest['tag_name'] != tag:
                raise ValueError('正式版未成为Latest')
            feed_url = f'{REPOSITORY}/releases/latest/download/update.json'
            if addon.get('update_url') != feed_url:
                raise ValueError('公开安装包正式更新地址不正确')
            if read(feed_url) != (directory / 'update.json').read_bytes():
                raise ValueError('实际正式更新入口与已验资产不一致')
        return {'tag': tag, 'release': release['html_url'], 'addonID': info['addonID'],
                'sourceCommit': info['sourceCommit'], 'homepage': manifest['homepage_url'],
                'xpiSHA256': info['sha256'][info['xpi']], 'latestChecked': not beta}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tag', nargs='?')
    args = parser.parse_args()
    try:
        tag = args.tag or 'v' + json.loads((ROOT / 'package.json').read_text())['version']
        info = check(tag)
        print(f'公开发布检查通过：{tag}，{info["addonID"]}')
        print(f'主页、资产摘要、渠道{"、Latest与实际正式更新入口" if info["latestChecked"] else ""}已核对。')
        print('此检查不等同于Zotero宿主实际安装／升级验收。')
        return 0
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(f'公开发布检查失败：{error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
