#!/usr/bin/env python3
"""Apply a verified InfiSheet release after the running server stops."""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path, PurePosixPath

MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_EXPANDED_BYTES = 600 * 1024 * 1024
MAX_ARCHIVE_FILES = 6000
ALLOWED_REDIRECT_HOSTS = {"release-assets.githubusercontent.com", "objects.githubusercontent.com"}
LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def fail(message: str) -> None:
    raise RuntimeError(message)


def show_error(message: str) -> None:
    if os.name == "nt":
        try:
            ctypes.windll.user32.MessageBoxW(0, message, "InfiSheet 更新失败", 0x10)
            return
        except Exception:  # noqa: BLE001 -- fall back to stderr if Windows UI is unavailable
            pass
    print(f"InfiSheet update failed: {message}", file=sys.stderr, flush=True)


def write_status(manifest: dict, status: str, message: str) -> None:
    try:
        path = Path(manifest["status_path"])
        tmp = path.with_name(path.name + f".{uuid.uuid4().hex[:8]}.tmp")
        payload = {"taskId": manifest["task_id"], "status": status,
                   "version": manifest["version"], "message": message,
                   "updatedAt": time.time()}
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except (KeyError, OSError, TypeError):
        pass


def safe_download_url(raw: str, repo: str) -> urllib.parse.SplitResult:
    parts = urllib.parse.urlsplit(raw)
    host = (parts.hostname or "").lower()
    prefix = f"/{repo}/releases/download/"
    if (parts.scheme != "https" or parts.username or parts.password or parts.port not in (None, 443)
            or host != "github.com" or not parts.path.startswith(prefix)):
        fail("更新下载地址不是此项目的 GitHub Release 资源")
    return parts


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parts = urllib.parse.urlsplit(newurl)
        host = (parts.hostname or "").lower()
        allowed = host == "github.com" or host in ALLOWED_REDIRECT_HOSTS
        if (parts.scheme != "https" or parts.username or parts.password
                or parts.port not in (None, 443) or not allowed):
            fail("GitHub 将下载重定向到了不受信任的地址")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download_archive(manifest: dict, destination: Path) -> None:
    repo = str(manifest["repo"])
    parts = safe_download_url(str(manifest["url"]), repo)
    tag = str(manifest["tag"])
    expected_prefix = f"/{repo}/releases/download/{urllib.parse.quote(tag, safe='')}/"
    asset_name = (urllib.parse.unquote(parts.path[len(expected_prefix):])
                  if parts.path.startswith(expected_prefix) else "")
    app_prefix = f"infisheet-{manifest['version']}"
    if ("/" in asset_name or asset_name.startswith("infisheet-data-")
            or not (asset_name == f"{app_prefix}.zip" or asset_name.startswith(f"{app_prefix}-"))
            or not asset_name.lower().endswith(".zip")):
        fail("更新包路径与目标版本不匹配")

    request = urllib.request.Request(manifest["url"], headers={
        "User-Agent": "InfiSheet-Updater/1",
        "Accept": "application/octet-stream",
    })
    opener = urllib.request.build_opener(SafeRedirect())
    digest = hashlib.sha256()
    total = 0
    with opener.open(request, timeout=30) as response, destination.open("wb") as out:
        length = response.headers.get("Content-Length")
        if length and int(length) > MAX_ARCHIVE_BYTES:
            fail("更新包超过 200 MB 上限")
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            total += len(block)
            if total > MAX_ARCHIVE_BYTES:
                fail("更新包超过 200 MB 上限")
            digest.update(block)
            out.write(block)
    expected_digest = str(manifest.get("sha256") or "").lower()
    if expected_digest and digest.hexdigest() != expected_digest:
        fail("更新包 SHA-256 校验失败")
    if not total:
        fail("GitHub 返回了空更新包")


