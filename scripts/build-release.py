#!/usr/bin/env python3
"""Build distributable packages through one cross-platform release pipeline.

The platform-specific entry points delegate here so tests, payload assembly,
version checks, debug-package generation, and full-package validation cannot
drift between macOS and Windows builds.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
ROOT_DOCS = (
    "README.md",
    "VALIDATION_GUIDE.md",
    "DEBUG_GUIDE.md",
    "CHANGE_HISTORY.md",
    "HOST_CAPABILITIES.md",
    "MACOS_VALIDATION.md",
    "WINDOWS_VALIDATION.md",
    "JAVASCRIPT_VALIDATION.md",
    "THIRD_PARTY_NOTICES.md",
)
TARGETS = {
    "windows-x64": {
        "platform": "win32",
        "arch": "x64",
        "goos": "windows",
        "goarch": "amd64",
    },
    "macos-arm64": {
        "platform": "darwin",
        "arch": "arm64",
        "goos": "darwin",
        "goarch": "arm64",
    },
    "macos-amd64": {
        "platform": "darwin",
        "arch": "x64",
        "goos": "darwin",
        "goarch": "amd64",
    },
}


def npm_command() -> str:
    return "npm.cmd" if os.name == "nt" else "npm"


def display_command(command: list[object]) -> str:
    return " ".join(shlex.quote(str(item)) for item in command)


def run(
    command: list[object],
    cwd: Path = ROOT,
    env: dict[str, str] | None = None,
) -> None:
    normalized = [str(item) for item in command]
    print(f"[run] {display_command(normalized)}", flush=True)
    subprocess.run(normalized, cwd=cwd, env=env, check=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def zip_tree(source: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(source).as_posix())
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise RuntimeError(f"ZIP 校验失败: {output}")


def payload_manifest(payload: Path, version: str, target: str) -> dict[str, object]:
    files = {
        path.relative_to(payload).as_posix(): sha256_file(path)
        for path in sorted(payload.rglob("*"))
        if path.is_file()
    }
    return {"version": version, "target": target, "files": files}


def run_tests() -> None:
    run(["node", "scripts/check-version.mjs"])
    for module in ("core-go", "installer"):
        run(["go", "test", "./..."], cwd=ROOT / module)
        run(["go", "vet", "./..."], cwd=ROOT / module)
    js_tests = sorted((ROOT / "tests").glob("*.test.cjs"))
    run(["node", "--test", *js_tests])
    agent_host = ROOT / "agent-host"
    run([npm_command(), "ci", "--ignore-scripts"], cwd=agent_host)
    run([npm_command(), "test"], cwd=agent_host)


def copy_payload_sources(payload: Path, version: str) -> None:
    shutil.copytree(ROOT / "addins", payload / "addins")
    shutil.copytree(ROOT / "samples", payload / "samples")
    shutil.copytree(ROOT / "docs", payload / "docs")
    for relative in ROOT_DOCS:
        shutil.copy2(ROOT / relative, payload / relative)
    (payload / "VERSION.txt").write_text(version + "\n", encoding="ascii")


def required_payload_files(target: str) -> tuple[str, ...]:
    runtime_name = "runtime/node.exe" if target == "windows-x64" else "runtime/node"
    return (
        runtime_name,
        "agent-host/dist/agent-host/src/main.js",
        "README.md",
        "VALIDATION_GUIDE.md",
        "DEBUG_GUIDE.md",
        "CHANGE_HISTORY.md",
        "HOST_CAPABILITIES.md",
        "WINDOWS_VALIDATION.md",
        "samples/标准测试-本年预算.xlsx",
        "samples/标准测试-历史预算.xlsx",
        "samples/标准测试-预算汇报.pptx",
        "samples/调试步骤.md",
        "addins/et/taskpane.html",
        "addins/wpp/taskpane.html",
        "addins/wps/index.html",
        "addins/workspace/taskpane.html",
        "addins/workspace/hosts.js",
        "addins/workspace/workspace.js",
    )


def build_target(target: str, version: str) -> None:
    spec = TARGETS[target]
    print(f"\n=== 构建 {target} / {version} ===", flush=True)
    with tempfile.TemporaryDirectory(prefix=f"data-report-assistant-{target}-") as temp_name:
        temp = Path(temp_name)
        installer = temp / "installer"
        payload = installer / "payload" / "app"
        payload.mkdir(parents=True)
        for file in sorted((ROOT / "installer").glob("*.go")):
            shutil.copy2(file, installer / file.name)
        shutil.copy2(ROOT / "installer" / "go.mod", installer / "go.mod")
        copy_payload_sources(payload, version)

        run(
            [
                "node",
                "scripts/package-agent-host.mjs",
                payload,
                spec["platform"],
                spec["arch"],
            ]
        )
        debug_root = DIST / f"debug-{target}"
        run(
            [
                sys.executable,
                "scripts/package-debug-update.py",
                payload,
                debug_root,
                target,
            ]
        )

        missing = [
            relative
            for relative in required_payload_files(target)
            if not (payload / relative).is_file()
        ]
        if missing:
            raise RuntimeError(f"payload 缺少必需文件: {', '.join(missing)}")
        (payload / "BUILD_MANIFEST.json").write_text(
            json.dumps(payload_manifest(payload, version, target), ensure_ascii=False, indent=2)
            + "\n",
            encoding="utf-8",
        )

        if target == "windows-x64":
            build_windows(installer, payload, version, spec)
        else:
            build_macos(installer, payload, version, target, spec)


def build_windows(
    installer: Path,
    payload: Path,
    version: str,
    spec: dict[str, str],
) -> None:
    output = DIST / f"windows-x64-{version}"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    setup_name = f"DataReportAssistant-Setup-{version}.exe"
    setup = output / setup_name
    env = dict(
        os.environ,
        GOOS=spec["goos"],
        GOARCH=spec["goarch"],
        CGO_ENABLED="0",
    )

    payload_zip = installer / "payload" / "payload.zip"
    zip_tree(payload, payload_zip)
    shutil.rmtree(payload)
    run(
        [
            "go",
            "build",
            "-trimpath",
            "-ldflags",
            "-s -w -H=windowsgui",
            "-o",
            setup,
            ".",
        ],
        cwd=installer,
        env=env,
    )
    data = setup.read_bytes()
    pe_offset = struct.unpack_from("<I", data, 0x3C)[0]
    if data[:2] != b"MZ" or data[pe_offset : pe_offset + 4] != b"PE\0\0":
        raise RuntimeError(f"Windows 安装器不是有效 PE: {setup}")
    if struct.unpack_from("<H", data, pe_offset + 4)[0] != 0x8664:
        raise RuntimeError(f"Windows 安装器不是 amd64: {setup}")

    for relative in ROOT_DOCS:
        shutil.copy2(ROOT / relative, output / relative)
    shutil.copytree(ROOT / "samples", output / "samples")
    shutil.copytree(ROOT / "docs", output / "docs")
    (output / "SHA256SUMS.txt").write_text(
        f"{sha256_file(setup)}  {setup_name}\n", encoding="utf-8"
    )
    archive = DIST / f"DataReportAssistant-Windows-x64-{version}.zip"
    if archive.exists():
        archive.unlink()
    zip_tree(output, archive)
    print(f"Windows 安装器: {setup}")
    print(f"Windows 完整包: {archive}")
    print(f"Windows 安装器 SHA-256: {sha256_file(setup)}")
    print(f"Windows 完整包 SHA-256: {sha256_file(archive)}")


def build_macos(
    installer: Path,
    payload: Path,
    version: str,
    target: str,
    spec: dict[str, str],
) -> None:
    output = DIST / target
    output.mkdir(parents=True, exist_ok=True)
    payload_zip = installer / "payload" / "payload.zip"
    zip_tree(payload, payload_zip)
    shutil.rmtree(payload)
    binary = output / "DataReportAssistantInstaller"
    env = dict(
        os.environ,
        GOOS=spec["goos"],
        GOARCH=spec["goarch"],
        CGO_ENABLED="0",
    )
    run(["go", "build", "-trimpath", "-o", binary, "."], cwd=installer, env=env)
    if binary.read_bytes()[:4] != b"\xcf\xfa\xed\xfe":
        raise RuntimeError(f"macOS 安装器不是 64 位 Mach-O: {binary}")
    install_script = output / "安装.command"
    uninstall_script = output / "卸载.command"
    install_script.write_text(
        '#!/bin/bash\ncd "$(dirname "$0")"\n./DataReportAssistantInstaller\nprintf "\\n按回车退出"\nread -r\n',
        encoding="utf-8",
    )
    uninstall_script.write_text(
        '#!/bin/bash\ncd "$(dirname "$0")"\n./DataReportAssistantInstaller --uninstall\nprintf "\\n按回车退出"\nread -r\n',
        encoding="utf-8",
    )
    install_script.chmod(0o755)
    uninstall_script.chmod(0o755)
    print(f"macOS 安装器: {binary}")
    print(f"macOS 安装器 SHA-256: {sha256_file(binary)}")


def parse_targets(value: str) -> list[str]:
    if value == "all":
        return ["windows-x64", "macos-arm64"]
    if value not in TARGETS:
        raise ValueError(f"不支持的目标: {value}")
    return [value]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "target",
        choices=["all", *TARGETS],
        help="目标平台；all 同时构建 Windows x64 和 macOS arm64",
    )
    args = parser.parse_args()
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    run_tests()
    for target in parse_targets(args.target):
        build_target(target, version)
    print("\n发布构建完成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
