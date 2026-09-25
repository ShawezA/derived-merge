"""Structural three-way merge for identity-keyed derived files.

The idea, stated by the Deno team when they shipped this for deno.lock in
June 2026: most of a lockfile is an identity-keyed map with deterministic
values -- `name@version` -> integrity hash, url -> hash. A given key always
maps to the same value regardless of which branch wrote it, so a textual
conflict in those regions is *spurious* and the correct merge is a union.
Only the regions where two branches can genuinely disagree need a conflict.

This module implements that partition generically over JSON-shaped data:
recurse structurally, resolve everything that is provably unambiguous, and
report a precise path for anything that is not.

Nothing here knows what a lockfile is. Ecosystem specifics live in
`formats.py`; this file is the decision procedure.
"""

from __future__ import annotations

# Sentinel for "this key is not present in this version of the tree".
# None is a legitimate JSON value, so it cannot do this job.
class _Absent:
    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<absent>"


ABSENT = _Absent()


class Conflict:
    """One region the merge could not decide.

    `path` is the JSON path to the disagreement, which is what makes this
    usable: a caller can report `packages.lodash.resolved` rather than a
    line number in a file nobody reads.
    """

    __slots__ = ("path", "base", "ours", "theirs", "reason")

    def __init__(self, path, base, ours, theirs, reason):
        self.path = path
        self.base = base
        self.ours = ours
        self.theirs = theirs
        self.reason = reason

    def __repr__(self) -> str:
        return f"Conflict({self.pretty_path()!r}, {self.reason})"

    def pretty_path(self) -> str:
        if not self.path:
            return "<root>"
        out = []
        for part in self.path:
            if isinstance(part, int):
                out.append(f"[{part}]")
            else:
                out.append(f".{part}" if out else str(part))
        return "".join(out)


def merge(base, ours, theirs, *, ordered_lists=True):
    """Three-way merge. Returns (value, [Conflict, ...]).

    On conflict the returned value keeps OUR side, so the caller always has a
    complete, parseable document to write out. That matters: a half-merged
    lockfile that no longer parses is worse than either input, because every
    downstream tool's error path is what the user hits next.
    """
    conflicts: list[Conflict] = []
    value = _merge(base, ours, theirs, (), conflicts, ordered_lists)
    return value, conflicts


def _merge(base, ours, theirs, path, conflicts, ordered_lists):
    # Both sides agree. Nothing to decide, whatever the base said.
    # This is the case that makes identity-keyed maps free: two branches that
    # independently locked the same package at the same version wrote the
    # same bytes, so there is nothing to merge.
    if _eq(ours, theirs):
        return ours

    # Only one side moved. Take the side that moved -- including when the
    # move was a deletion.
    if _eq(base, ours):
        return theirs
    if _eq(base, theirs):
        return ours

    # Both sides moved, differently. Recurse if the shape allows it.
    if isinstance(ours, dict) and isinstance(theirs, dict):
        return _merge_dict(base, ours, theirs, path, conflicts, ordered_lists)

    if isinstance(ours, list) and isinstance(theirs, list) and ordered_lists:
        return _merge_list(base, ours, theirs, path, conflicts, ordered_lists)

    # A scalar, or a type change. Genuinely undecidable.
    conflicts.append(
        Conflict(path, base, ours, theirs, _describe(base, ours, theirs))
    )
    return ours


def _merge_dict(base, ours, theirs, path, conflicts, ordered_lists):
    base_d = base if isinstance(base, dict) else {}
    out = {}

    # Preserve insertion order: ours first, then keys theirs added. Lockfiles
    # are usually sorted by their generator, so this keeps the diff small and
    # keeps a regenerated file byte-comparable to a merged one.
    for key in list(ours.keys()) + [k for k in theirs if k not in ours]:
        b = base_d.get(key, ABSENT)
        o = ours.get(key, ABSENT)
        t = theirs.get(key, ABSENT)

        merged = _merge(b, o, t, path + (key,), conflicts, ordered_lists)
        if merged is not ABSENT:
            out[key] = merged
    return out


