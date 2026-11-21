"""Build the Windows x64 desktop trial ZIP using a clean PyInstaller workspace."""
import os
import sys


def build_in_isolated_process():
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith("PYTHON")}
    env["PYTHONNOUSERSITE"] = "1"  # PyInstaller's helper interpreters do not inherit -I.
    if sys.flags.isolated and env == os.environ:
        return False
    if sys.platform != "win32":
        raise SystemExit("Build the desktop release with 64-bit Python on Windows x64.")

    # Load the launcher from the base standard library even when PYTHONPATH is set.
    original_path = sys.path[:]
    try:
        sys.path[:] = [os.path.join(sys.base_prefix, folder) for folder in ("Lib", "DLLs")]
        import subprocess

        status = subprocess.run([sys.executable, "-I", os.path.abspath(__file__)], env=env).returncode
    finally:
        sys.path[:] = original_path
    if status:
        raise SystemExit(status)
    return True


if __name__ == "__main__":
    if build_in_isolated_process():
        raise SystemExit(0)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import platform
import tempfile
import zipfile
from importlib.metadata import PackageNotFoundError, distribution
from pathlib import Path, PurePosixPath

from package_app import FILES, PACKAGE_NAME, ROOT


APP_NAME = "Experiment Data Catalog"
APP_VERSION = "0.4.0"
RELEASE_NAME = f"{PACKAGE_NAME}-Desktop-v{APP_VERSION}"
RELEASE_ZIP = ROOT / "dist" / f"{RELEASE_NAME}-Windows-x64.zip"

# Runtime wheels verified against the frozen inventory. PyInstaller supplies
# the bootloader and runtime hooks, and proxy_tools has a checked-in notice.
WHEEL_NOTICES = {
    "bottle": ("LICENSE",),
    "cffi": ("LICENSE",),
    "clr_loader": ("LICENSE",),
    "pycparser": ("LICENSE",),
    "pyinstaller": ("COPYING.txt",),
    "pythonnet": ("LICENSE", "AUTHORS.md"),
    "pywebview": ("LICENSE",),
    "typing_extensions": ("LICENSE",),
}
EXCLUDED_MODULES = ("setuptools", "_distutils_hack", "pkg_resources", "more_itertools", "bz2", "lzma",
                    "webview.platforms.android", "webview.platforms.cef", "webview.platforms.cocoa",
                    "webview.platforms.gtk", "webview.platforms.qt")
EXCLUDED_FILES = {
    "clr_loader/ffi/dlls/x86/ClrLoader.dll",
    "webview/js/lib/polyfill.js",
    "webview/lib/pywebview-android.jar",
    "webview/lib/WebBrowserInterop.x86.dll",
}
RUNTIME_FILES = {
    "base_library.zip", "python312.dll",
    "libcrypto-3.dll", "libssl-3.dll", "libffi-8.dll", "sqlite3.dll",
    "VCRUNTIME140.dll", "VCRUNTIME140_1.dll",
    "_cffi_backend.cp312-win_amd64.pyd", "clr_loader/ffi/dlls/amd64/ClrLoader.dll",
    "pythonnet/runtime/Python.Runtime.deps.json", "pythonnet/runtime/Python.Runtime.dll",
    "pythonnet/runtime/Python.Runtime.xml",
    "webview/js/api.js", "webview/js/customize.js", "webview/js/finish.js", "webview/js/state.js",
    "webview/js/lib/dom_json.js", "webview/lib/WebBrowserInterop.x64.dll",
    "webview/lib/Microsoft.Web.WebView2.Core.dll", "webview/lib/Microsoft.Web.WebView2.WinForms.dll",
    # pywebview resolves all three SDK loader directories at startup.
    "webview/lib/runtimes/win-arm64/native/WebView2Loader.dll",
    "webview/lib/runtimes/win-x64/native/WebView2Loader.dll",
    "webview/lib/runtimes/win-x86/native/WebView2Loader.dll",
}
LOCAL_NOTICES = {
    "licenses/Python.txt": Path(sys.base_prefix) / "LICENSE.txt",
    "licenses/new-api/LICENSE": ROOT / "LICENSE",
    "licenses/new-api/THIRD_PARTY_NOTICES.txt": ROOT / "THIRD_PARTY_NOTICES.txt",
    "licenses/proxy_tools/LICENSE-upstream.txt": ROOT / "LICENSE-proxy-tools.txt",
    **{name: ROOT / name for name in FILES if name.startswith("licenses/")},
}
NOTICE_ENTRIES = set(LOCAL_NOTICES) | {
    f"licenses/{name}/{filename}" for name, filenames in WHEEL_NOTICES.items() for filename in filenames
}


