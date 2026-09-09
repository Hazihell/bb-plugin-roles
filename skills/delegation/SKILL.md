---
name: delegation
description: "Spawning, briefing or reading back a child thread, sizing builders, closing review findings, or a provider limit on a child. Use before any bb roles spawn or bb thread tell."
---

# Delegation

One expensive thread decides; cheap fresh threads do. The deciding thread is
the **coordinator**: it reads reports and diffs, never source files, and runs
no checks, so its context grows only by what children hand back. Every other
thread is a child with one role, one unit of work, and a fresh context.

The **cast** (the roles, each with its permission mode, its contract and
its ordered candidate providers, models and reasoning levels) is `bb roles
list`; a role's contract reaches the child with the spawn. This skill fixes
how the coordinator briefs and closes out children.

## Spawning

Every child, including exploration, research and planning, is a fresh BB
child thread spawned with `bb roles spawn --role <id> --title <t> --prompt
"$(cat <brief-file>)"`. Nothing about provider, model or reasoning level is
named at the call site: the plugin picks the first candidate with quota and
handles fallback on its own. Pass `--reasoning <level>` only to override
every candidate's default level for one spawn — a harder or a trivial unit
of work.

Every spawn names where the child runs: `--environment <id>` for this
thread's environment, or `--new-environment worktree --base-branch <ref>`
for an isolated builder slice. An omitted flag defaults to this thread's own
environment. `--parent` defaults to this thread; only pass it to link the
child elsewhere.

Write the brief to a file and pass it with `--prompt "$(cat <brief-file>)"`.
Children notify on completion (`@thread:<id> completed:`), so end the turn
right after `bb roles spawn` or `bb thread tell`; never sleep, poll or
`bb thread wait`.

## Briefing

Every brief carries: the role; the repository, environment and expected head
commit; the unit of work; and the cap on what it returns. What a role does on
arrival (a scout reports facts only, a reviewer never edits) is the role's
own contract, delivered with the spawn, so the brief carries only what the
coordinator knows. A brief carries decisions, not questions: a question in a
builder brief means the coordinator has not finished deciding.

- **Scout** gets the seams question.
- **Builder** gets its seam, test points, commit boundary, the scout report,
  and the documented check commands.
- **Reviewer** gets the two SHAs to compare, the paths of the standards
  sources, and the check commands to rerun on the head SHA.
- **Advisor** gets the coordinator's plan (the split, the briefs it intends
  to send, what it decided not to do), the scout report and the direction
  when there is one.

Read back a child's diff and report, never its transcript.

## Checking the plan

Spawn an advisor once, after the scout and before any builder, only when the
work is genuinely complex: several builders, a shared contract or public
surface changing, a direction with invariants to honour, or a scout report
that leaves the split unclear. Routine work goes straight to build.

## Sizing builders

The coordinator sizes builders from the scout's file inventory, before any
builder exists. One builder is the default. A unit is one behaviour that the
builder finishes inside about 150K tokens of context: about eight files or
400 changed lines at most. A thread pays its whole context on every call, so
a unit twice that size costs four times as much; a seam over the ceiling
splits, and the pieces run in sequence. A fix round is sized the same way,
its findings split by seam. Only seams sharing no file run in parallel, each
in its own worktree from the candidate commit.

## Staying in the smart zone

A builder does one unit of work, then is replaced rather than continued: the
next fix round is a fresh builder briefed with the current state. A reviewer
keeps its findings until every one is closed; a re-check costs a fraction of
a fresh reviewer's read of the diff.

## Review loop

Findings belong to the reviewer that raised them. After fixes, `bb thread
tell` that reviewer the new head SHA, what changed per finding, and each
unfixed finding with its reason; it answers `closed`, `open` or `regressed`
per finding. The coordinator decides whether an open finding blocks hand-back
and records why. Start a fresh full review only when a fix materially changes
behaviour, architecture, security, data or a public contract.

A usage limit on a spawned child needs no handling here: the roles plugin
respawns the child on the next candidate with the same brief and sends one
message to this thread naming the dead child, the new child and its
candidate; read that message and continue with the new child.

## Archiving

Archive a builder or scout once its report is read and its commit merged. A
reviewer stays open until its findings are closed. At hand-back every child is
archived.