def safe_members(archive: zipfile.ZipFile) -> list[tuple[zipfile.ZipInfo, PurePosixPath]]:
    infos = archive.infolist()
    if not infos or len(infos) > MAX_ARCHIVE_FILES:
        fail("更新包文件数量异常")
    total = 0
    seen: set[str] = set()
    members: list[tuple[zipfile.ZipInfo, PurePosixPath]] = []
    for info in infos:
        raw = info.filename
        if "\\" in raw or "\x00" in raw:
            fail("更新包含有非法路径")
        raw_parts = (raw[:-1] if raw.endswith("/") else raw).split("/")
        reserved = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)),
                    *(f"LPT{i}" for i in range(1, 10))}
        if (len(raw) > 240 or any(part in ("", ".", "..") for part in raw_parts)
                or any(any(char in part for char in '<>:"|?*') or part.endswith((".", " "))
                       or part.split(".", 1)[0].upper() in reserved for part in raw_parts)):
            fail("更新包包含不支持的文件名")
        path = PurePosixPath(raw)
        if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
            fail("更新包含有越界路径")
        if not path.parts or path.parts[0] != "infisheet":
            fail("更新包目录结构不正确")
        if len(path.parts) > 1 and path.parts[1].lower() in {
                "data", "assets", ".git", "dist", "node_modules"}:
            fail("更新包试图覆盖用户数据或仓库目录")
        normalized = "/".join(path.parts).casefold()
        if normalized in seen:
            fail("更新包含有重复路径")
        seen.add(normalized)
        mode = info.external_attr >> 16
        if mode and (mode & 0o170000) == 0o120000:
            fail("更新包不允许包含符号链接")
        if info.is_dir():
            continue
        total += info.file_size
        if total > MAX_EXPANDED_BYTES:
            fail("更新包解压后超过 600 MB 上限")
        if info.file_size and info.compress_size == 0:
            fail("更新包压缩信息无效")
        if info.compress_size and info.file_size / info.compress_size > 1000:
            fail("更新包压缩比异常")
        if len(path.parts) < 2:
            fail("更新包缺少应用文件")
        members.append((info, path))

    required = {"infisheet/server.py", "infisheet/package.json", "infisheet/static/app.js"}
    if not required.issubset(seen):
        fail("更新包缺少必要的程序文件")
    return members


def extract_archive(archive_path: Path, stage: Path, expected_version: str) -> Path:
    extracted = stage / "new"
    extracted.mkdir()
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = safe_members(archive)
            for info, member in members:
                relative = Path(*member.parts[1:])
                destination = extracted / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, destination.open("xb") as target:
                    shutil.copyfileobj(source, target, 1024 * 1024)
                mode = (info.external_attr >> 16) & 0o777
                if os.name != "nt" and mode:
                    os.chmod(destination, mode)
        package = json.loads((extracted / "package.json").read_text(encoding="utf-8"))
        actual = str(package.get("version") or "")
        if actual != expected_version:
            fail(f"更新包版本不匹配：预期 {expected_version}，实际 {actual or '未知'}")
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        fail(f"无法验证更新包（{type(exc).__name__}）")
    return extracted