def collect_notices():
    import sqlite3
    import ssl
    import unicodedata
    import zlib
    from _decimal import __libmpdec_version__
    from xml.parsers.expat import EXPAT_VERSION

    sources = dict(LOCAL_NOTICES)
    missing = []
    versions = {
        "OpenSSL": ssl.OPENSSL_VERSION.split()[1],
        "SQLite": sqlite3.sqlite_version,
        "Unicode": unicodedata.unidata_version,
        "zlib": zlib.ZLIB_RUNTIME_VERSION,
        "mpdecimal": __libmpdec_version__,
        "Expat": EXPAT_VERSION.removeprefix("expat_"),
        **{f"{name}-CPython": platform.python_version() for name in ("BLAKE2", "dtoa", "HACL")},
    }
    for component, version in versions.items():
        suffix = ".md" if component == "SQLite" else ".txt"
        name = f"licenses/{component}-{version}{suffix}"
        if name not in sources:
            missing.append(f"{name} (add the matching notice to package_app.FILES)")
    for component, filenames in WHEEL_NOTICES.items():
        try:
            package = distribution(component)
        except PackageNotFoundError:
            missing.append(f"{component} (build wheel metadata missing)")
            continue
        if component == "cffi":
            name = f"licenses/cffi-{package.version}-win-libffi.txt"
            if name not in sources:
                missing.append(f"{name} (add the matching notice to package_app.FILES)")
        members = {member.name: member for member in package.files or ()
                   if len(member.parts) >= 2 and member.parts[0].endswith(".dist-info")
                   and (len(member.parts) == 2 or member.parts[1] == "licenses")}
        for filename in filenames:
            if filename in members:
                sources[f"licenses/{component}/{filename}"] = package.locate_file(members[filename])
            else:
                missing.append(f"{component} {package.version}/{filename}")
    missing.extend(f"{name} ({path})" for name, path in sources.items()
                   if not path.is_file() or not path.stat().st_size)
    if missing:
        raise SystemExit("Missing required desktop redistribution notices:\n  " + "\n  ".join(sorted(missing)))
    return sources


def validate_origins(entries):
    roots = [Path(root).resolve() for root in (ROOT, sys.prefix, sys.base_prefix)]
    unexpected = []
    for name, source, kind in entries:
        if source in (None, "-") and kind.startswith("PYMODULE"):
            continue  # Namespace packages have no source file.
        origin = Path(source).resolve() if source not in (None, "", "-") else None
        if origin is None or not any(origin.is_relative_to(root) for root in roots):
            unexpected.append(f"{name}: {origin or source}")
    if unexpected:
        raise SystemExit("Bundled code outside the checkout, build venv, or base Python:\n  "
                         + "\n  ".join(sorted(set(unexpected))))


def validate_bundle(exe, internal_files):
    from PyInstaller.archive.readers import CArchiveReader

    archive = CArchiveReader(str(exe))
    modules = archive.open_embedded_archive("PYZ.pyz").toc
    runtime_modules = (set(WHEEL_NOTICES) - {"pyinstaller", "pywebview"}) | {
        "clr", "package_app", "proxy_tools", "server", "webview",
    }
    unknown_modules = {module.partition(".")[0] for module in modules}
    unknown_modules -= sys.stdlib_module_names | runtime_modules
    unknown_modules.update(module for module in modules
                           if any(module == name or module.startswith(name + ".") for name in EXCLUDED_MODULES))
    unknown_files = internal_files - set(FILES) - RUNTIME_FILES
    unknown_files -= {name for name in unknown_files
                      if "/" not in name and name.endswith(".pyd")
                      and PurePosixPath(name).stem in sys.stdlib_module_names}
    if unknown_modules or unknown_files:
        raise SystemExit("Bundled components without audited redistribution notices:\n  "
                         + "\n  ".join(sorted(unknown_modules | unknown_files)))


def package_desktop():
    if build_in_isolated_process():
        return RELEASE_ZIP
    from PyInstaller.__main__ import run

    if sys.platform != "win32" or platform.machine().upper() != "AMD64" or sys.maxsize < 2**32:
        raise SystemExit("Build the desktop release with 64-bit Python on Windows x64.")
    notices = collect_notices()
    RELEASE_ZIP.parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="experiment-catalog-build-") as folder, \
            tempfile.TemporaryDirectory(prefix=".desktop-release-", dir=RELEASE_ZIP.parent) as staging:
        scratch = Path(folder)
        spec = scratch / f"{APP_NAME}.spec"
        datas = [(str(ROOT / name), str(Path(name).parent)) for name in FILES]
        spec.write_text(f"""\
from package_desktop import validate_origins
from PyInstaller.depend.analysis import get_bootstrap_modules

a = Analysis({[str(ROOT / "desktop.py")]!r}, datas={datas!r}, excludes={list(EXCLUDED_MODULES)!r})
# The graph also contains pure modules collected outside PYZ, including base_library.zip.
validate_origins(a.graph.make_pure_toc() + a.scripts + a.binaries + get_bootstrap_modules())
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, exclude_binaries=True, name={APP_NAME!r}, console=False, upx=False)
validate_origins(exe.exefiles)
coll = COLLECT(exe, a.binaries, a.datas, name={APP_NAME!r}, upx=False)
""", encoding="utf-8")
        run([str(spec), "--distpath", str(scratch / "dist"), "--workpath", str(scratch / "work")],
            pyi_config={"cachedir": str(scratch / "cache"), "upx_available": False})
        built = scratch / "dist" / APP_NAME
        exe = built / f"{APP_NAME}.exe"
        internal = built / "_internal"
        files = {file.relative_to(internal).as_posix(): file for file in internal.rglob("*") if file.is_file()}
        for name in EXCLUDED_FILES:
            files.pop(name, None)
        assert exe.is_file()
        assert set(FILES) <= files.keys()
        validate_bundle(exe, set(files))
        temporary = Path(staging) / RELEASE_ZIP.name
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(ROOT / "README.md", f"{RELEASE_NAME}/README.md")
            archive.write(exe, f"{RELEASE_NAME}/{exe.name}")
            for name, path in sorted(notices.items()):
                archive.write(path, f"{RELEASE_NAME}/{name}")
            for name, file in sorted(files.items()):
                assert not {"data", "research", ".test-tools"}.intersection(PurePosixPath(name).parts)
                assert file.suffix not in (".sqlite3", ".log", ".db")
                archive.write(file, f"{RELEASE_NAME}/_internal/{name}")
        with zipfile.ZipFile(temporary) as archive:
            assert archive.testzip() is None
        temporary.replace(RELEASE_ZIP)
    return RELEASE_ZIP


if __name__ == "__main__":
    print(package_desktop())
