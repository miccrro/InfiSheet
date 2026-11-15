"""Release archive checks for macOS launchers."""

import json
import tempfile
import zipfile
from pathlib import Path

from tools.pack import build

with tempfile.TemporaryDirectory() as directory:
    archive = build(Path(directory), False)[0]
    with zipfile.ZipFile(archive) as package:
        version = json.loads(package.read("infisheet/package.json"))["version"]
        plist = package.read("infisheet/InfiSheet.app/Contents/Info.plist").decode()
        assert f"<string>{version}</string>" in plist
        for name in (
            "infisheet/启动.command",
            "infisheet/InfiSheet.app/Contents/MacOS/InfiSheet",
        ):
            entry = package.getinfo(name)
            assert entry.create_system == 3, (name, entry.create_system)
            assert entry.external_attr >> 16 & 0o111 == 0o111, name
            assert b"\r\n" not in package.read(name), name

print("macOS launcher archive metadata: ok")
