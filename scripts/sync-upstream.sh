#!/usr/bin/env bash
# Prepare a reviewable upstream merge without committing, pushing or deploying.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

if [[ "$(git branch --show-current)" != custom ]]; then
  echo 'Switch to custom before merging upstream.' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'Review and save existing changes before merging upstream.' >&2
  exit 1
fi
if [[ "$(git remote get-url upstream)" != https://github.com/deepcoldy/botmux.git ]]; then
  echo 'The upstream remote must point to deepcoldy/botmux.' >&2
  exit 1
fi

# A shallow initial checkout may not retain the merge base of later releases.
if [[ "$(git rev-parse --is-shallow-repository)" == true ]]; then
  git fetch --unshallow --no-tags upstream master
else
  git fetch --no-tags upstream master
fi
git merge --no-ff --no-commit upstream/master
echo 'Merge prepared. Review conflicts and changes before committing or deploying.'
