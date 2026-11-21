"""Build a clean distribution using an explicit allowlist; no experimental data."""
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent
PACKAGE_NAME = "Experiment-Data-Catalog"
FILES = ("server.py", "web/index.html", "web/app.js", "web/style.css", "web/i18n.js", "web/newapi-theme.css", "start.ps1", "stop.ps1",
         "web/locked.html", "web/locked.css", "启动 实验数据目录.cmd", "停止 实验数据目录.cmd", "README.md", "LICENSE",
         "test_server.py", "test_app.cjs", "test_ui.cjs", "test_catalog.json", "package_app.py", ".gitignore", "LICENSE-MIT", "THIRD_PARTY_NOTICES.txt",
         "desktop.py", "package_desktop.py", "requirements-desktop.txt", "test_desktop.py", "LICENSE-proxy-tools.txt",
         "licenses/BLAKE2-CPython-3.12.10.txt", "licenses/Expat-2.7.1.txt", "licenses/HACL-CPython-3.12.10.txt",
         "licenses/OpenSSL-3.0.16.txt", "licenses/SQLite-3.49.1.md", "licenses/SOURCES.txt", "licenses/Unicode-15.0.0.txt",
         "licenses/WebView2-1.0.3856.49-LICENSE.txt", "licenses/WebView2-1.0.3856.49-NOTICE.txt",
         "licenses/cffi-2.1.1-win-libffi.txt", "licenses/domJSON-0.1.2.md", "licenses/dtoa-CPython-3.12.10.txt",
         "licenses/mpdecimal-2.5.1.txt", "licenses/zlib-1.3.1.txt", "licenses/zlib-1.3.2.txt")


def package():
    destination = ROOT / "dist" / (PACKAGE_NAME + "-local.zip")
    destination.parent.mkdir(exist_ok=True)
    temporary = destination.with_suffix(".tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            archive.write(ROOT / name, PACKAGE_NAME + "/" + name)
    with zipfile.ZipFile(temporary) as archive:
        assert set(archive.namelist()) == {PACKAGE_NAME + "/" + name for name in FILES}
        assert not any("/data/" in name or "/research/" in name for name in archive.namelist())
        assert archive.testzip() is None
    temporary.replace(destination)
    return destination


if __name__ == "__main__":
    print(package())
