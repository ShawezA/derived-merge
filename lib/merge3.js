"use strict";

/**
 * Structural three-way merge for identity-keyed derived files.
 *
 * The idea, stated by the Deno team when they shipped this for deno.lock in
 * June 2026: most of a lockfile is an identity-keyed map with deterministic
 * values -- `name@version` -> integrity hash, url -> hash. A given key always
 * maps to the same value regardless of which branch wrote it, so a textual
 * conflict in those regions is spurious and the correct merge is a union.
 * Only the regions where two branches can genuinely disagree need a conflict.
 *
 * Nothing here knows what a lockfile is. Ecosystem specifics live in
 * formats.js; this file is the decision procedure.
 */

/**
 * Sentinel for "this key is not present in this version of the tree".
 * `null` and `undefined` are both legitimate JSON-adjacent values, so neither
 * can do this job.
 */
const ABSENT = Symbol("absent");

class Conflict {
  constructor(path, base, ours, theirs, reason) {
    this.path = path;
    this.base = base;
    this.ours = ours;
    this.theirs = theirs;
    this.reason = reason;
  }

  /** A JSON path, which is what makes this usable -- `packages.lodash.version`
   *  rather than a line number in a file nobody reads. */
  prettyPath() {
    if (this.path.length === 0) return "<root>";
    let out = "";
    for (const part of this.path) {
      if (typeof part === "number") out += `[${part}]`;
      else out += out ? `.${part}` : String(part);
    }
    return out;
  }
}

/**
 * Three-way merge. Returns { value, conflicts }.
 *
 * On conflict the returned value keeps OUR side, so the caller always has a
 * complete, serializable document. That matters: a half-merged lockfile that
 * no longer parses is worse than either input, because the user's next step is
 * whatever error path their package manager has.
 */
function merge(base, ours, theirs) {
  const conflicts = [];
  const value = mergeNode(base, ours, theirs, [], conflicts);
  return { value, conflicts };
}

function mergeNode(base, ours, theirs, path, conflicts) {
  // Both sides agree. Nothing to decide, whatever the base said. This is the
  // case that makes identity-keyed maps free: two branches that independently
  // locked the same package at the same version wrote the same bytes.
  if (deepEqual(ours, theirs)) return ours;

  // Only one side moved. Take the side that moved, including when the move
  // was a deletion.
  if (deepEqual(base, ours)) return theirs;
  if (deepEqual(base, theirs)) return ours;

  // Both moved, differently. Recurse if the shape allows it.
  if (isPlainObject(ours) && isPlainObject(theirs)) {
    return mergeObject(base, ours, theirs, path, conflicts);
  }
  if (Array.isArray(ours) && Array.isArray(theirs)) {
    return mergeArray(base, ours, theirs, path, conflicts);
  }

  conflicts.push(new Conflict(path, base, ours, theirs, describe(base, ours, theirs)));
  return ours;
}

function mergeObject(base, ours, theirs, path, conflicts) {
  const baseObj = isPlainObject(base) ? base : {};
  const out = {};

  // Preserve insertion order: ours first, then keys theirs added. Lockfiles
  // are written sorted by their generator, so this keeps the diff minimal.
  //
  // Caveat worth knowing: JS reorders integer-like keys ("0", "12") ahead of
  // string keys in plain objects. Lockfile keys are package names and paths,
  // so this does not bite in practice -- but it is why this must never be
  // used for a format whose keys are numeric.
  const keys = Object.keys(ours).concat(
    Object.keys(theirs).filter((k) => !Object.prototype.hasOwnProperty.call(ours, k))
  );

  for (const key of keys) {
    const b = has(baseObj, key) ? baseObj[key] : ABSENT;
    const o = has(ours, key) ? ours[key] : ABSENT;
    const t = has(theirs, key) ? theirs[key] : ABSENT;

    const merged = mergeNode(b, o, t, path.concat(key), conflicts);
    if (merged !== ABSENT) out[key] = merged;
  }
  return out;
}

/**
 * Fields that, when present, name the entity a list element describes.
 * Keying a list by one of these rather than by full content is what lets two
 * branches edit different fields of the same dependency without the result
 * containing two copies of it.
 */
const IDENTITY_FIELDS = ["name", "id", "key", "path", "package", "url", "specifier"];

function mergeArray(base, ours, theirs, path, conflicts) {
  const baseArr = Array.isArray(base) ? base : [];

  const b = indexBy(baseArr);
  const o = indexBy(ours);
  const t = indexBy(theirs);

  const order = Array.from(o.keys()).concat(
    Array.from(t.keys()).filter((k) => !o.has(k))
  );

  const out = [];
  for (const k of order) {
    const inB = b.has(k);
    // Added by either side, or in base and dropped by neither. A drop by one
    // side beats a non-change by the other, matching the scalar rules.
    const survives = !inB || (o.has(k) && t.has(k));
    if (!survives) continue;

    const merged = mergeNode(
      inB ? b.get(k) : ABSENT,
      o.has(k) ? o.get(k) : ABSENT,
      t.has(k) ? t.get(k) : ABSENT,
      path.concat(out.length),
      conflicts
    );
    if (merged !== ABSENT) out.push(merged);
  }
  return out;
}

function indexBy(items) {
  const map = new Map();
  for (const item of items) {
    const k = identity(item);
    if (!map.has(k)) map.set(k, item);
  }
  return map;
}

function identity(value) {
  if (isPlainObject(value)) {
    for (const field of IDENTITY_FIELDS) {
      const v = value[field];
      if (has(value, field) && (typeof v === "string" || typeof v === "number")) {
        return `id:${field}:${canonical(v)}`;
      }
    }
  }
  return canonical(value);
}

/**
 * A stable, TYPE-STRICT rendering used for both equality and list identity.
 *
 * The type tag is not decoration. Without it `0`, `false` and `"0"` collapse
 * to one key, so a branch that changed a flag would look like a branch that
 * changed a count -- or like one that changed nothing at all.
 */
function canonical(value) {
  if (value === ABSENT) return "\u0000absent";
  if (value === null) return "null:";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  }
  return typeof value + ":" + String(value);
}

function deepEqual(a, b) {
  if (a === ABSENT || b === ABSENT) return a === b;
  return canonical(a) === canonical(b);
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function describe(base, ours, theirs) {
  if (base === ABSENT) return "both sides added this key with different values";
  if (ours === ABSENT) return "we deleted this key, they modified it";
  if (theirs === ABSENT) return "they deleted this key, we modified it";
  if (typeofTag(ours) !== typeofTag(theirs)) return "both sides changed this to a different type";
  return "both sides changed this to a different value";
}

function typeofTag(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

module.exports = { merge, Conflict, ABSENT, canonical, deepEqual };
