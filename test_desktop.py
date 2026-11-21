"""Test the Windows desktop launcher and its release ZIP using temporary catalogs."""
import ctypes
import errno
import io
import json
import os
import platform
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from contextlib import ExitStack, closing, contextmanager, redirect_stdout
from ctypes import wintypes
from http.client import HTTPConnection, HTTPException
from importlib.util import find_spec
from pathlib import Path, PurePosixPath
from unittest.mock import MagicMock, Mock, patch
from urllib.parse import parse_qs, urlencode, urlsplit

import desktop
import package_desktop
from package_app import FILES, ROOT
from package_desktop import APP_NAME, EXCLUDED_FILES, NOTICE_ENTRIES, RELEASE_NAME, RELEASE_ZIP
from server import APP_ID, SCHEMA_VERSION, SESSION_FILE, DataDirInUse, DataDirLock, Handler, make_server
from test_server import create_schema_zero_catalog


def get(port, path, headers=None):
    client = HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        client.request("GET", path, headers=headers or {})
        with client.getresponse() as response:
            return response.status, response.read(), response.headers
    finally:
        client.close()


@unittest.skipUnless(sys.platform == "win32", "the desktop wrapper runs on Windows")
class DesktopTests(unittest.TestCase):
    def setUp(self):
        scope = ExitStack()
        self.addCleanup(scope.close)
        self.root = Path(scope.enter_context(tempfile.TemporaryDirectory(prefix="catalog-desktop-"))).resolve()
        self.state = self.root / "local" / "ExperimentDataCatalog"
        scope.enter_context(patch.dict(os.environ, LOCALAPPDATA=str(self.state.parent)))
        scope.enter_context(patch.object(desktop, "PORT", 0))
        self.dialog = scope.enter_context(patch.object(desktop.ctypes.windll.user32, "MessageBoxW"))
        self.webview = Mock(settings={}, create_window=Mock(return_value=MagicMock()))
        guilib = Mock()
        guilib.initialize.return_value.renderer = "edgechromium"
        scope.enter_context(patch.dict(sys.modules, {"webview": self.webview, "webview.guilib": guilib}))

    def test_data_dir_argument_is_resolved(self):
        (self.root / "input").mkdir()
        argument = self.root / "input" / ".." / "catalog"
        with patch.object(sys, "argv", ["desktop.py", "--data-dir", str(argument)]), \
                patch.object(desktop, "run_desktop") as run:
            self.assertEqual(desktop.main(), 0)
        run.assert_called_once_with(self.root / "catalog", self.state / "webview")

    def test_default_data_dir_is_under_local_app_data(self):
        with patch.object(sys, "argv", ["desktop.py"]), patch.object(desktop, "run_desktop") as run:
            self.assertEqual(desktop.main(), 0)
        run.assert_called_once_with(self.state / "data", self.state / "webview")

    def test_window_uses_live_session_and_releases_lock_on_close(self):
        data_dir = self.root / "catalog"
        session_path = data_dir / SESSION_FILE

        def close_window(**_settings):
            session = json.loads(session_path.read_text(encoding="utf-8"))
            url = urlsplit(self.webview.create_window.call_args.args[1])
            self.assertEqual((url.scheme, url.netloc, url.path), ("http", f"127.0.0.1:{session['port']}", "/"))
            self.assertEqual(parse_qs(url.query), {"token": [session["token"]], "desktop": ["1"]})
            self.assertEqual(get(session["port"], f"/?{url.query}")[0], 303)

        self.webview.start.side_effect = close_window
        with redirect_stdout(io.StringIO()), patch.object(Handler, "log_message"):
            desktop.run_desktop(data_dir, self.state / "webview")
        self.webview.start.assert_called_once_with(gui="edgechromium", private_mode=False,
                                                   storage_path=str(self.state / "webview"))
        self.assertFalse(session_path.exists())
        with make_server(data_dir, 0):
            pass

    def test_locked_catalog_is_reported_without_writing_to_it(self):
        data_dir = self.root / "catalog"
        with make_server(data_dir, 0) as owner:
            owner.store.save({"sample_id": "S-001", "notes": "demo sample"})
            session_path = data_dir / SESSION_FILE
            before = sorted(data_dir.rglob("*")), owner.store.db.read_bytes(), session_path.read_bytes()
            with patch.object(sys, "argv", ["desktop.py", "--data-dir", str(data_dir)]):
                self.assertEqual(desktop.main(), 1)
            self.webview.create_window.assert_not_called()
            self.webview.start.assert_not_called()
            self.dialog.assert_called_once()
            message = "This data folder is already open in another Experiment Data Catalog window or service."
            self.assertIn(message, self.dialog.call_args.args[1])
            self.assertIn(message, (self.state / "desktop.log").read_text(encoding="utf-8"))
            self.assertEqual((sorted(data_dir.rglob("*")), owner.store.db.read_bytes(), session_path.read_bytes()), before)


class ReleaseZipTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "win32", "the build launcher targets Windows")
    def test_build_relaunches_with_clean_python_environment(self):
        environment = {"PATH": str(ROOT), "PYTHONPATH": "shadow", "PYTHONHOME": "other-python",
                       "PYTHONSTARTUP": "startup.py", "PYTHONUSERBASE": "user",
                       "PYTHONOPTIMIZE": "2", "PYTHONNOUSERSITE": "0"}
        with patch.dict(os.environ, environment, clear=True), \
                patch.object(subprocess, "run", return_value=Mock(returncode=0)) as launch:
            self.assertTrue(package_desktop.build_in_isolated_process())
        self.assertIn("-I", launch.call_args.args[0])
        self.assertEqual(launch.call_args.kwargs["env"], {"PATH": str(ROOT), "PYTHONNOUSERSITE": "1"})

    def test_origin_check_rejects_foreign_modules_and_binaries(self):
        with tempfile.TemporaryDirectory(prefix="catalog-origin-") as folder:
            checkout = Path(folder) / "checkout"
            outside = checkout.with_name("checkout-shadow")
            with patch.object(package_desktop, "ROOT", checkout):
                package_desktop.validate_origins([
                    ("desktop", checkout / "desktop.py", "PYSOURCE"),
                    ("csv", Path(sys.base_prefix) / "Lib" / "csv.py", "PYMODULE"),
                    ("webview", Path(sys.prefix) / "Lib" / "site-packages" / "webview" / "__init__.py", "PYMODULE"),
                    ("namespace", None, "PYMODULE"),
                ])
                with self.assertRaises(SystemExit) as error:
                    package_desktop.validate_origins([
                        ("csv", outside / "csv.py", "PYMODULE"),
                        ("sqlite3.dll", outside / "sqlite3.dll", "BINARY"),
                    ])
        self.assertIn(f"csv: {(outside / 'csv.py').resolve()}", str(error.exception))
        self.assertIn(f"sqlite3.dll: {(outside / 'sqlite3.dll').resolve()}", str(error.exception))

    def test_missing_notices_are_reported_together(self):
        missing = {
            "licenses/Python.txt": Path("missing-python-license.txt"),
            "licenses/OpenSSL-3.0.16.txt": Path("missing-openssl-license.txt"),
        }
        with patch.object(package_desktop, "LOCAL_NOTICES", missing), \
                patch.object(package_desktop, "WHEEL_NOTICES", {}), self.assertRaises(SystemExit) as error:
            package_desktop.collect_notices()
        self.assertIn("Missing required desktop redistribution notices", str(error.exception))
        for name in missing:
            self.assertIn(name, str(error.exception))

    def test_release_zip_has_all_required_notices(self):
        if not RELEASE_ZIP.is_file():
            self.skipTest(f"build {RELEASE_ZIP.name} with package_desktop.py to run this test")
        release = PurePosixPath(RELEASE_NAME)
        with zipfile.ZipFile(RELEASE_ZIP) as archive:
            entries = {PurePosixPath(name) for name in archive.namelist()}
            self.assertEqual({release / "_internal" / name for name in FILES} - entries, set())
            self.assertIn(release / f"{APP_NAME}.exe", entries)
            notices = {entry.relative_to(release).as_posix() for entry in entries
                       if entry.parts[:2] == (RELEASE_NAME, "licenses")}
            self.assertEqual(notices, NOTICE_ENTRIES)
            self.assertTrue({"licenses/OpenSSL-3.0.16.txt", "licenses/Python.txt", "licenses/pywebview/LICENSE",
                             "licenses/pythonnet/LICENSE", "licenses/proxy_tools/LICENSE-upstream.txt"} <= notices)
            for filename in ("LICENSE", "THIRD_PARTY_NOTICES.txt"):
                self.assertEqual(archive.read(f"{RELEASE_NAME}/licenses/new-api/{filename}"),
                                 (ROOT / filename).read_bytes())
            for name in sorted(notices):
                with self.subTest(notice=name):
                    content = archive.read(f"{RELEASE_NAME}/{name}")
                    self.assertTrue(content.strip())
                    if name in FILES:
                        self.assertEqual(content, (ROOT / name).read_bytes())
            internal = {entry.relative_to(release / "_internal").as_posix() for entry in entries
                        if entry.parts[:2] == (RELEASE_NAME, "_internal")}
            self.assertTrue(internal.isdisjoint(EXCLUDED_FILES))
            for entry in entries:
                self.assertTrue({"data", "research"}.isdisjoint(part.lower() for part in entry.parts), str(entry))
                self.assertNotIn(entry.suffix.lower(), {".sqlite3", ".log", ".db"}, str(entry))
            if find_spec("PyInstaller") is not None:
                with tempfile.TemporaryDirectory(prefix="catalog-zip-audit-") as folder:
                    exe = archive.extract((release / f"{APP_NAME}.exe").as_posix(), folder)
                    package_desktop.validate_bundle(exe, internal)


