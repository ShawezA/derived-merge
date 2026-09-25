#!/usr/bin/env node
"use strict";

// Runs on `npm install`. This is the mechanism that solves git's
// "merge drivers are not distributed" defect: a teammate installing the repo's
// dependencies gets the driver registered without knowing it exists.
//
// It must NEVER fail an install. Someone may be installing from a tarball, in
// a container without git, or as a transitive dependency of a package they did
// not choose -- none of which is a reason to break their build.
try {
  const { init } = require("../lib/init");
  process.exit(init({ quiet: true, soft: true }));
} catch (_) {
  process.exit(0);
}
