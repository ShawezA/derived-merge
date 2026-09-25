"use strict";

/**
 * Parser and serializer for yarn.lock, both dialects.
 *
 *   yarn v1 ("classic")        yarn v2+ ("berry")
 *   ------------------------   ---------------------------
 *   "pkg@^1.0.0":              "pkg@npm:^1.0.0":
 *     version "1.0.0"            version: 1.0.0
 *     resolved "https://..."     resolution: "pkg@npm:1.0.0"
 *     dependencies:              dependencies:
 *       other "^2.0.0"             other: "npm:^2.0.0"
 *
 * Both are an indentation-structured map from a package specifier to its
 * resolution -- the identity-keyed shape the merge engine is built for. The
 * separator differs: v1 puts a space between a scalar key and its value,
 * berry puts a colon. Berry keys contain colons of their own, so naive
 * splitting corrupts them.
 *
 * ROUND-TRIP FIDELITY IS THE HARD REQUIREMENT. If serializing an unchanged
 * document does not reproduce the original bytes, every merge produces a diff
 * touching the whole file, which is worse than the conflict it replaced.
 */

const V1 = "v1";
const BERRY = "berry";

class YarnLockError extends Error {}

/** Identify which yarn wrote this file, by markers yarn itself emits. */
function detectDialect(text) {
  if (text.includes("__metadata:")) return BERRY;
  if (text.includes("yarn lockfile v1")) return V1;
  // Guessing here is exactly the silent-corruption risk this module exists to
  // avoid: a wrong guess rewrites every separator in the file.
  throw new YarnLockError(
    "cannot identify yarn.lock dialect: no '__metadata:' or 'yarn lockfile v1' marker"
  );
}

/** Returns { header, doc, dialect }. `header` is the leading comment banner,
 *  preserved verbatim -- yarn writes a "manual changes might be lost" notice
 *  that must survive untouched. */
function parse(text) {
  const dialect = detectDialect(text);
  const lines = text.split("\n");

  const header = [];
  let i = 0;
  while (i < lines.length && (lines[i].trim() === "" || lines[i].trimStart().startsWith("#"))) {
    header.push(lines[i]);
    i++;
  }

  const { block } = parseBlock(lines, i, 0, dialect);
  return { header, doc: block, dialect };
}

function parseBlock(lines, start, indent, dialect) {
  const out = {};
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === "") {
      i++;
      continue;
    }
    const cur = raw.length - raw.replace(/^ +/, "").length;
    if (cur < indent) break;
    if (cur > indent) {
      // A deeper line with no parent header is malformed. Refusing beats
      // silently reparenting somebody's dependency.
      throw new YarnLockError(`unexpected indent at line ${i + 1}: ${JSON.stringify(raw)}`);
    }

    const stripped = raw.trim();
    if (stripped.endsWith(":") && !isScalar(stripped, dialect)) {
      const key = stripped.slice(0, -1);
      const res = parseBlock(lines, i + 1, indent + 2, dialect);
      out[key] = res.block;
      i = res.next;
    } else {
      const [key, value] = splitScalar(stripped, dialect, i);
      out[key] = value;
      i++;
    }
  }
  return { block: out, next: i };
}

/** Distinguish `dependencies:` (a block header) from `foo: bar` (a scalar). */
function isScalar(stripped, dialect) {
  if (dialect === V1) return false;
  return stripUotedPrefix(stripped).includes(": ");
}

function stripUotedPrefix(s) {
  if (!s.startsWith('"')) return s;
  const end = closingQuote(s, 0);
  return end === -1 ? s : s.slice(end + 1);
}

function splitScalar(stripped, dialect, lineno) {
  const sep = dialect === BERRY ? ": " : " ";
  const parts = partitionOutsideQuotes(stripped, sep);
  if (!parts) {
    throw new YarnLockError(
      `malformed ${dialect} entry at line ${lineno + 1}: ${JSON.stringify(stripped)}`
    );
  }
  return parts;
}

/** Split on the first `sep` that is not inside a quoted key. */
function partitionOutsideQuotes(s, sep) {
  if (s.startsWith('"')) {
    const end = closingQuote(s, 0);
    if (end !== -1) {
      const rest = s.slice(end + 1);
      if (rest.startsWith(sep)) return [s.slice(0, end + 1), rest.slice(sep.length)];
      return null;
    }
  }
  const idx = s.indexOf(sep);
  if (idx === -1) return null;
  return [s.slice(0, idx), s.slice(idx + sep.length)];
}

function closingQuote(s, start) {
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s[i] === '"') return i;
    i++;
  }
  return -1;
}

function serialize(header, doc, dialect) {
  const lines = header.slice();
  renderBlock(doc, 0, dialect, true, lines);
  return lines.join("\n");
}

function renderBlock(block, indent, dialect, top, lines) {
  const pad = " ".repeat(indent);
  let wrote = false;
  for (const key of Object.keys(block)) {
    const value = block[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if (top && wrote) lines.push("");
      lines.push(`${pad}${key}:`);
      renderBlock(value, indent + 2, dialect, false, lines);
    } else {
      const sep = dialect === BERRY ? ": " : " ";
      lines.push(`${pad}${key}${sep}${value}`);
    }
    wrote = true;
  }
  if (top) lines.push("");
}

module.exports = { parse, serialize, detectDialect, V1, BERRY, YarnLockError };
