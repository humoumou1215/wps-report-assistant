#!/usr/bin/env python3
"""Fixed Windows x64 release entry point."""

from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
raise SystemExit(
    subprocess.call(
        [sys.executable, str(ROOT / "scripts" / "build-release.py"), "windows-x64"]
    )
)
