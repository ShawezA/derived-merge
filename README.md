# derived-merge

A git merge driver for lockfiles and other identity-keyed generated files.

Two branches each add a dependency. Neither touched the other's. Git reports a
conflict anyway, because git merges lines and a lockfile is not lines — it is a
map. This resolves that class of conflict structurally, and refuses to guess
about anything else.

```
$ git merge feature-a
derived-merge: package-lock.json: merged cleanly
Merge made by the 'ort' strategy.
```

Without the driver, that exact merge is a conflict.

## The idea

Most of a lockfile is an **identity-keyed map with deterministic values** —
`name@version` → integrity hash, url → hash. A given key always maps to the
same value regardless of which branch wrote it, so a conflict in those regions
is *spurious* and the correct merge is a union. Only the regions where two
branches can genuinely disagree need a conflict.

That framing is the Deno team's, from the `deno.lock` merge support they
shipped in June 2026. It is better than the obvious alternative ("never merge a
generated file, regenerate it instead") because regeneration discards work:
re-running the package manager picks one side's resolution and silently drops
the other's. A structural merge keeps both.

So the rule is: **partition by provability.** Union what is provably
unambiguous, conflict on the rest, and never guess in between.

## What it decides, and what it refuses

Resolved automatically:

| Situation | Result |
|---|---|
| Both branches added different packages | Union |
| Both branches added the same package identically | Not a disagreement at all |
| One branch changed an entry, the other didn't | Take the change |
| One branch deleted an entry, the other didn't touch it | Deletion wins |
| Branches edited *different fields* of the same entry | Merge both edits |

Reported as conflicts, with a JSON path rather than a line number:

```
derived-merge: package-lock.json: 2 unresolved:
  packages.lodash.version: both sides changed this to a different value
      ours:   "4.17.21"
      theirs: "4.18.0"
```

Two branches that genuinely disagree about a version *are* a disagreement, and
this tool will not pick one. That is the whole safety argument: the research on
structured merge is consistent that reducing spurious conflicts buys you
undetected ones, and a silently-wrong lockfile is worse than a noisy one.

If any of the three inputs is not valid JSON, the driver exits non-zero without
writing anything, and you get git's ordinary conflict. It never half-writes.

## Install

```sh
git clone https://github.com/<you>/derived-merge
cd /path/to/your/repo
sh /path/to/derived-merge/install.sh
git add .gitattributes && git commit -m "use structural merge for lockfiles"
```

Requires `python3`. No other dependencies.

## The distribution problem, stated plainly

**Every contributor must run `install.sh` themselves.** A merge driver's
definition lives in `.git/config` and is never distributed with the repository
— `.gitattributes` can only *request* a driver by name, not supply it.

It is worse than it sounds. When a repo ships `package-lock.json merge=derived`
and the driver is not registered, git's `find_ll_merge_driver()` falls back to
a plain textual merge with **no warning and no error**. The repo asks for a
policy, the policy silently does not run, and nothing tells anyone.

This is not a limitation of this tool; it is why *every* package manager that
solved lockfile merging did it inside its own parser instead of as a merge
driver. npm has an undocumented semantic three-way merge in
`@npmcli/parse-conflict-json`. pnpm picks a side by recency and admits it
"cannot guarantee pnpm will choose the correct head". Cargo's issue asking for
this has been open since 2015. Perforce gets this right — `p4 typemap` puts
per-path policy on the *server*, so it reaches every client automatically.

Fixing it properly means shipping a self-installing binary rather than a
driver. That is the main open work.

## Limits

- **JSON only.** `yarn.lock` (v1) and `pnpm-lock.yaml` are not JSON and are not
  handled yet. `yarn.lock` is the single most valuable format not covered.
- **Lists are keyed by identity.** Elements that are objects are lined up by
  the first of `name`/`id`/`key`/`path`/`package`/`url`/`specifier` they
  carry; otherwise by full content. A list of objects with no such field, where
  both sides edit the same element, is keyed by content and will not merge as
  cleanly.
- **Order is not preserved across a merge of two reordered lists.** Output
  follows ours' order, then appends what theirs added.
- **No semantic validation.** A structurally clean merge can still produce a
  dependency set that does not install. This tool merges the file; it does not
  run your package manager.

## Tests

```sh
python3 tests/test_merge3.py
```

29 cases, covering the identity-keyed union claim, deletion semantics, the
`0`/`False`/`0.0` collapse (Python's `==` on containers treats
`{"flag": 0}` and `{"flag": False}` as equal, which silently loses a flag
change — the equality here is deep and type-strict for that reason), type
changes, and the guarantee that a conflicted merge still leaves a complete,
parseable document.
