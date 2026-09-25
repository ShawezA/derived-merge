"""Format detection, loading and dumping for derived files.

The merge engine in `merge3.py` works on plain dicts/lists/scalars and knows
nothing about file formats. This module is the only place that does.

Detection is by CONTENT, not by filename. A merge driver is handed temporary
files whose names carry no extension, and dispatching on the path git happens
to pass would be fragile in exactly the situation where being wrong is
expensive.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import yarnlock  # noqa: E402

JSON = "json"
YARN = "yarn"


class UnsupportedFormat(ValueError):
    pass


def detect(text: str) -> str:
    stripped = text.lstrip()
    if not stripped:
        return JSON  # an absent side; an empty document merges with anything
    if stripped[0] in "{[":
        return JSON
    if "yarn lockfile v1" in text or "__metadata:" in text:
        return YARN
    raise UnsupportedFormat("not JSON and not a recognised yarn.lock")


def load(path):
    """Read a merge stage. Returns (document, context, format).

    `context` carries whatever the serializer needs to reproduce the file
    faithfully -- the yarn banner and dialect, or the JSON indent. A missing or
    empty file is a legitimate stage meaning "absent on this side".
    """
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except FileNotFoundError:
        return {}, None, None
    if not text.strip():
        return {}, None, None

    fmt = detect(text)
    if fmt == JSON:
        return json.loads(text), {"indent": _detect_indent(text)}, JSON

    header, doc, dialect = yarnlock.parse(text)
    return doc, {"header": header, "dialect": dialect}, YARN


def dump(path, doc, context, fmt):
    if fmt == YARN:
        text = yarnlock.serialize(context["header"], doc, context["dialect"])
    else:
        indent = (context or {}).get("indent", 2)
        text = json.dumps(doc, indent=indent, ensure_ascii=False)
        if _had_trailing_newline(path):
            text += "\n"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def _detect_indent(text, default=2):
    for line in text.split("\n"):
        stripped = line.lstrip(" ")
        if stripped != line and stripped.strip():
            return len(line) - len(stripped)
    return default


def _had_trailing_newline(path):
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            if fh.tell() == 0:
                return True
            fh.seek(-1, os.SEEK_END)
            return fh.read(1) == b"\n"
    except OSError:
        return True