def _merge_list(base, ours, theirs, path, conflicts, ordered_lists):
    """Merge two edited lists against their base, keyed by element identity.

    Lists in derived files are nearly always a set rendered in sorted order.
    We line the three versions up by `_identity` -- a natural id field when the
    elements are objects, otherwise the whole content -- and then apply the
    same three-way rules used for dict keys. Keying by identity rather than by
    content is what stops "ours edited field A, theirs edited field B" from
    producing two copies of the same entry.
    """
    base_l = base if isinstance(base, list) else []

    b = _index(base_l)
    o = _index(ours)
    t = _index(theirs)

    # An element survives if it was added by either side, or was in base and
    # neither side dropped it. A drop by one side beats a non-change by the
    # other, matching the scalar rules above.
    keep = [k for k in _ordered_keys(o, t) if _survives(k, b, o, t)]

    out = []
    for k in keep:
        merged = _merge(
            b.get(k, ABSENT),
            o.get(k, ABSENT),
            t.get(k, ABSENT),
            path + (k[-1] if isinstance(k, tuple) and k[0] == "id" else len(out),),
            conflicts,
            ordered_lists,
        )
        if merged is not ABSENT:
            out.append(merged)
    return out


def _index(items):
    """Map element identity -> element, keeping the first of any duplicates."""
    out = {}
    for item in items:
        out.setdefault(_identity(item), item)
    return out


def _ordered_keys(o, t):
    """Ours' order, then keys only theirs has -- mirroring dict key order."""
    return list(o.keys()) + [k for k in t if k not in o]


def _survives(k, b, o, t):
    in_b, in_o, in_t = k in b, k in o, k in t
    if not in_b:
        return True  # added by at least one side
    return in_o and in_t  # in base: survives only if neither side dropped it


# Fields that, when present, name the *entity* a list element describes.
# Keying a list by one of these instead of by full content is what lets two
# branches edit different fields of the same dependency without the result
# containing two copies of it.
IDENTITY_FIELDS = ("name", "id", "key", "path", "package", "url", "specifier")


def _identity(value):
    """The identity of a list element, used to line up the three versions."""
    if isinstance(value, dict):
        for field in IDENTITY_FIELDS:
            if field in value and isinstance(value[field], (str, int, float)):
                return ("id", field, _canonical(value[field]))
    return _canonical(value)


def _canonical(value):
    """A hashable, TYPE-STRICT rendering.

    The type tag is not decoration. Without it `0`, `False` and `0.0` collapse
    to one key, because Python hashes them identically -- so a list holding a
    flag would silently merge with one holding a count.
    """
    if isinstance(value, bool):
        return ("bool", value)
    if isinstance(value, dict):
        return ("{}", tuple(sorted((k, _canonical(v)) for k, v in value.items())))
    if isinstance(value, list):
        return ("[]", tuple(_canonical(v) for v in value))
    return (type(value).__name__, value)


def _eq(a, b):
    """Deep, type-strict equality.

    This cannot delegate to `==`. Python's `==` on containers recurses with its
    own rules, under which `{"flag": 0} == {"flag": False}` is True -- so a
    guard applied only to the outer values is silently bypassed one level down,
    and a branch that changed a flag looks like a branch that changed nothing.
    """
    if a is ABSENT or b is ABSENT:
        return a is b
    return _canonical(a) == _canonical(b)


def _describe(base, ours, theirs):
    if base is ABSENT:
        return "both sides added this key with different values"
    if ours is ABSENT:
        return "we deleted this key, they modified it"
    if theirs is ABSENT:
        return "they deleted this key, we modified it"
    if type(ours) is not type(theirs):
        return "both sides changed this to a different type"
    return "both sides changed this to a different value"
