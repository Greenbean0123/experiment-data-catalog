"""Windows desktop launcher for Experiment Data Catalog."""
import argparse
import ctypes
import os
import sys
import threading
import traceback
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from server import launch_url, make_server


TITLE = "实验数据目录 · Experiment Data Catalog"
PORT = 18766


def guard_close(window):
    approved = checking = False

    def check():
        nonlocal approved, checking
        try:
            approved = window.run_js("window.confirmCatalogClose?.()") is not False
            if approved:
                window.destroy()
        finally:
            checking = False

    def on_closing():
        nonlocal checking
        if approved or not window.events.loaded.is_set():
            return True
        if not checking:
            checking = True
            # The host window's close event runs on the UI thread that must execute the script.
            threading.Thread(target=check, daemon=True).start()
        return False

    window.events.closing += on_closing


def run_desktop(data_dir, profile):
    import webview
    from webview.guilib import initialize

    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.settings["ALLOW_FILE_URLS"] = False
    if initialize("edgechromium").renderer != "edgechromium":
        raise RuntimeError("请安装 Microsoft Edge WebView2 Runtime。Install the Microsoft Edge WebView2 Runtime.")

    with make_server(data_dir, PORT) as server:
        address = f"http://127.0.0.1:{server.server_port}"
        worker = threading.Thread(target=server.serve_forever, name="catalog-http", daemon=True)
        worker.start()
        try:
            print(f"WebView2: {address}\nData: {server.store.data}", flush=True)
            window = webview.create_window(TITLE, launch_url(server.server_port, server.session_token, desktop=1),
                                          width=1280, height=850, min_size=(780, 560))
            guard_close(window)
            webview.start(gui="edgechromium", private_mode=False, storage_path=str(profile))
        finally:
            server.shutdown()
            worker.join()


def main():
    if sys.platform != "win32":
        raise SystemExit("The desktop trial runs on Windows.")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, help="Catalog data folder containing experiments.sqlite3 and files")
    args = parser.parse_args()
    state = Path(os.environ["LOCALAPPDATA"]) / "ExperimentDataCatalog"
    data_dir = (args.data_dir or state / "data").resolve()
    log_path = state / "desktop.log"
    try:
        state.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8", buffering=1) as log, redirect_stdout(log), redirect_stderr(log):
            try:
                run_desktop(data_dir, state / "webview")
            except Exception:
                traceback.print_exc()
                raise
    except Exception as error:
        ctypes.windll.user32.MessageBoxW(0, f"无法启动实验数据目录。\nCould not open the catalog.\n\n{error}\n\n{log_path}", TITLE, 0x10)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
