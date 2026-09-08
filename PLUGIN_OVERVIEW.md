Coordinators today pick a provider, model and reasoning level for every
child by hand, from a cast written into custom instructions, and discover an
exhausted quota one failed child at a time. This plugin makes a role a
first-class thing in BB.

## What a role is

A role is a named record: a trigger description, a permission mode, an
optional instruction, and an ordered list of model candidates to try in
turn — each a provider, a model (which may contain `{level}`, resolved at
spawn time) and a default reasoning level. The plugin seeds five roles once,
on first load, copied from the common custom-instructions cast: **scout**,
**builder**, **designer**, **reviewer**, **advisor**. Seeding never repeats,
even across a full delete, so edits always stick.

## Spawning by role

`bb roles spawn --role <id> --prompt <text>` picks the first candidate whose
provider has live quota, launches the child under it, and hands back both
ids. `--reasoning <level>` overrides every candidate's default level for
that one spawn. `--environment <id>` or `--new-environment worktree
--base-branch <ref>` names where the child runs; an omitted flag reuses the
invoking thread's own environment, and `--parent` defaults to that thread
too.

Every candidate is skipped when its provider's live usage falls at or below
a threshold setting (default 5%), when its status can't run (unauthenticated,
expired, not installed), or when an observed rate-limit block is still held —
a block holds until its reported reset time, or with no reset time until an
hour has passed and a fresh usage read shows headroom. When every candidate
is skipped, `spawn` refuses with one line per candidate and its reset time —
or, for a held block with no reported reset time, its earliest release time,
flagged as such since fresh headroom is still required and the time may
already be past.

When a spawned child later hits a usage limit mid-turn, the plugin cancels
its pending retry, respawns the next candidate with the same brief,
environment and parent, archives the dead child, and sends exactly one
message to the parent thread naming both. The coordinator never handles
fallback by hand.

## Everywhere else

Every thread's instructions carry the cast, one line per role — it is
mandatory and always renders first; a thread this plugin spawned also
carries that role's own instruction, in whatever budget is left under the
4096-character cap. Typing `@builder` in the composer hands the agent the
role's description and a ready `bb roles spawn` line. `bb roles export` and
`bb roles import <file>` move a whole cast as one JSON document, so a cast
can be shared, versioned or restored; import **replaces** the whole set —
a role missing from the document is deleted, not left in place.

## CLI

`bb roles list`, `show <id>`, `create`, `update`, `delete`, `export`,
`import <file>` and `quota` manage the cast from a terminal or an agent
thread; `create` and `update` warn, never block, when a candidate's model is
missing from its provider's live model list. `create`, `update` and `import`
read any file argument from the invoking machine, not the server; an
explicit `--machine <id-or-name>` names that host when there's no invoking
thread to infer it from.
