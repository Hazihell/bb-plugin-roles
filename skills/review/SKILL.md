---
name: review
description: "Review loop for a committed candidate: reviewer children on standards and spec, every finding closed by the reviewer that raised it. Runs when a preset's REVIEW step or the user asks to review a branch or the changes since a fixed point."
---

# Review loop

The reviewer role's contract says what each axis reports and how a finding
closes; its cast line says what a brief carries. This skill is the loop around
it: pin, brief, spawn, close.

## 1. Pin the two commits

```sh
base=$(git merge-base <fixed-point> HEAD)
head=$(git rev-parse HEAD)
git log $base..$head --oneline
git status --short
```

The fixed point is the one named, else the branch this one was cut from. Both
SHAs go into the brief, so every reviewer compares the same two commits
whatever the branches do later. Uncommitted work is outside the review: commit
it or say it is out. Done when the log lists at least one commit and the tree
is clean.

## 2. Gather the brief

- **Spec**: the packet's Goal, Direction and acceptance criteria, or what the
  user named. Pasted in, never pointed at. `/review-record` resolves it from a
  tracker task.
- **Standards paths**: sweep the repo root, `docs/`, `.github/` and the
  directories the diff touches for the files that say how code is written
  (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` and the like). Paths only; the
  reviewer reads them.
- **Check commands**: the repository's documented ones, verbatim.
- **Axes**: both by default. A second reviewer, spec only, when the diff
  changes a shared contract: a CLI surface, a preset or skill text, an exported
  type, a wire format, anything a caller outside the diff depends on.

Write it to a file. Done when the file holds the two SHAs, the commit list,
the spec, the standards paths, the check commands and the axes.

## 3. Spawn

```sh
bb roles spawn --role reviewer --title "review: <what>" --prompt "$(cat <brief-file>)"
```

One spawn per reviewer, then end the turn. Done when every reviewer the brief
calls for has reported; keep each report under its own `## Standards` and
`## Spec`, complete and verbatim, findings unmerged and unreranked, one
section per axis per reviewer.

## 4. Close every finding

Fix in this worktree and commit; a thread that owns no worktree briefs a fix
child instead. Then:

```sh
bb thread tell <reviewer-thread> "Head <new-sha>. Per finding: <what changed, or why it stays open>."
```

End the turn. The reviewer answers `closed`, `open` or `regressed` per
finding on the new SHA. A finding that stays open does so by this thread's
decision, with the reason written where the hand-back will carry it. Repeat
until every finding is `closed` or has its reason recorded, then archive the
reviewers.

## Report

The reviewers' sections verbatim, then findings per round with their final
state, then the head SHA the last verdict names.
