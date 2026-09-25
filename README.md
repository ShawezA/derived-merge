# derived-merge

Lockfile merge conflicts, gone.

```sh
npm install --save-dev derived-merge
```

That's it. No config, no setup step, no per-developer instructions. Your
teammates get it the next time they run `npm install`.

## The problem

You and a colleague both branch from `main`.

- You run `npm install lodash`. `package-lock.json` changes.
- They run `npm install axios`. `package-lock.json` changes.
- You merge.

```
CONFLICT (content): Merge conflict in package-lock.json
```

Nothing about that conflict is real. You added lodash, they added axios,
neither of you touched the other's entry. Git flags it because **git merges
lines**, and in a lockfile your new entry and theirs happened to land next to
each other alphabetically.

So you hand-edit a 15,000-line generated file that no human is supposed to
read, or you delete it and regenerate and hope you didn't silently drop their
dependency.

## What this does

It teaches git that a lockfile isn't lines — it's a **map** from package to
version.

```
$ git merge feature-a
derived-merge: package-lock.json: merged cleanly
Merge made by the 'ort' strategy.
```

Both dependencies present. No markers. Nothing regenerated.

### Measured on real history

150 three-way merges reconstructed from `npm/cli`'s own `package-lock.json`
history — consecutive lockfile commits treated as two branches from a common
base, the "two developers branch from main" shape:

| | clean | conflict |
|---|---|---|
| git textual merge | 126 | **24** |
| derived-merge | 147 | **3** |

**21 of git's 24 conflicts resolved**, and it never conflicts where git was
clean. The 3 that remain are genuine two-sided disagreements about the same
key, which is exactly what should not be resolved automatically:

- one branch deleted a nested dependency while the other modified it
- `10.0.0-pre.1` versus `10.0.0` — a release/prerelease split
- two different bumps of the same devDependency (`4.21.2` vs `4.21.3`)

Correctness was checked separately, because "resolved" is worthless if it means
"silently wrong": across every cleanly-merged case, **0 values lost from either
side, 0 invented**. The checker is itself tested against deliberately corrupted
merges — it catches a dropped addition, a rewritten version, and an invented
entry.

## What it decides, and what it refuses

Resolved automatically:

| Situation | Result |
|---|---|
| Both branches added different packages | Both kept |
| Both branches added the same package identically | Not a disagreement at all |
| One branch changed an entry, the other didn't | Take the change |
| One branch removed an entry, the other didn't touch it | Removal wins |
| Branches edited *different fields* of one entry | Both edits applied |

Refused, with a path instead of a line number:

```
derived-merge: package-lock.json: 1 unresolved:
  packages.lodash.version: both sides changed this to a different value
      ours:   "4.17.21"
      theirs: "4.18.0"
```

That refusal is the important half. Two branches that genuinely disagree about
a version *are* a disagreement, and a tool that quietly picked a winner would
be worse than the conflict it replaced.

If any input isn't parseable, it writes nothing and exits non-zero — you get
git's ordinary conflict, exactly as if this weren't installed.

## Supported files

- `package-lock.json`, `npm-shrinkwrap.json`
- `yarn.lock` — both v1 ("classic") and v2+ ("berry")
- `deno.lock`
- any other identity-keyed JSON you point it at

Verified to reproduce React's 17,724-line v1 lockfile (2,388 entries) and
cal.com's 42,405-line berry lockfile (3,936 entries) **byte for byte**, because a serializer that
reformats would produce a whole-file diff worse than the conflict it removed.

`pnpm-lock.yaml` is not supported yet — it's real YAML and needs a YAML parser.

## Why npm, and why this actually reaches your team

Git has a defect here that's worth knowing about, because it's the reason
nobody has solved this before with a merge driver.

**A merge driver's definition lives in `.git/config` and is never distributed
with the repository.** `.gitattributes` can only *request* a driver by name,
not supply it. And when a repo asks for a driver that isn't registered, git's
`find_ll_merge_driver()` falls back to a plain textual merge with **no warning
and no error** — the policy silently doesn't run, and nothing tells anyone.

That's why every package manager that tackled lockfile merging did it inside
its own parser instead: npm has an undocumented three-way merge in
`@npmcli/parse-conflict-json`; pnpm picks a side by recency and admits it
"cannot guarantee pnpm will choose the correct head"; Cargo's issue asking for
this has been open since **2015**.

Shipping on npm fixes it. As a devDependency with a `postinstall` hook, the
driver registers itself for everyone who installs the repo's dependencies —
which is everyone, already, as part of their normal workflow. The package
manager *is* the distribution channel.

Manual install, if you'd rather:

```sh
npx derived-merge init
```

## How it works

Most of a lockfile is an **identity-keyed map with deterministic values** —
`name@version` → integrity hash, url → hash. A given key always maps to the
same value regardless of which branch wrote it, so a conflict in those regions
is *spurious* and the correct merge is a union. Only the regions where two
branches can genuinely disagree need a conflict.

That framing comes from the Deno team's `deno.lock` merge support (June 2026).
It beats the obvious alternative — "never merge a generated file, just
regenerate it" — because regeneration discards work: re-running the package
manager picks one side's resolution and silently drops the other's.

The rule, in one line: **partition by provability.** Union what is provably
unambiguous, conflict on the rest, never guess in between.

## Tests

```sh
npm test
```

24 cases, including the two real bugs found while building this — each still
fails if its fix is removed:

- Equality delegated to the language's `==`, under which `{flag: 0}` and
  `{flag: false}` compare equal. A type guard on the outer value was bypassed
  one level down, so a branch that changed a flag looked like one that changed
  nothing. Equality is now deep and type-strict.
- List elements were keyed by content, so two branches editing *different
  fields* of the same entry produced two copies of it. Elements are now keyed
  by identity field where one exists.

## Limits

- `pnpm-lock.yaml` unsupported (needs a YAML parser).
- List order isn't preserved across a merge of two reordered lists; output
  follows ours, then appends what theirs added.
- No semantic validation. A structurally clean merge can still produce a
  dependency set that doesn't install. This merges the file; it doesn't run
  your package manager.

## License

MIT
