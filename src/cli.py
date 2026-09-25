"""Git merge driver for identity-keyed derived files.

Install (per repo -- see the note below about why that is unavoidable):

    sh install.sh

or by hand:

    git config merge.derived.name "structural merge for derived files"
    git config merge.derived.driver "python3 /path/to/cli.py %O %A %B %L %P"

and in .gitattributes:

    package-lock.json   merge=derived
    yarn.lock           merge=derived
    deno.lock           merge=derived

NOTE ON DISTRIBUTION -- this is the part git gets wrong. A driver definition
lives in .git/config, never in .gitattributes, so it is NOT distributed with
the repository. A contributor who has not run the setup step gets a plain
textual merge, and git's own `find_ll_merge_driver()` falls back to it with no
warning and no error. That silent fallback is why every package manager that
solved this did it inside its own parser instead of as a merge driver.

Exit code 0 means merged cleanly; non-zero means conflicts remain, which is the
contract git expects from a merge driver. On any failure this exits non-zero
WITHOUT writing %A, so git's ordinary conflict markers survive and the user
gets the behaviour they would have had anyway.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import formats  # noqa: E402
from merge3 import merge  # noqa: E402

MAX_REPORTED = 20


def main(argv):
    if len(argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2

    base_path, ours_path, theirs_path = argv[1], argv[2], argv[3]
    label = argv[5] if len(argv) > 5 else ours_path

    stages = {}
    for name, path in (("base", base_path), ("ours", ours_path), ("theirs", theirs_path)):
        try:
            stages[name] = formats.load(path)
        except Exception as exc:
            # Unparseable, unknown format, or unreadable. Never guess -- leave
            # %A alone and let git's textual conflict stand.
            print(f"derived-merge: {label}: deferring to git ({name}: {exc})",
                  file=sys.stderr)
            return 1

    base_doc, _, base_fmt = stages["base"]
    ours_doc, ours_ctx, ours_fmt = stages["ours"]
    theirs_doc, _, theirs_fmt = stages["theirs"]

    # A stage that was absent carries fmt None and merges with anything. Two
    # PRESENT stages in different formats means something is badly wrong --
    # a lockfile that changed dialect mid-merge, say -- and rewriting it under
    # one side's serializer would corrupt the other's.
    present = {f for f in (base_fmt, ours_fmt, theirs_fmt) if f is not None}
    if len(present) > 1:
        print(f"derived-merge: {label}: sides disagree on format {sorted(present)}, "
              "deferring to git", file=sys.stderr)
        return 1
    if ours_fmt is None:
        print(f"derived-merge: {label}: our side is absent, deferring to git",
              file=sys.stderr)
        return 1

    merged, conflicts = merge(base_doc, ours_doc, theirs_doc)

    if conflicts:
        print(f"derived-merge: {label}: {len(conflicts)} unresolved:", file=sys.stderr)
        for c in conflicts[:MAX_REPORTED]:
            print(f"  {c.pretty_path()}: {c.reason}", file=sys.stderr)
            print(f"      ours:   {_brief(c.ours)}", file=sys.stderr)
            print(f"      theirs: {_brief(c.theirs)}", file=sys.stderr)
        if len(conflicts) > MAX_REPORTED:
            print(f"  ... and {len(conflicts) - MAX_REPORTED} more", file=sys.stderr)
        return 1

    try:
        formats.dump(ours_path, merged, ours_ctx, ours_fmt)
    except Exception as exc:
        print(f"derived-merge: {label}: could not write result ({exc}), "
              "deferring to git", file=sys.stderr)
        return 1

    print(f"derived-merge: {label}: merged cleanly", file=sys.stderr)
    return 0


def _brief(value, limit=80):
    from merge3 import ABSENT
    if value is ABSENT:
        return "<absent>"
    rendered = repr(value) if not isinstance(value, str) else f'"{value}"'
    return rendered if len(rendered) <= limit else rendered[: limit - 3] + "..."


if __name__ == "__main__":
    sys.exit(main(sys.argv))
