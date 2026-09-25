#!/usr/bin/env node
"use strict";

/**
 * Test suite. Run: npm test
 *
 * These mirror the cases that found two real bugs during development, so the
 * ports must keep failing for the same reasons if the fixes are removed.
 */

const assert = require("assert");
const fs = require("fs");
const { merge } = require("../lib/merge3");
const yarnlock = require("../lib/yarnlock");

let pass = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    failures.push(`${name}\n    ${err.message.split("\n").join("\n    ")}`);
  }
}

const paths = (conflicts) => conflicts.map((c) => c.prettyPath()).sort();

/* --- The core claim: identity-keyed regions merge by union --------------- */

test("disjoint additions union without conflict", () => {
  const base = { packages: { react: { version: "18.0.0" } } };
  const ours = { packages: { react: { version: "18.0.0" }, lodash: { version: "4.17.21" } } };
  const theirs = { packages: { react: { version: "18.0.0" }, axios: { version: "1.6.0" } } };
  const { value, conflicts } = merge(base, ours, theirs);
  assert.deepStrictEqual(paths(conflicts), []);
  assert.deepStrictEqual(Object.keys(value.packages).sort(), ["axios", "lodash", "react"]);
});

test("identical addition on both sides is not a disagreement", () => {
  const base = { packages: {} };
  const same = { packages: { lodash: { version: "4.17.21", integrity: "sha512-AAA" } } };
  const { value, conflicts } = merge(base, same, JSON.parse(JSON.stringify(same)));
  assert.deepStrictEqual(paths(conflicts), []);
  assert.strictEqual(value.packages.lodash.version, "4.17.21");
});

test("genuine version disagreement conflicts and keeps ours", () => {
  const base = { packages: { lodash: { version: "4.17.20" } } };
  const ours = { packages: { lodash: { version: "4.17.21" } } };
  const theirs = { packages: { lodash: { version: "4.18.0" } } };
  const { value, conflicts } = merge(base, ours, theirs);
  assert.deepStrictEqual(paths(conflicts), ["packages.lodash.version"]);
  assert.strictEqual(value.packages.lodash.version, "4.17.21");
});

test("one-sided change is taken", () => {
  const { value, conflicts } = merge({ a: 1, b: 2 }, { a: 1, b: 99 }, { a: 1, b: 2 });
  assert.deepStrictEqual(paths(conflicts), []);
  assert.strictEqual(value.b, 99);
});

test("deletion beats an untouched side", () => {
  const base = { p: { old: { v: "1" }, keep: { v: "2" } } };
  const ours = { p: { keep: { v: "2" } } };
  const { value, conflicts } = merge(base, ours, JSON.parse(JSON.stringify(base)));
  assert.deepStrictEqual(paths(conflicts), []);
  assert.deepStrictEqual(Object.keys(value.p), ["keep"]);
});

test("delete versus modify conflicts", () => {
  const base = { p: { x: { version: "1.0.0" } } };
  const { conflicts } = merge(base, { p: {} }, { p: { x: { version: "2.0.0" } } });
  assert.deepStrictEqual(paths(conflicts), ["p.x"]);
});

test("independent edits to different fields of one entry both apply", () => {
  const base = { pkg: { version: "1.0.0", integrity: "OLD", dev: false } };
  const ours = { pkg: { version: "1.0.0", integrity: "OLD", dev: true } };
  const theirs = { pkg: { version: "1.0.1", integrity: "OLD", dev: false } };
  const { value, conflicts } = merge(base, ours, theirs);
  assert.deepStrictEqual(paths(conflicts), []);
  assert.strictEqual(value.pkg.dev, true);
  assert.strictEqual(value.pkg.version, "1.0.1");
});

/* --- Type-safety traps: the first real bug ------------------------------- */

test("false, 0 and '0' are not conflated", () => {
  // The Python original delegated equality to ==, under which
  // {"flag": 0} == {"flag": False}. A guard on the outer value was bypassed
  // one level down, so a branch that changed a flag looked unchanged.
  assert.deepStrictEqual(paths(merge({ flag: 0 }, { flag: false }, { flag: 1 }).conflicts), ["flag"]);
  assert.deepStrictEqual(paths(merge({ f: "0" }, { f: 0 }, { f: false }).conflicts), ["f"]);
});

test("null is a value, not an absence", () => {
  const { value, conflicts } = merge({ a: 1 }, { a: null }, { a: 1 });
  assert.deepStrictEqual(paths(conflicts), []);
  assert.strictEqual(value.a, null);
  assert.ok("a" in value);
});

test("type change conflicts", () => {
  const { conflicts } = merge({ x: "1.0" }, { x: ["1.0"] }, { x: { version: "1.0" } });
  assert.deepStrictEqual(paths(conflicts), ["x"]);
});

/* --- Lists: the second real bug ------------------------------------------ */

test("list additions union", () => {
  const { value, conflicts } = merge({ d: ["a"] }, { d: ["a", "b"] }, { d: ["a", "c"] });
  assert.deepStrictEqual(paths(conflicts), []);
  assert.deepStrictEqual(value.d.slice().sort(), ["a", "b", "c"]);
});

test("list deletion respected alongside an addition", () => {
  const { value, conflicts } = merge(
    { d: ["a", "b", "c"] }, { d: ["a", "c"] }, { d: ["a", "b", "c", "d"] }
  );
  assert.deepStrictEqual(paths(conflicts), []);
  assert.deepStrictEqual(value.d.slice().sort(), ["a", "c", "d"]);
});

