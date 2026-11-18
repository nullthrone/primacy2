#!/usr/bin/env bash
# Commits and pushes the working tree every five minutes so that no more than that is lost.
# One loop per worktree. It commits to the branch that is checked out and pushes that branch.
# While `main` is checked out, or no branch at all, it does nothing: work happens on feature
# branches and reaches `main` only through a merged pull request.
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)" || exit 1
for i in $(seq 1 96); do
  sleep 300
  branch="$(git symbolic-ref --quiet --short HEAD)"
  if [ -z "$branch" ] || [ "$branch" = "main" ]; then
    echo "$(date +%H:%M) no checkpoint: ${branch:-no branch} is checked out"
    continue
  fi
  if [ -n "$(git status --porcelain)" ]; then
    git add -A >/dev/null 2>&1 && git commit -q -m "Checkpoint: work in progress" >/dev/null 2>&1 && echo "$(date +%H:%M) checkpoint $(git rev-parse --short HEAD)"
  fi
  git push -q origin HEAD >/dev/null 2>&1
done
echo "checkpoint loop finished after 8 hours"