def ensure_install_root(root: Path, current_version: str) -> Path:
    resolved = root.resolve(strict=True)
    if resolved == Path(resolved.anchor) or resolved.parent == resolved:
        fail("拒绝更新：程序目录位置异常")
    if (resolved / ".git").exists():
        fail("源码仓库不支持自动覆盖，请使用 Git 更新")
    if not all((resolved / name).is_file()
               for name in ("server.py", "package.json", "tools/pack.py", "tools/update_worker.py")):
        fail("找不到有效的 InfiSheet 安装目录")
    if not (resolved / "static").is_dir():
        fail("程序目录缺少 static 文件夹")
    try:
        package = json.loads((resolved / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        fail(f"无法读取当前安装版本（{type(exc).__name__}）")
    if package.get("name") != "infisheet":
        fail("当前目录不是 InfiSheet 安装目录")
    if str(package.get("version") or "") != current_version:
        fail("安装目录版本已变化，请重新检查更新")
    return resolved


def apply_files(root: Path, extracted: Path, backup: Path,
                changes: list[tuple[Path, Path | None]]) -> None:
    for source in sorted(p for p in extracted.rglob("*") if p.is_file()):
        relative = source.relative_to(extracted)
        target = root / relative
        if target.is_symlink() or any(parent.is_symlink() for parent in target.parents if parent != root.parent):
            fail("安装目录含有符号链接，已停止更新")
        resolved = target.resolve(strict=False)
        if root not in resolved.parents:
            fail("更新目标超出程序目录")
        if target.exists() and not target.is_file():
            fail(f"更新目标不是普通文件：{relative}")
        target.parent.mkdir(parents=True, exist_ok=True)
        saved = None
        if target.exists():
            saved = backup / relative
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, saved)
        os.replace(source, target)
        changes.append((target, saved))


def restore_files(changes: list[tuple[Path, Path | None]]) -> None:
    for target, saved in reversed(changes):
        if saved and saved.exists():
            os.replace(saved, target)
        elif target.exists():
            target.unlink()


def process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError as exc:
        if os.name == "nt" and getattr(exc, "winerror", None) == 87:
            return False
        raise


def stop_server(manifest: dict) -> None:
    request = urllib.request.Request(manifest["shutdown_url"], data=b"", method="POST",
                                     headers={"Content-Length": "0"})
    try:
        LOCAL_OPENER.open(request, timeout=5).read()
    except urllib.error.URLError:
        if process_exists(int(manifest["pid"])):
            raise
    deadline = time.time() + 25
    while process_exists(int(manifest["pid"])) and time.time() < deadline:
        time.sleep(0.25)
    if process_exists(int(manifest["pid"])):
        fail("本地服务没有按时退出，未替换程序文件")


def start_server(manifest: dict) -> subprocess.Popen:
    command = [manifest["python"], str(Path(manifest["root"]) / "server.py"), *manifest["args"]]
    options = {"cwd": manifest["root"], "env": os.environ.copy()}
    if os.name == "nt":
        options["creationflags"] = getattr(subprocess, "CREATE_NEW_CONSOLE", 0x10)
    else:
        options["start_new_session"] = True
        options["stdout"] = subprocess.DEVNULL
        options["stderr"] = subprocess.DEVNULL
    return subprocess.Popen(command, **options)


def wait_for_server(proc: subprocess.Popen, host: str, port: int, version: str) -> bool:
    url = f"http://{host}:{port}/api/version"
    deadline = time.time() + 25
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        try:
            with LOCAL_OPENER.open(url, timeout=1) as response:
                data = json.loads(response.read().decode("utf-8"))
            if data.get("ok") and data.get("version") == version:
                return True
        except Exception:  # noqa: BLE001 -- the new server may need time to bind
            time.sleep(0.5)
    return False


def run(manifest_path: Path) -> None:
    manifest = {}
    stage = None
    cleanup_dir = False
    changes: list[tuple[Path, Path | None]] = []
    server_stopped = False
    new_proc = None
    keep_backup = False
    try:
        work_dir = manifest_path.parent.resolve(strict=True)
        temp_root = Path(tempfile.gettempdir()).resolve()
        if (manifest_path.name != "update.json" or work_dir.parent != temp_root
                or not work_dir.name.startswith("infisheet-update-")):
            fail("更新任务文件位置无效")
        manifest_path = work_dir / "update.json"
        cleanup_dir = True
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        root = ensure_install_root(Path(manifest["root"]), str(manifest.get("current_version") or ""))
        stage = Path(tempfile.mkdtemp(prefix=".infisheet-update-", dir=root.parent))
        archive = stage / "release.zip"
        write_status(manifest, "downloading", "正在从 GitHub 下载更新包")
        download_archive(manifest, archive)
        write_status(manifest, "validating", "正在校验更新包和版本")
        extracted = extract_archive(archive, stage, str(manifest["version"]))
        write_status(manifest, "restarting", "更新包通过校验，服务即将重启")
        stop_server(manifest)
        server_stopped = True
        apply_files(root, extracted, stage / "backup", changes)
        new_proc = start_server(manifest)
        if not wait_for_server(new_proc, str(manifest["health_host"]),
                               int(manifest["port"]), str(manifest["version"])):
            fail("新版启动检查失败")
        write_status(manifest, "complete", f"已更新到 InfiSheet {manifest['version']}")
    except Exception as exc:  # noqa: BLE001 -- every failed install must roll back and report status
        message = str(exc) if isinstance(exc, RuntimeError) else f"更新失败（{type(exc).__name__}）"
        if changes:
            if new_proc and new_proc.poll() is None:
                new_proc.terminate()
                try:
                    new_proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    new_proc.kill()
            try:
                restore_files(changes)
                changes.clear()
            except OSError as restore_exc:
                keep_backup = True
                message = (f"{message}；旧文件回滚失败（{type(restore_exc).__name__}），"
                           f"备份保留在 {stage / 'backup'}")
        if server_stopped and not keep_backup:
            try:
                start_server(manifest)
                server_stopped = False
            except Exception as restart_exc:  # noqa: BLE001 -- preserve both recovery failures
                message = f"更新失败：{message}；旧版服务也未能自动启动（{type(restart_exc).__name__}）"
                write_status(manifest, "error", message)
                show_error(message)
                raise
        write_status(manifest, "error", message)
        show_error(message)
    finally:
        if stage and not keep_backup:
            shutil.rmtree(stage, ignore_errors=True)
        if cleanup_dir:
            for temporary_file in (manifest_path, manifest_path.parent / "update_worker.py"):
                try:
                    temporary_file.unlink(missing_ok=True)
                except OSError:
                    pass
            try:
                manifest_path.parent.rmdir()
            except OSError:
                pass


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: update_worker.py MANIFEST.json")
    run(Path(sys.argv[1]))
