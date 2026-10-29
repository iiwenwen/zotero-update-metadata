#!/usr/bin/env python3
"""离线检查本地 XPI 与 update feed；不安装、不访问 URL、不宣称公开交付可用。"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile
from urllib.parse import unquote, urlsplit


def check(dist: Path) -> dict:
    packages = list(dist.glob("*.xpi"))
    assert len(packages) == 1, "候选目录必须恰好一个 XPI"
    package = packages[0]
    source = json.loads(Path("addon/manifest.json").read_text())
    package_meta = json.loads(Path("package.json").read_text())
    version = package_meta["version"]
    repository = package_meta["repository"]["url"].removesuffix(".git").removeprefix("git+").rstrip("/")
    assert package_meta.get("homepage") == repository, "项目主页缺失或与仓库不一致"
    assert package_meta.get("bugs", {}).get("url") == repository + "/issues", "问题反馈入口缺失"
    assert source.get("homepage_url") == repository, "安装清单缺少正确主页"
    repo_url = urlsplit(repository)
    assert repo_url.scheme == "https" and repo_url.netloc == "github.com", "发布仓库必须是明确的GitHub HTTPS地址"
    with zipfile.ZipFile(package) as archive:
        assert archive.testzip() is None, "XPI CRC 校验失败"
        names = archive.namelist()
        for name in names:
            assert ".." not in Path(name).parts and "\\" not in name, f"不安全包路径：{name}"
            assert name in ("manifest.json", "bootstrap.js", "prefs.js") or name.startswith(("content/", "locale/")), f"多余包文件：{name}"
            assert not any(part.startswith(".") or part in ("node_modules", "test", "tests", "docs", "profile", "data") for part in Path(name).parts), f"禁止入包：{name}"
            assert not name.endswith((".sqlite", ".xpi", ".map")), f"非运行内容：{name}"
        manifest = json.loads(archive.read("manifest.json"))
        zotero = manifest["applications"]["zotero"]
        assert manifest.get("homepage_url") == repository, "安装包主页缺失或错误"
        assert manifest["version"] == source["version"] == version, "包版本不一致"
        assert zotero["id"] == source["applications"]["zotero"]["id"], "包身份不一致"
        assert zotero["strict_min_version"] == "10.0" and zotero["strict_max_version"] == "10.0.*", "兼容范围错误"
        assert zotero["update_url"].startswith("https://") and "{{" not in zotero["update_url"], "未解析更新地址"
        update_path = "/releases/download/release/update-beta.json" if "-" in version else "/releases/latest/download/update.json"
        assert zotero["update_url"] == repository + update_path, "插件自动更新地址与仓库／渠道不一致"
        prefs = archive.read("prefs.js").decode()
        ui = archive.read("content/preferences.xhtml").decode()
        assert "defaultChecked" not in prefs + ui, "无效偏好仍在包内"
        assert 'pref("extensions.zmta.showTechnicalDetails", false)' in prefs, "技术详情默认值错误"
        for key, value in (("showItemPane", "true"), ("defaultSelectAttachments", "false"), ("defaultSelectNotes", "false")):
            assert f'pref("extensions.zmta.{key}", {value})' in prefs, f"安全初选／侧栏默认值错误：{key}"
            assert ui.count(f'preference="extensions.zmta.{key}"') == 1, f"设置绑定缺失或重复：{key}"
        assert 'preference="extensions.zmta.showTechnicalDetails"' not in ui, "普通设置不应保留技术详情控件"
        code = archive.read("content/scripts/zmta.js").decode()
        assert zotero["id"] in code, "运行时插件身份与安装清单不一致"
        if not zotero["id"].endswith("@local"):
            assert "zmta-update-metadata@local" not in code, "正式包仍包含旧开发注册身份"
        assert "Mock 场景" not in code and "npm start 使用离线 Mock" not in code, "Mock 实现未从生产包排除"
        assert not re.search(r"\.testApi\s*=", code), "测试 API 暴露到生产包"
        notice = archive.read("content/third-party-notices.txt").decode()
        assert Path("node_modules/zotero-plugin-toolkit/LICENSE").read_text() in notice, "遗漏运行依赖许可正文"
        assert "host-request-stopped" in code, "包未含最新 HTTP 保护"
        for name in names:
            if name.endswith((".js", ".json", ".xhtml", ".ftl", ".txt")):
                text = archive.read(name).decode()
                assert not re.search(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:sk-proj-|ghp_)[A-Za-z0-9_-]{20,}", text), f"疑似密钥：{name}"
    sha256 = hashlib.sha256(package.read_bytes()).hexdigest()
    sha512 = "sha512:" + hashlib.sha512(package.read_bytes()).hexdigest()
    feed_names = ["update-beta.json"] if "-" in version else ["update.json", "update-beta.json"]
    for feed_name in feed_names:
        feed = json.loads((dist / feed_name).read_text())
        updates = feed["addons"][zotero["id"]]["updates"]
        entry = next(item for item in updates if item["version"] == version)
        assert entry["update_hash"] == sha512, f"{feed_name} hash 不一致"
        assert entry["applications"]["zotero"]["strict_min_version"] == zotero["strict_min_version"], "feed最低版本不一致"
        assert entry["applications"]["zotero"]["strict_max_version"] == zotero["strict_max_version"], "feed最高版本不一致"
        assert entry["update_link"].endswith("/" + package.name), "下载文件名不一致"
        assert "{{" not in entry["update_link"] and entry["update_link"].startswith("https://"), "未解析下载地址"
        link = urlsplit(entry["update_link"])
        assert link.scheme == "https" and link.netloc == repo_url.netloc and not link.query and not link.fragment, "候选下载地址无效"
        assert unquote(link.path) == repo_url.path + "/releases/download/v" + version + "/" + package.name, "候选下载仓库／标签／文件名不一致"
    hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for base in ("src", "addon") for p in sorted(Path(base).rglob("*")) if p.is_file()}
    return {
        "status": "local-candidate-checks-passed",
        "xpi": str(package.resolve()), "bytes": package.stat().st_size,
        "version": version, "id": zotero["id"], "sha256": sha256, "update_hash": sha512,
        "update_feeds": feed_names,
        "head": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], text=True)),
        "runtime_files": names, "runtime_source_sha256": hashes,
        "limitations": ["本脚本仅检查包与当前源码／配置，不作发布放行", "更新URL仅静态一致性检查，未联网验证", "源码提交与实际宿主／评审证据须由交付流程另行对应"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dist", nargs="?", type=Path, default=Path(".scaffold/build"))
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    result = check(args.dist)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(f"✓ 本地候选包规则检查通过：{result['bytes']} bytes，{result['version']}，SHA-256 {result['sha256']}")
    print("仅离线包检查；发布许可、远端渠道、源码提交及宿主／评审证据须另行核实。")


if __name__ == "__main__":
    main()
