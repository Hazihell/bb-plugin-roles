---
name: delegation
description: "Spawning, briefing or reading back a child thread, sizing builders, closing review findings, or a provider limit on a child. Use before any bb roles spawn or bb thread tell."
---

# Delegation

One expensive thread decides; cheap fresh threads do. The deciding thread is
the **coordinator**: it reads reports and diffs, never source files, and runs
no checks, so its context grows only by what children hand back. Every other
thread is a child with one role, one unit of work, and a fresh context.

The roles are **scout**, **builder**, **reviewer** and **advisor**. The **cast** (the
candidate providers, models and reasoning levels per role, with fallbacks) is
a first-class thing in the roles plugin (`bb roles list`), not the user's
custom instructions; this skill fixes what each role does and how it is
briefed.

## Spawning

Every child, including exploration, research and planning, is a fresh BB
child thread spawned with `bb roles spawn --role <id> --title <t> --prompt
"$(cat <brief-file>)"`. Nothing about provider, model or reasoning level is
named at the call site: the plugin picks the first candidate with quota and
handles fallback on its own. Pass `--reasoning <level>` only to override
every candidate's default level for one spawn — a harder or a trivial unit
of work. The provider's own agent or subagent tool is not used, even for a
read-only helper. Every child takes `--permission-mode full` (the role's
permission mode; every seeded role is `full`); if this thread lacks full
mode, ask the user to raise it first.

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
commit, which a scout or reviewer confirms before reading code; the unit of
work; and the cap on what it returns. A brief carries decisions, not
questions: a question in a builder brief means the coordinator has not
finished deciding.

- **Scout** reports facts only: the files each seam touches, which seams share
  a file, how large each seam is, and the questions it could not answer. No
  recommendations, no plan. At most a thousand words.
- **Builder** gets its seam, test points, commit boundary, the scout report,
  and the documented check commands to run. It reports each command with its
  exit code and one summary line, verbatim, plus the head SHA it committed.
- **Reviewer** gets the two SHAs to compare, the paths of the standards
  sources, and the check commands to rerun on the head SHA. It reads and
  reports only: it never edits, spawns or delegates. Under 400 words per axis.

- **Advisor** gets the coordinator's plan (the split, the briefs it intends
  to send, what it decided not to do), the scout report and the direction
  when there is one. It returns what the plan gets wrong, what it misses and
  what it could drop, under 400 words; the coordinator keeps the decision.

Read back a child's diff and report, never its transcript.

## Checking the plan

Spawn an advisor once, after the scout and before any builder, only when the
work is genuinely complex: several builders, a shared contract or public
surface changing, a direction with invariants to honour, or a scout report
that leaves the split unclear. Routine work goes straight to build.

## Sizing builders

The coordinator sizes builders from the scout's file inventory, before any
builder exists. One builder is the default. A unit of work must fit one fresh
context: the builder can read everything its seam touches plus its brief and
still have room to work. A seam that fails that test splits. Seams that share
a file merge or run in sequence. Only seams sharing no file run in parallel,
each in its own worktree from the candidate commit.

## Staying in the smart zone

A thread does one unit of work, then is replaced rather than continued. A
builder gets one fix round; the next round is a fresh builder briefed with
the current state. A reviewer that has re-checked twice hands its open
findings to a fresh reviewer. Where the provider reports remaining context,
prefer that figure to the round count.

## Review loop

Findings belong to the reviewer that raised them. After fixes, `bb thread
tell` that reviewer the new head SHA, what changed per finding, and each
unfixed finding with its reason. The reviewer verifies facts on the new SHA:
`closed`, `open` or `regressed` per finding. The coordinator decides whether
an open finding blocks hand-back and records why; a reviewer never overrules
that decision. Start a fresh full review only when a fix materially changes
behaviour, architecture, security, data or a public contract.

Add a second reviewer for the spec axis only when the diff changes something
other code depends on: a schema, a cross-package interface, an auth path, a
shared contract a later task builds on. Interaction, accessibility or several
concerns in one slice do not qualify.

A usage limit on a spawned child needs no handling here: the roles plugin
respawns the child on the next candidate with the same brief and sends one
message to this thread naming the dead child, the new child and its
candidate; read that message and continue with the new child.

## Archiving

Archive a builder or scout once its report is read and its commit merged. A
reviewer stays open until its findings are closed. At hand-back every child is
archived.
