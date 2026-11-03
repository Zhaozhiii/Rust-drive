"""Local preview with the real Rust API and live frontend files (Python stdlib only).

Run on Linux/WSL: python3 tools/preview.py --demo
The preview data stays in artifacts/preview-data, separate from deployed storage.
"""
import argparse
import contextlib
import http.client
import mimetypes
import os
from pathlib import Path
import re
import socket
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

PROJECT = Path(__file__).resolve().parent.parent
BLOCK = 256 * 1024
HOP_HEADERS = {"connection", "transfer-encoding", "keep-alive", "proxy-connection"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=PROJECT / "artifacts/drive-service-preview")
    parser.add_argument("--data", type=Path, default=PROJECT / "artifacts/preview-data")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--demo", action="store_true", help="Add a few sample text files if absent")
    args = parser.parse_args()
    data = args.data.resolve()
    data.mkdir(parents=True, exist_ok=True)
    if args.demo:
        for folder in ("项目文档", "灵感收集"):
            (data / folder).mkdir(exist_ok=True)
        samples = {
            "动效预览说明.txt": "欢迎来到云盘本地预览。\n\n试试切换黑白配色、把文件拖进来、暂停后继续上传。\n点击删除图标展开滑块，拖到终点松手确认，Esc 收起。\n点击名称、大小或修改时间表头切换排序；第三次点击恢复时间序。\n所有操作都使用本地预览目录。\n",
            "上传一份文件试试.md": "# 一点轻盈，传输自如\n\n拖入文件时，飞行胶囊跟随、文件夹打开；松手后胶囊缩小入舱。\n上传进度、速度、分片状态都来自真实传输。\n",
            "项目文档/开始使用.txt": "这里是一个本地示例文件夹。可以上传、下载、新建和删除。\n",
        }
        for name, content in samples.items():
            target = data / name
            if not target.exists():
                target.write_text(content, encoding="utf-8")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        backend_port = sock.getsockname()[1]
    env = dict(os.environ, CLOUDDRIVE_ROOT=str(data), DRIVE_LISTEN=f"127.0.0.1:{backend_port}", DRIVE_DISK_RESERVE_BYTES="0")
    backend = subprocess.Popen([str(args.binary.resolve())], env=env)
    try:
        for _ in range(100):
            if backend.poll() is not None:
                raise RuntimeError("Rust backend exited during startup")
            try:
                with socket.create_connection(("127.0.0.1", backend_port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise RuntimeError("Rust backend did not become ready")

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def file(self, target, headers=None):
                try:
                    handle = target.open("rb")
                except OSError:
                    self.send_error(404)
                    return
                with handle:
                    size = os.fstat(handle.fileno()).st_size
                    start, end, partial = 0, size - 1, False
                    requested = self.headers.get("Range")
                    if requested:
                        match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested)
                        if match and (match[1] or match[2]):
                            if match[1]:
                                start = int(match[1])
                                if match[2]:
                                    end = min(end, int(match[2]))
                            else:
                                start = max(0, size - int(match[2]))
                            partial = True
                        if not partial or start > end or start >= size:
                            self.send_response(416)
                            self.send_header("Content-Range", f"bytes */{size}")
                            self.send_header("Content-Length", "0")
                            self.end_headers()
                            return
                    self.send_response(206 if partial else 200)
                    content_type = (headers or {}).get("Content-Type") or mimetypes.guess_type(target)[0] or "application/octet-stream"
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(max(0, end - start + 1)))
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("X-Content-Type-Options", "nosniff")
                    if partial:
                        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                    if headers and headers.get("Content-Disposition"):
                        self.send_header("Content-Disposition", headers["Content-Disposition"])
                    self.end_headers()
                    if self.command == "HEAD":
                        return
                    handle.seek(start)
                    remaining = end - start + 1
                    while remaining > 0:
                        block = handle.read(min(BLOCK, remaining))
                        if not block:
                            break
                        self.wfile.write(block)
                        remaining -= len(block)

            def dispatch(self):
                route = urlsplit(self.path).path
                if self.command in {"GET", "HEAD"} and route in {"/", "/app.js"}:
                    self.file(PROJECT / "web" / ("index.html" if route == "/" else "app.js"))
                    return
                if not route.startswith("/api/clouddrive/") and route != "/healthz":
                    self.send_error(404)
                    return
                conn = http.client.HTTPConnection("127.0.0.1", backend_port, timeout=300)
                try:
                    headers = {key: value for key, value in self.headers.items() if key.lower() not in HOP_HEADERS}
                    conn.putrequest(self.command, self.path, skip_host=True)
                    for key, value in headers.items():
                        conn.putheader(key, value)
                    conn.endheaders()
                    remaining = int(self.headers.get("Content-Length", "0"))
                    while remaining > 0:
                        block = self.rfile.read(min(BLOCK, remaining))
                        if not block:
                            return
                        conn.send(block)
                        remaining -= len(block)
                    response = conn.getresponse()
                    redirect = response.getheader("X-Accel-Redirect")
                    if redirect and response.status == 200:
                        prefix = "/_drive_internal/"
                        if not redirect.startswith(prefix):
                            self.send_error(502)
                            return
                        target = (data / unquote(redirect[len(prefix):])).resolve()
                        if not target.is_relative_to(data) or not target.is_file():
                            self.send_error(404)
                            return
                        self.file(target, dict(response.getheaders()))
                        return
                    self.send_response(response.status)
                    for key, value in response.getheaders():
                        if key.lower() not in HOP_HEADERS:
                            self.send_header(key, value)
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    if self.command != "HEAD":
                        while block := response.read(BLOCK):
                            self.wfile.write(block)
                finally:
                    conn.close()

            def do_GET(self):
                with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                    self.dispatch()

            do_HEAD = do_POST = do_PUT = do_DELETE = do_GET

        with ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as server:
            print(f"Local preview: http://localhost:{args.port}\nData: {data}\nFrontend changes reload directly; Ctrl+C stops preview.", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        backend.terminate()
        backend.wait(timeout=10)


if __name__ == "__main__":
    main()
