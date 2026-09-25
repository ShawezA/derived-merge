#!/usr/bin/env sh
# Register derived-merge as a git merge driver in the current repository.
#
# This script exists because of a specific defect in git: a merge driver's
# definition lives in .git/config, never in .gitattributes, so it is NOT
# distributed with the repository. Worse, when a repo ships
# `package-lock.json merge=derived` in .gitattributes and the driver is not
# registered, git's find_ll_merge_driver() silently falls back to a plain
# textual merge -- no warning, no error, no indication that the policy the
# repo asked for did not run.
#
# So every contributor has to run this, and there is no way to make that
# automatic from inside the repo. Until this ships as a self-installing
# binary, that is the honest state of things.

set -eu

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "error: not inside a git repository" >&2
    exit 1
}

DRIVER_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DRIVER="$DRIVER_DIR/src/cli.py"

[ -f "$DRIVER" ] || { echo "error: driver not found at $DRIVER" >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || {
    echo "error: python3 is required and was not found on PATH" >&2
    exit 1
}

git config merge.derived.name "structural merge for identity-keyed derived files"
git config merge.derived.driver "python3 '$DRIVER' %O %A %B %L %P"

# The virtual-merge-base setting matters and is easy to get wrong. By default
# git reuses the driver itself to construct a hypothetical ancestor during a
# criss-cross merge. For a structural merge that is defensible; for a
# "regenerate the file" driver it would be nonsense. Set it explicitly so the
# behaviour does not depend on a default that might change.
git config merge.derived.recursive text

ATTR="$REPO_ROOT/.gitattributes"
PATTERNS="package-lock.json deno.lock composer.lock"

added=0
for pattern in $PATTERNS; do
    if [ -f "$ATTR" ] && grep -qE "^[[:space:]]*$(echo "$pattern" | sed 's/\./\\./g')[[:space:]]" "$ATTR" 2>/dev/null; then
        continue
    fi
    printf '%s merge=derived\n' "$pattern" >> "$ATTR"
    added=$((added + 1))
done

echo "Registered 'derived' merge driver for this repository."
if [ "$added" -gt 0 ]; then
    echo "Added $added pattern(s) to .gitattributes -- commit it so the repo asks"
    echo "for the policy, and tell contributors to run this script."
else
    echo ".gitattributes already referenced the patterns; nothing added."
fi
echo
echo "Verify with:  git check-attr merge -- package-lock.json"
