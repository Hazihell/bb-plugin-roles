# bb-plugin-roles

First-class agent roles with quota-aware fallback:

- `server.ts` — the backend: a role store in this plugin's own SQLite
  database (`roles/store.ts`), live provider quota (`roles/quota.ts`), a
  held-block registry (`roles/blocks.ts`), candidate selection
  (`roles/select.ts`), the spawner and its respawn watcher (`roles/spawn.ts`),
  contributed instructions (`roles/instructions.ts`), an `@` mention provider
  (`roles/mention.ts`), and the `bb roles` CLI (`roles/cli.ts`).
- `skills/delegation/SKILL.md` — how to spawn, brief and read back children
  by role; imported into every agent thread automatically.
- `PLUGIN_OVERVIEW.md` — the store listing text: a longer version of
  `bb.description` shown on the plugin detail page.

## What a role is

A role has an `id`, a trigger `description`, a `permissionMode` (default
`full`), an optional `instruction`, and an ordered list of `candidates` —
each a provider id, a model (which may contain `{level}`, resolved at spawn
time), and a default reasoning level. The plugin seeds five roles once, ever,
on first load — **scout**, **builder**, **designer**, **reviewer**,
**advisor** — and never reseeds, even across a full delete.

## `bb roles`

```
bb roles spawn --role <id> --prompt <text> [--reasoning <level>] [--title <t>]
  [--environment <id> | --new-environment worktree --base-branch <ref>]
  [--parent <thread-id>] [--json]
bb roles list [--json]
bb roles show <id> [--json]
bb roles create --id <slug> --description <text>
  --candidate <provider>:<model>[:<level>] [--candidate ...]
  [--permission-mode <mode>] [--instruction <text> | --instruction-file <path>]
  [--machine <id-or-name>]
bb roles update <id> [--description <text>] [--permission-mode <mode>]
  [--instruction <text> | --instruction-file <path> | --clear-instruction]
  [--candidate <provider>:<model>[:<level>] ...] [--machine <id-or-name>]
bb roles delete <id> [--json]
bb roles export [--json]
bb roles import <file> [--machine <id-or-name>] [--json]
bb roles quota [--json]
```

`spawn` reuses the invoking thread's own environment and project when
`--environment` / `--new-environment` is omitted; with neither flag and no
thread context to fall back on, it fails with a one-line error. `create` and
`update` warn on stderr, never block, when a candidate's model is missing
from its provider's live model list. `--instruction-file` and `import`'s file
argument are read on the INVOKING machine, never the server: `--machine
<id-or-name>` names that host explicitly (it wins when given); otherwise the
invoking thread's own environment supplies it, and with neither, the command
exits 1 rather than guessing.

## Candidate selection

`spawn` tries each role's candidates in order and launches on the first one
that's usable. A candidate is skipped when the provider's live usage (BB's
own usage limits for Claude Code and Codex; a shelled-out Antigravity usage
report, split into a Gemini pool and everything else, for `acp-antigravity`)
falls at or below the **quota skip threshold** setting (default 5%), when
its status can't run (unauthenticated, expired, not installed), or when an
observed rate-limit block is still held for that provider. A block holds
until its reported reset time; with no reset time, it holds until an hour has
passed *and* a fresh usage read shows headroom on every window. When every
candidate is skipped, `spawn` refuses: exit 1, one line per candidate naming
its reset time.

## Respawn on a usage limit

The plugin watches every child it spawned for a blocked rate-limit event. On
one, it cancels the child's pending Provider Retry, records the block,
respawns the next usable candidate with the same brief, environment and
parent, archives the dead child, and sends **exactly one** message to the
parent thread naming the dead child, the new child and its candidate. When
no candidate is left, it sends the refusal to the parent instead and leaves
the dead child in place.

## Instructions and mentions

Every thread's instructions carry a Cast section, one line per role, plus a
`bb roles spawn` pointer — it is mandatory and is rendered first, so it is
never dropped; a thread this plugin spawned also carries that role's own
`instruction`, which gets whatever's left of the 4096-character budget,
truncated with a trailing "…" when it doesn't fit. Typing `@<role>` in the
composer hands the agent the role's description and a filled-in `bb roles
spawn` line.

## Export / import

`bb roles export` prints the whole cast as one JSON document (`{version: 1,
roles: [...]}`), on the invoking machine's filesystem — never the server's.
`bb roles import <file>` **replaces** the whole cast with that document: a
role not in the document is deleted, not merely left alone; positions follow
document order.

## Install

```
npm install
bb plugin install .
```

After editing sources, reload:

```
bb plugin reload roles
```

Or let `bb plugin dev` rebuild and reload on every save.

## Configure

```
bb plugin config roles
bb plugin config roles set thresholdPercent 10
bb plugin reload roles
```

## Checks

```
npm run build     # bb plugin build
npm test           # vitest run
npm run typecheck  # tsc --noEmit
```

## Types & API reference

The plugin API ships as the npm package `@get-bb/plugin-sdk`, pinned to an
exact version in `devDependencies`. After `npm install`, the full surface is
on disk at:

```
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts      # backend
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts  # frontend
```

```
bb plugin types          # sync this plugin's SDK surface to the running BB
bb plugin types --check  # CI: fail when it does not match
```

Ask BB to write plugins for you: the `bb-plugin-authoring` skill documents
the whole surface with examples.
