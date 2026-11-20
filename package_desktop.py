"""Build the Windows x64 desktop trial ZIP using a clean PyInstaller workspace."""
import platform
import sys
import tempfile
import zipfile
from importlib.metadata import distribution
from pathlib import Path

from package_app import FILES, PACKAGE_NAME, ROOT


APP_NAME = "Experiment Data Catalog"
RELEASE_NAME = f"{PACKAGE_NAME}-Desktop-v0.1"


def package_desktop():
    from PyInstaller.__main__ import run

    if sys.platform != "win32" or platform.machine().upper() != "AMD64" or sys.maxsize < 2**32:
        raise SystemExit("Build the desktop release with 64-bit Python on Windows x64.")
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    destination = dist / (RELEASE_NAME + "-Windows-x64.zip")
    temporary = destination.with_suffix(".tmp")
    with tempfile.TemporaryDirectory(prefix="experiment-catalog-build-") as folder:
        scratch = Path(folder)
        options = ["--name", APP_NAME, "--onedir", "--windowed", "--noupx",
                   "--distpath", str(scratch / "dist"), "--workpath", str(scratch / "work"),
                   "--specpath", str(scratch)]
        for name in FILES:
            options.extend(["--add-data", f"{ROOT / name}:{Path(name).parent}"])
        run([*options, str(ROOT / "desktop.py")])
        built = scratch / "dist" / APP_NAME
        assert (built / f"{APP_NAME}.exe").is_file()
        assert all((built / "_internal" / name).is_file() for name in FILES)
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(ROOT / "README.md", f"{RELEASE_NAME}/README.md")
            archive.write(Path(sys.base_prefix) / "LICENSE.txt", f"{RELEASE_NAME}/licenses/Python.txt")
            for name in ("pywebview", "pythonnet", "clr_loader", "cffi", "bottle", "typing_extensions", "pycparser", "PyInstaller"):
                package = distribution(name)
                for member in package.files:
                    if member.parent.name == "licenses":
                        archive.write(package.locate_file(member), f"{RELEASE_NAME}/licenses/{name}/{member.name}")
            for file in sorted(built.rglob("*")):
                if file.is_file():
                    relative = file.relative_to(built)
                    assert not {"data", "research", ".test-tools"}.intersection(relative.parts)
                    assert file.suffix not in (".sqlite3", ".log", ".db")
                    archive.write(file, f"{RELEASE_NAME}/{relative.as_posix()}")
        with zipfile.ZipFile(temporary) as archive:
            assert archive.testzip() is None
    temporary.replace(destination)
    return destination


if __name__ == "__main__":
    print(package_desktop())
