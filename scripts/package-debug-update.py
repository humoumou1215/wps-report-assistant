#!/usr/bin/env python3
"""Build a reusable fixed-dependency package and a content-addressed debug delta.

The payload passed to this script is the same payload used by the full installer.
Only files outside ``runtime/`` are considered updateable.  The previous dynamic
manifest is kept under dist/ so repeated builds transfer only changed files.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIXED_MANIFEST_NAME = "FIXED_DEPENDENCIES.json"


def canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def payload_files(payload: Path) -> dict[str, Path]:
    return {
        path.relative_to(payload).as_posix(): path
        for path in payload.rglob("*")
        if path.is_file() and path.name != FIXED_MANIFEST_NAME
    }


def write_zip(output: Path, entries: dict[str, Path], manifest: tuple[str, bytes] | None = None) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        if manifest is not None:
            archive.writestr(manifest[0], manifest[1])
        for relative in sorted(entries):
            archive.write(entries[relative], relative)
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise RuntimeError(f"损坏的调试包: {output}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("payload", type=Path, help="已完成 Agent Host 打包的 payload/app 目录")
    parser.add_argument("debug_root", type=Path, help="增量包状态和产物目录")
    parser.add_argument("target", help="目标标识，例如 windows-x64 或 macos-arm64")
    args = parser.parse_args()

    payload = args.payload.resolve()
    debug_root = args.debug_root.resolve()
    if not payload.is_dir():
        raise SystemExit(f"payload 不存在: {payload}")

    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    debug_root.mkdir(parents=True, exist_ok=True)

    all_files = payload_files(payload)
    runtime_files = {
        relative: path for relative, path in all_files.items() if relative.startswith("runtime/")
    }
    if not runtime_files:
        raise SystemExit("固定依赖包为空：payload 中未找到 runtime/")

    fixed_without_id = {
        "format": 1,
        "kind": "fixed-dependencies",
        "target": args.target,
        "files": {relative: sha256_file(runtime_files[relative]) for relative in sorted(runtime_files)},
    }
    base_id = hashlib.sha256(canonical_json(fixed_without_id)).hexdigest()
    fixed_manifest = dict(fixed_without_id, id=base_id)
    fixed_manifest_bytes = (json.dumps(fixed_manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    (payload / FIXED_MANIFEST_NAME).write_bytes(fixed_manifest_bytes)

    base_zip = debug_root / f"DataReportAssistant-Debug-Base-{args.target}.zip"
    previous_fixed_path = debug_root / "last-fixed-manifest.json"
    previous_fixed = None
    if previous_fixed_path.exists():
        previous_fixed = json.loads(previous_fixed_path.read_text(encoding="utf-8"))
    if not base_zip.exists() or not previous_fixed or previous_fixed.get("id") != base_id:
        write_zip(
            base_zip,
            {**runtime_files, FIXED_MANIFEST_NAME: payload / FIXED_MANIFEST_NAME},
        )

    dynamic_files = {
        relative: path
        for relative, path in payload_files(payload).items()
        if not relative.startswith("runtime/")
    }
    current_hashes = {relative: sha256_file(path) for relative, path in sorted(dynamic_files.items())}
    previous_path = debug_root / "last-update-manifest.json"
    previous = json.loads(previous_path.read_text(encoding="utf-8")) if previous_path.exists() else None
    previous_hashes = (previous or {}).get("files", {})
    changed = {
        relative: dynamic_files[relative]
        for relative, digest in current_hashes.items()
        if previous_hashes.get(relative) != digest
    }
    deleted = sorted(set(previous_hashes) - set(current_hashes))
    update_manifest = {
        "format": 1,
        "kind": "debug-update",
        "version": version,
        "target": args.target,
        "baseId": base_id,
        "fromVersion": (previous or {}).get("version"),
        "files": current_hashes,
        "changed": sorted(changed),
        "delete": deleted,
    }
    update_manifest_bytes = (json.dumps(update_manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    update_zip = debug_root / f"DataReportAssistant-Debug-Update-{version}-{args.target}.zip"
    write_zip(update_zip, changed, ("DEBUG_UPDATE_MANIFEST.json", update_manifest_bytes))

    shutil.copy2(ROOT / "scripts" / "apply-debug-update.ps1", debug_root / "Apply-DebugPackage.ps1")
    previous_fixed_path.write_text(json.dumps(fixed_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    previous_path.write_text(json.dumps(update_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    index = {
        "format": 1,
        "target": args.target,
        "basePackage": base_zip.name,
        "baseId": base_id,
        "updatePackage": update_zip.name,
        "version": version,
        "changedFileCount": len(changed),
        "deletedFileCount": len(deleted),
        "applyScript": "Apply-DebugPackage.ps1",
    }
    (debug_root / "DEBUG_PACKAGE_INDEX.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"固定依赖包: {base_zip} ({base_zip.stat().st_size / 1024**2:.2f} MiB)")
    print(f"调试增量包: {update_zip} ({update_zip.stat().st_size / 1024**2:.2f} MiB, changed={len(changed)})")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print(f"调试分包失败: {error}", file=sys.stderr)
        raise
