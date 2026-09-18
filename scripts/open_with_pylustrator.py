"""Open a Matplotlib figure script through Pylustrator."""

from __future__ import annotations

import argparse
import re
import runpy
from pathlib import Path


BOOTSTRAP = [
    "# DSH Pylustrator integration",
    "import pylustrator",
    "pylustrator.start()",
    "",
]


def read_text(path: Path) -> tuple[str, str]:
    """Read a Python source file while preserving common encodings."""
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return raw.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace"), "utf-8"


def detect_eol(text: str) -> str:
    """Return the dominant line ending used by the file."""
    return "\r\n" if "\r\n" in text else "\n"


def insertion_index(lines: list[str]) -> int:
    """Find a safe insertion line after shebang, encoding, and future imports."""
    index = 0
    if lines and lines[0].startswith("#!"):
        index = 1
    if index < len(lines) and re.search(r"coding[:=]\s*[-\w.]+", lines[index]):
        index += 1
    while index < len(lines) and (
        not lines[index].strip()
        or lines[index].startswith("from __future__ import ")
    ):
        index += 1
    return index


def ensure_bootstrap(path: Path) -> None:
    """Insert the Pylustrator bootstrap block once."""
    text, encoding = read_text(path)
    if "pylustrator.start(" in text:
        return
    eol = detect_eol(text)
    lines = text.splitlines()
    index = insertion_index(lines)
    next_lines = lines[:index] + BOOTSTRAP + lines[index:]
    path.write_text(eol.join(next_lines) + eol, encoding=encoding)


def main() -> None:
    """Prepare and execute the requested figure script."""
    parser = argparse.ArgumentParser()
    parser.add_argument("script", type=Path)
    args = parser.parse_args()
    script = args.script.resolve()
    if script.suffix.lower() != ".py" or not script.is_file():
        raise SystemExit(f"Not a Python file: {script}")
    ensure_bootstrap(script)
    runpy.run_path(str(script), run_name="__main__")


if __name__ == "__main__":
    main()