@unittest.skipUnless(sys.platform == "win32" and platform.machine().upper() == "AMD64", "the ZIP targets Windows x64")
class PackagedDesktopTests(unittest.TestCase):
    def setUp(self):
        if not RELEASE_ZIP.is_file():
            self.skipTest(f"build {RELEASE_ZIP.name} with package_desktop.py to run this test")
        try:
            self.probe_port()
        except OSError as error:
            if error.winerror in (errno.WSAEADDRINUSE, errno.WSAEACCES):
                self.skipTest(f"desktop port {desktop.PORT} is already in use or unavailable (WinError {error.winerror})")
            raise
        folder = tempfile.TemporaryDirectory(prefix="catalog-packaged-")
        self.addCleanup(self.clean_folder, folder)
        root = Path(folder.name).resolve()
        with zipfile.ZipFile(RELEASE_ZIP) as archive:
            archive.extractall(root)
        self.exe = root / RELEASE_NAME / f"{APP_NAME}.exe"
        self.data_dir = root / "catalog"
        local = root / "local"
        self.log = local / "ExperimentDataCatalog" / "desktop.log"
        self.env = dict(os.environ, LOCALAPPDATA=str(local), APPDATA=str(root / "roaming"),
                        TEMP=str(root), TMP=str(root))

    @staticmethod
    def clean_folder(folder):
        # Windows may retain image or WebView2 profile handles briefly after process exit.
        deadline = time.monotonic() + 15
        while True:
            try:
                folder.cleanup()
                return
            except PermissionError:
                if time.monotonic() >= deadline:
                    raise
            time.sleep(0.1)

    @contextmanager
    def launched(self):
        import _winapi

        class JobAccounting(ctypes.Structure):
            _fields_ = [
                ("total_user", ctypes.c_int64), ("total_kernel", ctypes.c_int64),
                ("period_user", ctypes.c_int64), ("period_kernel", ctypes.c_int64),
                ("page_faults", wintypes.DWORD), ("total_processes", wintypes.DWORD),
                ("active_processes", wintypes.DWORD), ("terminated_processes", wintypes.DWORD),
            ]

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        handle, dword = wintypes.HANDLE, wintypes.DWORD
        for function, args, result in (
            (kernel.CreateJobObjectW, [ctypes.c_void_p, wintypes.LPCWSTR], handle),
            (kernel.AssignProcessToJobObject, [handle, handle], wintypes.BOOL),
            (kernel.TerminateJobObject, [handle, wintypes.UINT], wintypes.BOOL),
            (kernel.QueryInformationJobObject, [handle, ctypes.c_int, ctypes.c_void_p, dword, ctypes.c_void_p],
             wintypes.BOOL),
            (kernel.ResumeThread, [handle], dword),
        ):
            function.argtypes, function.restype = args, result

        command = subprocess.list2cmdline([str(self.exe), "--data-dir", str(self.data_dir)])
        with ExitStack() as scope:
            job = kernel.CreateJobObjectW(None, None)
            if not job:
                raise ctypes.WinError(ctypes.get_last_error())
            scope.callback(_winapi.CloseHandle, job)
            # Attach while suspended so any WebView2 child starts inside the same job.
            process, thread, pid, _ = _winapi.CreateProcess(
                str(self.exe), command, None, None, False, 0x00000004, self.env,  # CREATE_SUSPENDED
                str(self.exe.parent), subprocess.STARTUPINFO())
            scope.callback(_winapi.CloseHandle, process)
            scope.callback(_winapi.CloseHandle, thread)
            if not kernel.AssignProcessToJobObject(job, process):
                error = ctypes.WinError(ctypes.get_last_error())
                _winapi.TerminateProcess(process, 1)
                _winapi.WaitForSingleObject(process, 10000)
                raise error
            try:
                if kernel.ResumeThread(thread) == 0xFFFFFFFF:
                    raise ctypes.WinError(ctypes.get_last_error())
                yield process, pid
            finally:
                if not kernel.TerminateJobObject(job, 1):
                    raise ctypes.WinError(ctypes.get_last_error())
                self.assertEqual(_winapi.WaitForSingleObject(process, 15000), _winapi.WAIT_OBJECT_0,
                                 "packaged exe did not terminate during cleanup")
                info = JobAccounting()
                deadline = time.monotonic() + 15
                while True:
                    # JobObjectBasicAccountingInformation includes descendants after the launcher exits.
                    if not kernel.QueryInformationJobObject(job, 1, ctypes.byref(info), ctypes.sizeof(info), None):
                        raise ctypes.WinError(ctypes.get_last_error())
                    if not info.active_processes:
                        break
                    if time.monotonic() >= deadline:
                        self.fail(f"{info.active_processes} processes remain in the packaged app's Windows job")
                    time.sleep(0.1)

    def wait_for_session(self, process, pid):
        import _winapi

        session_path = self.data_dir / SESSION_FILE
        deadline = time.monotonic() + 60
        while _winapi.WaitForSingleObject(process, 0) == _winapi.WAIT_TIMEOUT and time.monotonic() < deadline:
            if session_path.is_file():
                session = json.loads(session_path.read_text(encoding="utf-8"))
                # After a forced exit, the old session file can outlive its process.
                if session["pid"] == pid:
                    self.assertEqual(session["port"], desktop.PORT)
                    try:
                        status, body, _ = get(desktop.PORT, "/api/health")
                    except (OSError, HTTPException):
                        pass
                    else:
                        if status == 200:
                            self.assertEqual(json.loads(body)["app"], APP_ID)
                            return session
            time.sleep(0.1)
        details = self.log.read_text(encoding="utf-8") if self.log.is_file() else "no desktop log"
        self.fail(f"Packaged app did not serve its catalog on port {desktop.PORT}: {details}")

    @staticmethod
    def probe_port():
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            probe.bind(("127.0.0.1", desktop.PORT))

    def assert_port_released(self):
        deadline = time.monotonic() + 10
        while True:
            try:
                self.probe_port()
                return
            except OSError as error:
                if error.winerror not in (errno.WSAEADDRINUSE, errno.WSAEACCES):
                    raise
                if time.monotonic() >= deadline:
                    self.fail(f"Packaged app left port {desktop.PORT} unavailable: {error}")
            time.sleep(0.1)

    def close_window(self, pid):
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.FindWindowW.argtypes = (wintypes.LPCWSTR, wintypes.LPCWSTR)
        user32.FindWindowW.restype = wintypes.HWND
        user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
        user32.GetWindowThreadProcessId.restype = wintypes.DWORD
        user32.IsWindowVisible.argtypes = (wintypes.HWND,)
        user32.IsWindowVisible.restype = wintypes.BOOL
        user32.PostMessageW.argtypes = (wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
        user32.PostMessageW.restype = wintypes.BOOL
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            window = user32.FindWindowW(None, desktop.TITLE)
            if window and user32.IsWindowVisible(window):
                owner = wintypes.DWORD()
                user32.GetWindowThreadProcessId(window, ctypes.byref(owner))
                if owner.value == pid:
                    if not user32.PostMessageW(window, 0x0010, 0, 0):  # WM_CLOSE
                        raise ctypes.WinError(ctypes.get_last_error())
                    return
            time.sleep(0.1)
        self.fail(f"No visible catalog window for PID {pid}")

    def open_catalog(self, session):
        query = urlencode({"token": session["token"], "desktop": 1})
        status, _, response = get(desktop.PORT, f"/?{query}")
        prefix = f"/s/{session['instance']}/"
        self.assertEqual((status, response["Location"]), (303, prefix + "?desktop=1"))
        headers = {"Cookie": response["Set-Cookie"].split(";", 1)[0], "X-Catalog-Local": "1",
                   "Origin": f"http://127.0.0.1:{desktop.PORT}"}
        self.assertEqual(get(desktop.PORT, response["Location"], headers)[0], 200)
        status, body, _ = get(desktop.PORT, prefix + "api/experiments", headers)
        self.assertEqual(status, 200)
        return json.loads(body)["experiments"], prefix, headers

    def test_migrates_legacy_catalog_and_releases_session_on_window_close(self):
        import _winapi

        file_id = "b" * 32
        create_schema_zero_catalog(self.data_dir, file_id=file_id)
        with self.launched() as (process, pid):
            session = self.wait_for_session(process, pid)
            records, prefix, headers = self.open_catalog(session)
            record, = records
            self.assertEqual((record["id"], record["sample_id"], record["notes"], record["revision"]),
                             ("old", "XY-III-352-01", "Original", 4))
            attachment, = record["files"]
            self.assertEqual((attachment["id"], attachment["name"]), (file_id, "raw.txt"))
            self.assertEqual(get(desktop.PORT, f"{prefix}api/files/{file_id}", headers)[:2], (200, b"raw"))
            snapshot, = (self.data_dir / "migration-backups").glob("experiments-schema0-*.sqlite3")
            with closing(sqlite3.connect(snapshot)) as db:
                self.assertEqual(db.execute("PRAGMA user_version").fetchone(), (0,))
                self.assertEqual(db.execute("SELECT id, sample_id, notes FROM experiments").fetchall(),
                                 [("old", "XY-III-352-01", "Original")])
                self.assertEqual(db.execute("SELECT id, experiment_id, name FROM files").fetchall(),
                                 [(file_id, "old", "raw.txt")])
                self.assertNotIn("project_id", {column[1] for column in db.execute("PRAGMA table_info(experiments)")})
            with closing(sqlite3.connect(self.data_dir / "experiments.sqlite3")) as db:
                self.assertEqual(db.execute("PRAGMA user_version").fetchone(), (SCHEMA_VERSION,))
            self.close_window(pid)
            self.assertEqual(_winapi.WaitForSingleObject(process, 15000), _winapi.WAIT_OBJECT_0,
                             "packaged exe did not exit after WM_CLOSE")
            self.assertEqual(_winapi.GetExitCodeProcess(process), 0)
            self.assertFalse((self.data_dir / SESSION_FILE).exists())
            self.assert_port_released()

    def test_recovers_stale_session_after_forced_exit(self):
        with self.launched() as (process, pid):
            original = self.wait_for_session(process, pid)
            self.assertEqual(self.open_catalog(original)[0], [])
            with self.assertRaises(DataDirInUse):
                DataDirLock(self.data_dir).release()
        stale_path = self.data_dir / SESSION_FILE
        self.assertEqual(json.loads(stale_path.read_text(encoding="utf-8")), original)
        self.assert_port_released()
        with self.launched() as (process, pid):
            restarted = self.wait_for_session(process, pid)
            self.assertNotEqual(restarted["instance"], original["instance"])
            self.assertNotEqual(restarted["token"], original["token"])
            self.assertEqual(self.open_catalog(restarted)[0], [])
        self.assert_port_released()


if __name__ == "__main__":
    unittest.main()
