"use strict";

/**
 * Register the merge driver in the current git repository.
 *
 * This exists because of a specific defect in git: a merge driver's definition
 * lives in .git/config and is never distributed with the repository.
 * .gitattributes can only REQUEST a driver by name, not supply it. Worse, when
 * a repo ships `package-lock.json merge=derived` and the driver is not
 * registered, git's find_ll_merge_driver() falls back to a plain textual merge
 * with no warning and no error -- the policy silently does not run.
 *
 * Shipping on npm is what fixes that. As a devDependency with a postinstall
 * hook, every teammate who runs `npm install` -- which they already do -- gets
 * the driver registered automatically. The distribution problem goes away
 * because the package manager is the distribution channel.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DRIVER_NAME = "derived";
const PATTERNS = ["package-lock.json", "yarn.lock", "deno.lock", "npm-shrinkwrap.json"];

function git(args, opts = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    ...opts,
  }).trim();
}

function repoRoot() {
  try {
    return git(["rev-parse", "--show-toplevel"]);
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {boolean} opts.quiet   Suppress success output (used by postinstall).
 * @param {boolean} opts.soft    Never throw; return 0 regardless. Postinstall
 *                               must not fail someone's `npm install` because
 *                               they happen to be building from a tarball
 *                               outside a git repo.
 */
function init(opts = {}) {
  const { quiet = false, soft = false } = opts;
  const log = (msg) => {
    if (!quiet) process.stdout.write(msg + "\n");
  };

  const root = repoRoot();
  if (!root) {
    if (soft) return 0;
    process.stderr.write("derived-merge: not inside a git repository\n");
    return 1;
  }

  // A worktree or submodule has its own config; registering in whichever repo
  // we are actually in is correct, so no special-casing is needed here.
  const driverPath = path.join(__dirname, "..", "bin", "derived-merge.js");
  if (!fs.existsSync(driverPath)) {
    if (soft) return 0;
    process.stderr.write(`derived-merge: driver not found at ${driverPath}\n`);
    return 1;
  }

  const command = `${quote(process.execPath)} ${quote(driverPath)} merge %O %A %B %L %P`;

  try {
    git(["config", `merge.${DRIVER_NAME}.name`, "structural merge for lockfiles"]);
    git(["config", `merge.${DRIVER_NAME}.driver`, command]);
    // By default git reuses the driver itself to build a hypothetical ancestor
    // during a criss-cross merge. Set this explicitly so behaviour does not
    // depend on a default that could change.
    git(["config", `merge.${DRIVER_NAME}.recursive`, "text"]);
  } catch (err) {
    if (soft) return 0;
    process.stderr.write(`derived-merge: could not write git config: ${err.message}\n`);
    return 1;
  }

  const added = ensureAttributes(path.join(root, ".gitattributes"));

  log(`derived-merge: registered in ${root}`);
  if (added.length) {
    log(`  added to .gitattributes: ${added.join(", ")}`);
    log("  commit .gitattributes so the repository asks for this merge policy.");
  }
  if (!quiet) {
    log("  verify with: git check-attr merge -- package-lock.json");
  }
  return 0;
}

function ensureAttributes(attrPath) {
  let existing = "";
  try {
    existing = fs.readFileSync(attrPath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const present = new Set();
  for (const line of existing.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    present.add(trimmed.split(/\s+/)[0]);
  }

  const missing = PATTERNS.filter((p) => !present.has(p));
  if (!missing.length) return [];

  let out = existing;
  if (out && !out.endsWith("\n")) out += "\n";
  for (const p of missing) out += `${p} merge=${DRIVER_NAME}\n`;
  fs.writeFileSync(attrPath, out, "utf8");
  return missing;
}

function quote(s) {
  // git runs the driver through a shell, so a path containing spaces must be
  // quoted. Single quotes are safest; a path containing one is pathological
  // but still handled.
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = { init, PATTERNS, DRIVER_NAME };
