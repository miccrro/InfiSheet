"""Inline image persistence used by project saves."""

import base64
import tempfile
from pathlib import Path

import server

with tempfile.TemporaryDirectory() as directory:
    original_data = server.DATA
    server.DATA = Path(directory)
    try:
        jpeg = b"\xff\xd8\xff\xe0" + b"sample image"
        encoded = base64.b64encode(jpeg).decode("ascii")
        url = server.store_edit_image("data:image/jpeg;base64," + encoded)
        image_hash = url.split("=", 1)[1]
        assert (Path(directory) / "edits" / f"{image_hash}.jpg").read_bytes() == jpeg
        assert server.edit_image_bytes(image_hash) == (jpeg, "image/jpeg")
        assert server.store_edit_image("data:image/jpeg;base64," + encoded) == url
        png = b"\x89PNG\r\n\x1a\n" + b"sample image"
        png_url = server.store_edit_image("data:image/png;base64," + base64.b64encode(png).decode())
        assert server.edit_image_bytes(png_url.split("=", 1)[1]) == (png, "image/png")
        try:
            server.store_edit_image("data:image/png;base64," + encoded)
        except ValueError:
            pass
        else:
            raise AssertionError("mismatched image MIME was accepted")
    finally:
        server.DATA = original_data

print("media persistence: ok")
