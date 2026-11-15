"""Update worker process detection regression checks."""

import hashlib
import io
import subprocess
import sys
import tempfile
import urllib.error
from pathlib import Path
from unittest.mock import patch

from tools.update_worker import download_archive, process_exists

proc = subprocess.Popen([sys.executable, "-c", "pass"], stdout=subprocess.DEVNULL)
try:
    proc.wait(timeout=10)
    assert not process_exists(proc.pid), "Exited process is still reported as running"
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()

print("Update worker process detection: ok")


class Response(io.BytesIO):
    headers = {"Content-Length": "7"}


class FlakyOpener:
    def __init__(self):
        self.attempts = 0

    def open(self, _request, timeout):
        self.attempts += 1
        if self.attempts == 1:
            raise urllib.error.URLError("temporary TLS disconnect")
        return Response(b"payload")


opener = FlakyOpener()
manifest = {
    "repo": "miccrro/InfiSheet",
    "url": "https://github.com/miccrro/InfiSheet/releases/download/v1.4.2/infisheet-1.4.2.zip",
    "tag": "v1.4.2",
    "version": "1.4.2",
    "sha256": hashlib.sha256(b"payload").hexdigest(),
}
with tempfile.TemporaryDirectory() as directory:
    destination = Path(directory) / "release.zip"
    with patch("tools.update_worker.urllib.request.build_opener", return_value=opener), \
            patch("tools.update_worker.time.sleep"):
        download_archive(manifest, destination)
    assert opener.attempts == 2
    assert destination.read_bytes() == b"payload"

print("Update worker transient download retry: ok")
