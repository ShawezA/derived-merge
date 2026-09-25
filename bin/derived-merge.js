#!/usr/bin/env node
"use strict";

/**
 * derived-merge -- a git merge driver for lockfiles.
 *
 *   npx derived-merge init     register the driver in this repository
 *   npx derived-merge merge %O %A %B %L %P     (git calls this; you don't)
 *
 * Exit code 0 from `merge` means merged cleanly; non-zero means conflicts
 * remain, which is the contract git expects. On ANY failure it exits non-zero
 * without writing %A, so git's ordinary conflict markers survive and the user
 * gets the behaviour they would have had anyway.
 */

const path = require("path");
const { merge } = require("../lib/merge3");
const formats = require("../lib/formats");
const { init } = require("../lib/init");

const MAX_REPORTED = 20;

function main(argv) {
  const command = argv[2];

  if (command === "init") return init({ quiet: argv.includes("--quiet") });
  if (command === "merge") return doMerge(argv.slice(3));
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(`derived-merge: unknown command ${JSON.stringify(command)}\n`);
  process.stdout.write(USAGE);
  return 2;
}

const USAGE = `
derived-merge -- structural git merge for lockfiles

  npx derived-merge init     Register the merge driver in this repository and
                             add the lockfile patterns to .gitattributes.

Two branches each adding a dependency produces a textual conflict in a
lockfile, because git merges lines and a lockfile is a map. This merges by
key instead: both additions are kept, and a genuine disagreement about the
same package still conflicts, with a path instead of a line number.

Handles package-lock.json, yarn.lock (v1 and berry), deno.lock, and any other
identity-keyed JSON.
`;

function doMerge(args) {
  if (args.length < 3) {
    process.stderr.write("derived-merge: expected %O %A %B\n");
    return 2;
  }
  const [basePath, oursPath, theirsPath] = args;
  const label = args[4] || path.basename(oursPath);

  const stages = {};
  for (const [name, p] of [["base", basePath], ["ours", oursPath], ["theirs", theirsPath]]) {
    try {
      stages[name] = formats.load(p);
    } catch (err) {
      // Unparseable, unknown format, or unreadable. Never guess -- leave %A
      // alone and let git's textual conflict stand.
      process.stderr.write(
        `derived-merge: ${label}: deferring to git (${name}: ${err.message})\n`
      );
      return 1;
    }
  }

  const present = new Set(
    [stages.base.format, stages.ours.format, stages.theirs.format].filter(Boolean)
  );
  // Two PRESENT stages in different formats means something is badly wrong --
  // a lockfile that changed dialect mid-merge, say -- and rewriting it under
  // one side's serializer would corrupt the other's.
  if (present.size > 1) {
    process.stderr.write(
      `derived-merge: ${label}: sides disagree on format [${[...present].sort()}], deferring to git\n`
    );
    return 1;
  }
  if (stages.ours.format === null) {
    process.stderr.write(`derived-merge: ${label}: our side is absent, deferring to git\n`);
    return 1;
  }

  const { value, conflicts } = merge(stages.base.doc, stages.ours.doc, stages.theirs.doc);

  if (conflicts.length) {
    process.stderr.write(`derived-merge: ${label}: ${conflicts.length} unresolved:\n`);
    for (const c of conflicts.slice(0, MAX_REPORTED)) {
      process.stderr.write(`  ${c.prettyPath()}: ${c.reason}\n`);
      process.stderr.write(`      ours:   ${brief(c.ours)}\n`);
      process.stderr.write(`      theirs: ${brief(c.theirs)}\n`);
    }
    if (conflicts.length > MAX_REPORTED) {
      process.stderr.write(`  ... and ${conflicts.length - MAX_REPORTED} more\n`);
    }
    return 1;
  }

  try {
    formats.dump(oursPath, value, stages.ours.context, stages.ours.format);
  } catch (err) {
    process.stderr.write(
      `derived-merge: ${label}: could not write result (${err.message}), deferring to git\n`
    );
    return 1;
  }

  process.stderr.write(`derived-merge: ${label}: merged cleanly\n`);
  return 0;
}

function brief(value, limit = 80) {
  if (typeof value === "symbol") return "<absent>";
  let rendered;
  try {
    rendered = JSON.stringify(value);
  } catch (_) {
    rendered = String(value);
  }
  if (rendered === undefined) rendered = String(value);
  return rendered.length <= limit ? rendered : rendered.slice(0, limit - 3) + "...";
}

if (require.main === module) process.exit(main(process.argv));

module.exports = { main };
