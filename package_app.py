"""Build a clean distribution using an explicit allowlist; no experimental data."""
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent
PACKAGE_NAME = "Experiment-Data-Catalog"
FILES = ("server.py", "web/index.html", "web/app.js", "web/style.css", "web/i18n.js", "web/newapi-theme.css", "start.ps1", "stop.ps1",
         "web/locked.html", "web/locked.css", "启动 实验数据目录.cmd", "停止 实验数据目录.cmd", "README.md", "LICENSE",
         "test_server.py", "test_app.cjs", "test_ui.cjs", "test_catalog.json", "package_app.py", ".gitignore", "LICENSE-MIT", "THIRD_PARTY_NOTICES.txt",
         "desktop.py", "package_desktop.py", "requirements-desktop.txt")


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
