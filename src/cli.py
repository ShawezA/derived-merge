"""Git merge driver for identity-keyed derived files.

Install (per repo, but see the note below about distribution):

    git config merge.derived.name "structural merge for derived files"
    git config merge.derived.driver "python3 /path/to/cli.py %O %A %B %L %P"

and in .gitattributes:

    package-lock.json   merge=derived
    deno.lock           merge=derived
    *.json              merge=derived

NOTE ON DISTRIBUTION -- this is the part git gets wrong. A driver definition
lives in .git/config, never in .gitattributes, so it is NOT distributed with
the repository. A contributor who has not run the setup step gets a plain
textual merge, and git's own `find_ll_merge_driver()` falls back to it with no
warning and no error. That silent fallback is why every package manager that
solved this did it inside its own parser instead of as a merge driver. Until
this ships as something self-installing, `install.sh` is the mitigation.

Exit code 0 means merged cleanly; non-zero means conflicts remain, which is
the contract git expects from a merge driver.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from merge3 import merge  # noqa: E402


def _load(path):
    """Read a JSON file, returning (value, error).

    A missing or empty stage is a legitimate three-way input -- it means the
    file did not exist on that side -- and parses as an empty document.
    """
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except FileNotFoundError:
        return {}, None
    if not text.strip():
        return {}, None
    try:
        return json.loads(text), None
    except json.JSONDecodeError as exc:
        return None, f"{path}: {exc}"


def _detect_indent(path, default=2):
    """Match the file's existing indentation so the diff stays minimal."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                stripped = line.lstrip(" ")
                if stripped != line and stripped.strip():
                    return len(line) - len(stripped)
    except OSError:
        pass
    return default


def _trailing_newline(path):
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            if fh.tell() == 0:
                return True
            fh.seek(-1, os.SEEK_END)
            return fh.read(1) == b"\n"
    except OSError:
        return True


def main(argv):
    if len(argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2

    base_path, ours_path, theirs_path = argv[1], argv[2], argv[3]
    label = argv[5] if len(argv) > 5 else ours_path

    base, err_b = _load(base_path)
    ours, err_o = _load(ours_path)
    theirs, err_t = _load(theirs_path)

    # If any side is not valid JSON we must not guess. Returning non-zero
    # without touching %A leaves git's own conflicted content in place, which
    # is the safe outcome: the user gets the normal conflict they expected.
    for err in (err_b, err_o, err_t):
        if err:
            print(f"derived-merge: not valid JSON, deferring to git: {err}",
                  file=sys.stderr)
            return 1

    merged, conflicts = merge(base, ours, theirs)

    if conflicts:
        print(f"derived-merge: {label}: {len(conflicts)} unresolved:",
              file=sys.stderr)
        for c in conflicts[:20]:
            print(f"  {c.pretty_path()}: {c.reason}", file=sys.stderr)
            print(f"      ours:   {_brief(c.ours)}", file=sys.stderr)
            print(f"      theirs: {_brief(c.theirs)}", file=sys.stderr)
        if len(conflicts) > 20:
            print(f"  ... and {len(conflicts) - 20} more", file=sys.stderr)
        return 1

    indent = _detect_indent(ours_path)
    text = json.dumps(merged, indent=indent, ensure_ascii=False)
    if _trailing_newline(ours_path):
        text += "\n"
    with open(ours_path, "w", encoding="utf-8") as fh:
        fh.write(text)

    print(f"derived-merge: {label}: merged cleanly", file=sys.stderr)
    return 0


def _brief(value, limit=80):
    if value is None:
        return "null"
    rendered = json.dumps(value, ensure_ascii=False, default=str)
    return rendered if len(rendered) <= limit else rendered[: limit - 3] + "..."


if __name__ == "__main__":
    sys.exit(main(sys.argv))
