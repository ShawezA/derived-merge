"""Parser and serializer for yarn.lock, both dialects.

yarn.lock is the highest-value derived file not covered by a JSON parser, and
it comes in two incompatible shapes:

  yarn v1 ("classic")        yarn v2+ ("berry")
  ------------------------   ---------------------------
  "pkg@^1.0.0":              "pkg@npm:^1.0.0":
    version "1.0.0"            version: 1.0.0
    resolved "https://..."     resolution: "pkg@npm:1.0.0"
    dependencies:              dependencies:
      other "^2.0.0"             other: "npm:^2.0.0"

Both are an indentation-structured map from a package specifier to its
resolution -- exactly the identity-keyed shape the merge engine is built for.
The separator differs: v1 puts a space between a scalar key and its value,
berry puts a colon.

ROUND-TRIP FIDELITY IS THE HARD REQUIREMENT. If serializing an unchanged
document does not reproduce the original bytes, every merge produces a diff
touching the whole file, which is worse than the conflict it replaced. The
tests assert byte-identical round-trips on real 40,000-line lockfiles.
"""

from __future__ import annotations

V1 = "v1"
BERRY = "berry"


class YarnLockError(ValueError):
    pass


def detect_dialect(text: str) -> str:
    """Identify which yarn wrote this file.

    Checked against markers yarn itself emits rather than guessed from the
    body, because a wrong guess silently changes every separator on write.
    """
    if "__metadata:" in text:
        return BERRY
    if "yarn lockfile v1" in text:
        return V1
    # No marker. Berry always writes __metadata, so an unmarked file with
    # colon-separated scalars is still most likely berry-shaped; but guessing
    # here is exactly the silent-corruption risk this module exists to avoid.
    raise YarnLockError(
        "cannot identify yarn.lock dialect: no '__metadata:' or "
        "'yarn lockfile v1' marker"
    )


def parse(text: str):
    """Return (header_lines, document, dialect).

    `header_lines` are the leading comments, preserved verbatim -- yarn writes
    a "manual changes might be lost" banner that must survive untouched.
    """
    dialect = detect_dialect(text)
    lines = text.split("\n")

    header = []
    i = 0
    while i < len(lines) and (not lines[i].strip() or lines[i].lstrip().startswith("#")):
        header.append(lines[i])
        i += 1

    doc, consumed = _parse_block(lines, i, 0, dialect)
    return header, doc, dialect


def _parse_block(lines, start, indent, dialect):
    """Parse every entry at `indent`, returning (dict, next_line_index)."""
    out = {}
    i = start
    while i < len(lines):
        raw = lines[i]
        if not raw.strip():
            i += 1
            continue
        cur = len(raw) - len(raw.lstrip(" "))
        if cur < indent:
            break
        if cur > indent:
            # A deeper line with no parent header is malformed; refusing is
            # better than silently reparenting somebody's dependency.
            raise YarnLockError(f"unexpected indent at line {i + 1}: {raw!r}")

        stripped = raw.strip()
        if stripped.endswith(":") and not _is_scalar(stripped, dialect):
            key = stripped[:-1]
            child, i = _parse_block(lines, i + 1, indent + 2, dialect)
            out[key] = child
        else:
            key, value = _split_scalar(stripped, dialect, i)
            out[key] = value
            i += 1
    return out, i


def _is_scalar(stripped: str, dialect: str) -> bool:
    """Distinguish `dependencies:` (a block) from `foo: bar` (a scalar).

    A line ending in ':' is a block header only when nothing follows the
    colon. In berry a quoted key may itself contain a colon, so we check the
    unquoted tail rather than the raw string.
    """
    if dialect == V1:
        return False
    body = _strip_quoted_prefix(stripped)
    return ": " in body


def _split_scalar(stripped, dialect, lineno):
    if dialect == BERRY:
        key, sep, value = _partition_outside_quotes(stripped, ": ")
        if not sep:
            raise YarnLockError(f"malformed berry entry at line {lineno + 1}: {stripped!r}")
        return key, value
    key, sep, value = _partition_outside_quotes(stripped, " ")
    if not sep:
        raise YarnLockError(f"malformed v1 entry at line {lineno + 1}: {stripped!r}")
    return key, value


def _strip_quoted_prefix(s: str) -> str:
    """Return `s` with a leading quoted token removed, if there is one."""
    if not s.startswith('"'):
        return s
    end = _closing_quote(s, 0)
    return s[end + 1:] if end != -1 else s


def _partition_outside_quotes(s: str, sep: str):
    """Split on the first `sep` that is not inside a quoted key."""
    if s.startswith('"'):
        end = _closing_quote(s, 0)
        if end != -1:
            rest = s[end + 1:]
            if rest.startswith(sep):
                return s[: end + 1], sep, rest[len(sep):]
            return s, "", ""
    idx = s.find(sep)
    if idx == -1:
        return s, "", ""
    return s[:idx], sep, s[idx + len(sep):]


def _closing_quote(s: str, start: int) -> int:
    """Index of the quote closing the one at `start`, honouring backslashes."""
    i = start + 1
    while i < len(s):
        if s[i] == "\\":
            i += 2
            continue
        if s[i] == '"':
            return i
        i += 1
    return -1


def serialize(header, doc, dialect) -> str:
    out = list(header)
    body = _render_block(doc, 0, dialect, top=True)
    out.extend(body)
    return "\n".join(out)


def _render_block(block, indent, dialect, top=False):
    lines = []
    pad = " " * indent
    for key, value in block.items():
        if isinstance(value, dict):
            if top and lines:
                lines.append("")
            lines.append(f"{pad}{key}:")
            lines.extend(_render_block(value, indent + 2, dialect))
        else:
            sep = ": " if dialect == BERRY else " "
            lines.append(f"{pad}{key}{sep}{value}")
    if top:
        lines.append("")
    return lines
