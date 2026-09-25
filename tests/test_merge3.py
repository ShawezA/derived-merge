"""Tests for the structural three-way merge.

Run: python3 tests/test_merge3.py
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from merge3 import merge, ABSENT  # noqa: E402

PASS = FAIL = 0
FAILURES = []


def check(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
    else:
        FAIL += 1
        FAILURES.append(f"{name}\n    got:  {got!r}\n    want: {want!r}")


def paths(conflicts):
    return sorted(c.pretty_path() for c in conflicts)


# --- The core claim: identity-keyed regions merge by union -------------------

def test_disjoint_additions_union():
    """Two branches each lock a different new package. This is THE case."""
    base = {"packages": {"react": {"version": "18.0.0"}}}
    ours = {"packages": {"react": {"version": "18.0.0"}, "lodash": {"version": "4.17.21"}}}
    theirs = {"packages": {"react": {"version": "18.0.0"}, "axios": {"version": "1.6.0"}}}
    got, conflicts = merge(base, ours, theirs)
    check("disjoint additions: no conflict", paths(conflicts), [])
    check(
        "disjoint additions: both kept",
        sorted(got["packages"].keys()),
        ["axios", "lodash", "react"],
    )


def test_same_addition_both_sides():
    """Both branches ran install and locked the same package identically.

    Textually this is a conflict. Structurally it is not a disagreement at all,
    and this is the single most common spurious lockfile conflict.
    """
    base = {"packages": {}}
    same = {"packages": {"lodash": {"version": "4.17.21", "integrity": "sha512-AAA"}}}
    got, conflicts = merge(base, same, dict(same))
    check("identical addition: no conflict", paths(conflicts), [])
    check("identical addition: value kept", got["packages"]["lodash"]["version"], "4.17.21")


def test_genuine_version_disagreement_conflicts():
    """Different versions for the same key IS a real disagreement."""
    base = {"packages": {"lodash": {"version": "4.17.20"}}}
    ours = {"packages": {"lodash": {"version": "4.17.21"}}}
    theirs = {"packages": {"lodash": {"version": "4.18.0"}}}
    got, conflicts = merge(base, ours, theirs)
    check("version disagreement: conflicts", paths(conflicts), ["packages.lodash.version"])
    check("version disagreement: keeps ours", got["packages"]["lodash"]["version"], "4.17.21")


def test_one_sided_change_taken():
    base = {"a": 1, "b": 2}
    ours = {"a": 1, "b": 99}
    theirs = {"a": 1, "b": 2}
    got, conflicts = merge(base, ours, theirs)
    check("one-sided change: no conflict", paths(conflicts), [])
    check("one-sided change: taken", got["b"], 99)


def test_deletion_beats_untouched():
    base = {"packages": {"old": {"version": "1.0.0"}, "keep": {"version": "2.0.0"}}}
    ours = {"packages": {"keep": {"version": "2.0.0"}}}
    theirs = dict(base)
    got, conflicts = merge(base, ours, theirs)
    check("deletion vs untouched: no conflict", paths(conflicts), [])
    check("deletion vs untouched: removed", sorted(got["packages"].keys()), ["keep"])


def test_deletion_vs_modification_conflicts():
    base = {"packages": {"x": {"version": "1.0.0"}}}
    ours = {"packages": {}}
    theirs = {"packages": {"x": {"version": "2.0.0"}}}
    got, conflicts = merge(base, ours, theirs)
    check("delete vs modify: conflicts", paths(conflicts), ["packages.x"])


def test_nested_independent_edits():
    """Different fields of the same entry, edited by different branches."""
    base = {"pkg": {"version": "1.0.0", "integrity": "sha512-OLD", "dev": False}}
    ours = {"pkg": {"version": "1.0.0", "integrity": "sha512-OLD", "dev": True}}
    theirs = {"pkg": {"version": "1.0.1", "integrity": "sha512-OLD", "dev": False}}
    got, conflicts = merge(base, ours, theirs)
    check("nested independent: no conflict", paths(conflicts), [])
    check("nested independent: ours applied", got["pkg"]["dev"], True)
    check("nested independent: theirs applied", got["pkg"]["version"], "1.0.1")


# --- Type-safety traps ------------------------------------------------------

def test_bool_is_not_one():
    """Python has 1 == True. In a lockfile those are different values."""
    base = {"flag": 0}
    ours = {"flag": False}
    theirs = {"flag": 1}
    got, conflicts = merge(base, ours, theirs)
    check("bool/int not conflated", paths(conflicts), ["flag"])


def test_null_is_a_value_not_absence():
    base = {"a": 1}
    ours = {"a": None}
    theirs = {"a": 1}
    got, conflicts = merge(base, ours, theirs)
    check("null is a value: no conflict", paths(conflicts), [])
    check("null is a value: applied", got["a"], None)
    check("null is a value: key present", "a" in got, True)


def test_type_change_conflicts():
    base = {"x": "1.0"}
    ours = {"x": ["1.0"]}
    theirs = {"x": {"version": "1.0"}}
    got, conflicts = merge(base, ours, theirs)
    check("type change: conflicts", paths(conflicts), ["x"])


# --- Lists ------------------------------------------------------------------

def test_list_disjoint_additions():
    base = {"deps": ["a"]}
    ours = {"deps": ["a", "b"]}
    theirs = {"deps": ["a", "c"]}
    got, conflicts = merge(base, ours, theirs)
    check("list additions: no conflict", paths(conflicts), [])
    check("list additions: unioned", sorted(got["deps"]), ["a", "b", "c"])


def test_list_deletion_respected():
    base = {"deps": ["a", "b", "c"]}
    ours = {"deps": ["a", "c"]}
    theirs = {"deps": ["a", "b", "c", "d"]}
    got, conflicts = merge(base, ours, theirs)
    check("list deletion: no conflict", paths(conflicts), [])
    check("list deletion: b removed, d added", sorted(got["deps"]), ["a", "c", "d"])


def test_list_of_objects_edited_on_both_sides():
    """KNOWN HARD CASE: both sides edit different fields of the same element.

    Elements are identified by content, so two different edits to one object
    look like two unrelated objects. The honest outcome is either a merge of
    the element or a conflict -- NOT silently keeping both copies.
    """
    base = {"deps": [{"name": "x", "version": "1.0", "dev": False}]}
    ours = {"deps": [{"name": "x", "version": "1.0", "dev": True}]}
    theirs = {"deps": [{"name": "x", "version": "1.1", "dev": False}]}
    got, conflicts = merge(base, ours, theirs)
    check("list-of-objects: exactly one element survives", len(got["deps"]), 1)


def test_no_duplicate_elements():
    base = {"deps": []}
    ours = {"deps": ["a", "b"]}
    theirs = {"deps": ["b", "a"]}
    got, conflicts = merge(base, ours, theirs)
    check("no duplicates on reorder", sorted(got["deps"]), ["a", "b"])


# --- Structural guarantees --------------------------------------------------

def test_output_always_complete_on_conflict():
    """Even when conflicted, the result must be a usable document."""
    base = {"a": 1, "b": {"c": 2}}
    ours = {"a": 10, "b": {"c": 20}}
    theirs = {"a": 11, "b": {"c": 21}}
    got, conflicts = merge(base, ours, theirs)
    check("conflicted output still complete", sorted(got.keys()), ["a", "b"])
    check("conflicted output keeps ours", got["a"], 10)
    check("both conflicts reported", paths(conflicts), ["a", "b.c"])


def test_key_order_preserved():
    base = {"z": 1, "a": 1}
    ours = {"z": 1, "a": 1, "m": 1}
    theirs = {"z": 1, "a": 1, "b": 1}
    got, _ = merge(base, ours, theirs)
    check("ours' order preserved, theirs appended", list(got.keys()), ["z", "a", "m", "b"])


def main():
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print(f"\n{PASS} passed, {FAIL} failed")
    for f in FAILURES:
        print(f"\nFAIL: {f}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