test("objects in a list are keyed by identity, not content", () => {
  // Keyed by content, two edits to different fields of one entry produced two
  // copies of it. Exactly one element must survive.
  const base = { d: [{ name: "x", version: "1.0", dev: false }] };
  const ours = { d: [{ name: "x", version: "1.0", dev: true }] };
  const theirs = { d: [{ name: "x", version: "1.1", dev: false }] };
  const { value } = merge(base, ours, theirs);
  assert.strictEqual(value.d.length, 1);
  assert.strictEqual(value.d[0].dev, true);
  assert.strictEqual(value.d[0].version, "1.1");
});

test("reordering a list does not duplicate elements", () => {
  const { value } = merge({ d: [] }, { d: ["a", "b"] }, { d: ["b", "a"] });
  assert.deepStrictEqual(value.d.slice().sort(), ["a", "b"]);
});

/* --- Structural guarantees ----------------------------------------------- */

test("a conflicted merge still returns a complete document", () => {
  const { value, conflicts } = merge(
    { a: 1, b: { c: 2 } }, { a: 10, b: { c: 20 } }, { a: 11, b: { c: 21 } }
  );
  assert.deepStrictEqual(Object.keys(value).sort(), ["a", "b"]);
  assert.strictEqual(value.a, 10);
  assert.deepStrictEqual(paths(conflicts), ["a", "b.c"]);
});

test("key order is ours, then keys theirs added", () => {
  const { value } = merge({ z: 1, a: 1 }, { z: 1, a: 1, m: 1 }, { z: 1, a: 1, b: 1 });
  assert.deepStrictEqual(Object.keys(value), ["z", "a", "m", "b"]);
});

/* --- yarn.lock ----------------------------------------------------------- */

const V1 = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"@babel/code-frame@^7.0.0":
  version "7.12.11"
  resolved "https://registry.yarnpkg.com/@babel/code-frame/-/code-frame-7.12.11.tgz#abc"
  integrity sha512-AAA==
  dependencies:
    "@babel/highlight" "^7.10.4"

lodash@^4.17.21:
  version "4.17.21"
  integrity sha512-BBB==
`;

const BERRY = `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 8
  cacheKey: 10

"@adobe/css-tools@npm:4.3.2":
  version: 4.3.2
  resolution: "@adobe/css-tools@npm:4.3.2"
  checksum: 10/973dcb
  linkType: hard

"lodash@npm:^4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"
  dependencies:
    "other@npm": "npm:^1.0.0"
  linkType: hard
`;

test("yarn v1 round-trips byte-identically", () => {
  const { header, doc, dialect } = yarnlock.parse(V1);
  assert.strictEqual(dialect, yarnlock.V1);
  assert.strictEqual(yarnlock.serialize(header, doc, dialect), V1);
});

test("yarn berry round-trips byte-identically", () => {
  const { header, doc, dialect } = yarnlock.parse(BERRY);
  assert.strictEqual(dialect, yarnlock.BERRY);
  assert.strictEqual(yarnlock.serialize(header, doc, dialect), BERRY);
});

test("yarn v1 nested blocks and scalars parse", () => {
  const { doc } = yarnlock.parse(V1);
  const entry = doc['"@babel/code-frame@^7.0.0"'];
  assert.strictEqual(entry.version, '"7.12.11"');
  assert.deepStrictEqual(entry.dependencies, { '"@babel/highlight"': '"^7.10.4"' });
});

test("berry keys containing colons are not split", () => {
  const { doc } = yarnlock.parse(BERRY);
  const entry = doc['"lodash@npm:^4.17.21"'];
  assert.strictEqual(entry.resolution, '"lodash@npm:4.17.21"');
  assert.deepStrictEqual(entry.dependencies, { '"other@npm"': '"npm:^1.0.0"' });
  assert.deepStrictEqual(doc.__metadata, { version: "8", cacheKey: "10" });
});

test("an unidentifiable dialect is refused, not guessed", () => {
  assert.throws(() => yarnlock.parse("some: yaml\nbut: not a lockfile\n"), yarnlock.YarnLockError);
});

test("yarn disjoint additions merge and the result reparses", () => {
  const { header, doc: base, dialect } = yarnlock.parse(V1);
  const ours = Object.assign({}, base, { "axios@^1.6.0": { version: '"1.6.0"' } });
  const theirs = Object.assign({}, base, { "react@^18.0.0": { version: '"18.0.0"' } });
  const { value, conflicts } = merge(base, ours, theirs);
  assert.deepStrictEqual(paths(conflicts), []);
  assert.ok("axios@^1.6.0" in value && "react@^18.0.0" in value);
  const text = yarnlock.serialize(header, value, dialect);
  assert.deepStrictEqual(yarnlock.parse(text).doc, value);
});

test("yarn genuine version disagreement conflicts", () => {
  const { doc: base } = yarnlock.parse(V1);
  const clone = () => JSON.parse(JSON.stringify(base));
  const ours = clone();
  const theirs = clone();
  // Both must move AWAY from base, or there is no disagreement to detect.
  ours["lodash@^4.17.21"].version = '"4.17.22"';
  theirs["lodash@^4.17.21"].version = '"4.18.0"';
  assert.deepStrictEqual(paths(merge(base, ours, theirs).conflicts),
    ["lodash@^4.17.21.version"]);
});

test("real lockfiles round-trip byte-identically, when present", () => {
  // Synthetic fixtures do not exercise 40,000 lines of real formatting.
  for (const p of ["/tmp/yl_v1.lock", "/tmp/yl_berry.lock"]) {
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8");
    const { header, doc, dialect } = yarnlock.parse(text);
    assert.strictEqual(yarnlock.serialize(header, doc, dialect), text, `${p} round-trip`);
  }
});

process.stdout.write(`\n${pass} passed, ${failures.length} failed\n`);
for (const f of failures) process.stdout.write(`\nFAIL: ${f}\n`);
process.exit(failures.length ? 1 : 0);
