#!/usr/bin/env bash
# Commits and pushes the working tree every five minutes so that no more than that is lost.
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)" || exit 1
for i in $(seq 1 96); do
  sleep 300
  if [ -n "$(git status --porcelain)" ]; then
    git add -A >/dev/null 2>&1 && git commit -q -m "Checkpoint: work in progress

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>" >/dev/null 2>&1 && echo "$(date +%H:%M) checkpoint $(git rev-parse --short HEAD)"
  fi
  git push -q origin HEAD >/dev/null 2>&1
done
echo "checkpoint loop finished after 8 hours"
