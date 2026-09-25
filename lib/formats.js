"use strict";

/**
 * Format detection, loading and dumping.
 *
 * The merge engine works on plain objects and knows nothing about file
 * formats. This is the only module that does.
 *
 * Detection is by CONTENT, not by filename. A merge driver is handed
 * temporary files whose names carry no extension, so dispatching on the path
 * git happens to pass would be fragile in exactly the situation where being
 * wrong is expensive.
 */

const fs = require("fs");
const yarnlock = require("./yarnlock");

const JSON_FMT = "json";
const YARN_FMT = "yarn";

class UnsupportedFormat extends Error {}

function detect(text) {
  const stripped = text.replace(/^\s+/, "");
  if (stripped === "") return JSON_FMT; // an absent side merges with anything
  if (stripped[0] === "{" || stripped[0] === "[") return JSON_FMT;
  if (text.includes("yarn lockfile v1") || text.includes("__metadata:")) return YARN_FMT;
  throw new UnsupportedFormat("not JSON and not a recognised yarn.lock");
}

/**
 * Read a merge stage. Returns { doc, context, format }.
 *
 * `context` carries whatever the serializer needs to reproduce the file
 * faithfully -- the yarn banner and dialect, or the JSON indent and trailing
 * newline. A missing or empty file is a legitimate stage meaning "absent on
 * this side", and reports format null so it merges with anything.
 */
function load(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { doc: {}, context: null, format: null };
    throw err;
  }
  if (text.trim() === "") return { doc: {}, context: null, format: null };

  const format = detect(text);
  if (format === JSON_FMT) {
    return {
      doc: JSON.parse(text),
      context: { indent: detectIndent(text), trailingNewline: text.endsWith("\n") },
      format,
    };
  }
  const { header, doc, dialect } = yarnlock.parse(text);
  return { doc, context: { header, dialect }, format };
}

function dump(filePath, doc, context, format) {
  let text;
  if (format === YARN_FMT) {
    text = yarnlock.serialize(context.header, doc, context.dialect);
  } else {
    const indent = (context && context.indent) || 2;
    text = JSON.stringify(doc, null, indent);
    if (!context || context.trailingNewline) text += "\n";
  }
  fs.writeFileSync(filePath, text, "utf8");
}

function detectIndent(text, fallback = 2) {
  for (const line of text.split("\n")) {
    const stripped = line.replace(/^ +/, "");
    if (stripped !== line && stripped.trim() !== "") return line.length - stripped.length;
  }
  return fallback;
}

module.exports = { load, dump, detect, JSON_FMT, YARN_FMT, UnsupportedFormat };
