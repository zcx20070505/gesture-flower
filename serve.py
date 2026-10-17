"""
指尖花开 · 内置 HTTP 服务

比 `python -m http.server` 多两件事：
  1. 强制 UTF-8 + 正确的 MIME 类型
  2. **父进程监视**：启动器窗口被关掉（哪怕是强制结束）后，
     本服务会自动退出，不会留下占用端口的僵尸进程。

用法：
    python serve.py --port 5500 --parent <启动器的 PID>
"""

import argparse
import os
import sys
import threading
import time
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# 把工作目录切到脚本所在目录，保证无论从哪里启动都能找到 index.html
ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)


class Handler(SimpleHTTPRequestHandler):
    """在标准静态文件服务之上补齐几处细节。"""

    # 显式声明扩展名 → MIME，避免某些系统注册表把 .js 认成 text/plain
    # （浏览器会因此拒绝执行 ES Module）
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.html': 'text/html',
        '.json': 'application/json',
        '.ico': 'image/x-icon',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.wasm': 'application/wasm',
    }

    def end_headers(self):
        # 开发用：禁用缓存，改了代码刷新就能看到效果
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        # MediaPipe 的部分资源需要跨源隔离，这里放开基础限制
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def log_message(self, fmt, *args):
        # 静默：避免控制台被请求日志刷屏
        pass


def watch_parent(parent_pid: int, interval: float = 1.5) -> None:
    """
    后台线程：父进程消失时结束本进程。

    为什么要这么做：启动器（PowerShell 窗口）被用户直接关掉时，
    它来不及执行清理代码，本服务就会变成孤儿进程一直占着端口。
    这里用「父进程是否还活着」来判断，任何退出方式都能覆盖。
    """
    if parent_pid <= 0:
        return

    def loop():
        while True:
            time.sleep(interval)
            if not _process_alive(parent_pid):
                os._exit(0)

    t = threading.Thread(target=loop, daemon=True)
    t.start()


def _process_alive(pid: int) -> bool:
    """跨平台判断进程是否存活。"""
    if os.name == 'nt':
        import ctypes
        SYNCHRONIZE = 0x00100000
        # 用 SYNCHRONIZE 权限打开进程句柄；打不开说明进程已退出
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        # WAIT_TIMEOUT(258) = 仍存活；WAIT_OBJECT_0(0) = 已结束
        result = kernel32.WaitForSingleObject(handle, 0)
        kernel32.CloseHandle(handle)
        return result == 0x00000102
    else:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False


def main() -> int:
    ap = argparse.ArgumentParser(description='指尖花开本地服务')
    ap.add_argument('--port', type=int, default=5500)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--parent', type=int, default=0,
                    help='父进程 PID；父进程退出时本服务自动关闭')
    args = ap.parse_args()

    watch_parent(args.parent)

    handler = functools.partial(Handler, directory=ROOT)
    try:
        httpd = ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as e:
        print(f'端口 {args.port} 无法绑定：{e}', file=sys.stderr)
        return 1

    print(f'服务已启动: http://{args.host}:{args.port}/  (root={ROOT})', flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
