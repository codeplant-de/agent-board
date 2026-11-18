# Shared agent definitions (planned)

Status: planned, not built. Nothing here is on `main` yet. Follow-up to `board agents` (#110), task ivmjMwupgggT.

## Goal

One agent definition serves every machine. Today a task holds only the agent's name (sealed), and each machine must define a same-named agent the same way (see [Limits of the agent field](../workers.md#limits-of-the-agent-field)). With this change the board holds the definitions sealed. Every machine of the user picks them up and keeps them current without a step on each machine.

## Decisions

These were settled on the task before this document was written.

| Question                         | Decision                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| How a machine takes a definition | Automatically. Any of the user's CLIs can put an agent on the board, and every machine applies it and its later versions itself |
| How drift shows                  | A version and a hash. `board agents` shows them, `board doctor` warns and does not fail                                         |
| Who writes the sealed copy       | The CLI only, with `board agents push`, refused inside a board run. The browser shows the definitions read-only                 |

This reverses the [design decision](../architecture.md#design-decisions) "Agent definitions are files on each machine, and `board agents add` shows every grant, asks before it writes and never re-fetches", whose rejected alternative was "Definitions held (sealed) on the board". The row changes when this ships. What the old reason protected against, and what still holds, is under [Threat model](#threat-model).

## What the user does

```sh
board agents push reviewer        # put this machine's reviewer on the board (shows every grant, asks, then pushes)
board agents push ./reviewer.yaml # the same from a file
board agents                      # each agent, now with where it came from: local file, config.json or board vN
board agents rm --board reviewer  # take it off the board; every machine drops its copy on its next tick
```

`push` reads the definition the way `add` does, through the same strict parser, and prints the same grant summary and flags (broad allow rules, secret-looking `env` names, an empty deny list). It pushes only after a confirmation at a terminal or `--yes`. It is refused inside a run, like `add`, `rm` and `schedule`.

After a push the definition is board-managed on the pushing machine too: `push` moves the local file into the board store (below), so no machine ends up with a local file and a board copy of the same name.

The browser gets an **Agents** page under Settings. It lists each definition with its version, the time it was pushed, the full definition, the same grant flags as the CLI, and which machines run which version (from the catalogue, below). It cannot edit.

## The sealed document

All of a user's shared agents are one sealed document, like a machine's directory list, not one row per agent:

```json
{ "version": 4, "agents": { "reviewer": { "description": "…", "tools": ["Read"], "allowedTools": ["…"] } } }
```

- Field `agents.shared`, context `agents:v<version>`. The version is part of the binding, so the server cannot relabel an old document as a newer one.
- One document because agent names are sealed on tasks and must not appear in the clear. Per-agent rows would need the name, or a blind index of it, as their key. A single document also makes a push atomic and removes the case of the server swapping one agent's definition for another's: the names are inside the ciphertext.
- Each entry has exactly the keys of an agent file, read with the same strict parser. `source` is not stored. A machine records `source: board` itself.
- The version is a counter that only goes up. The server keeps it clear next to the ciphertext so the dispatch tick can compare without opening anything.
- Cap 256 KiB, like the other sealed documents.
- New table `shared_agents` (one row per user: `version`, `document`, `pushed_at`), an entry in `apps/backend/src/db/sealedColumns.ts`, and the binding in `packages/shared/src/sealing.mts` with the table in [encryption.md](../encryption.md). Export and import of the account (#145) carry the row. The test that ties the browser's re-seal to the sealed columns will fail until the re-seal handles it.

**Push is compare-and-set.** `board agents push` fetches the document, replaces or adds its one entry, and sends it with `expectedVersion`. The server stores it only if its version still is `expectedVersion`, with the new version `expectedVersion + 1`. If two CLIs push at once, the second gets a conflict, fetches again and retries once with a fresh grant summary if the entry it pushes changed underneath.

## How a machine applies it

1. The `version` answer gains `agentsVersion` (clear integer, or `null` when the user has none). It costs nothing on a tick where nothing changed.
2. When `agentsVersion` is higher than the version the machine last applied, the tick calls `get-agents`, opens the document under `agents:v<agentsVersion>`, and parses every entry strictly.
3. It writes each agent to `~/.config/agent-board/agents.board/<name>.yaml` (mode 600, directory 700) atomically, deletes the files of agents the document no longer has, and records the applied version and each agent's hash in `agents.board/state.json`.
4. Everything that reads agents reads `agents.board/` alongside `config.json` and `agents/`. A name defined in two of the three places makes that agent unusable, as two definitions do today, so the definition a task gets never depends on load order.
5. An entry that fails to parse makes that one agent unusable on the machine and leaves the others. A document that does not open, or whose version is lower than the applied one, changes nothing: the machine keeps what it has, and the dispatcher logs a warning and `board doctor` reports it.

Old CLIs ignore `agentsVersion` and keep running only their local agents. A task that names a board agent waits in Todo for a machine that has it, as it does today for a name a machine lacks.

## Drift

The hash is the SHA-256 of the agent's run-relevant keys as canonical JSON (sorted keys, no `source` or `version`).

- `board agents` shows, per agent, where it comes from (`config.json`, `agents/`, `board v4`) and its hash, short.
- For a local agent whose name also exists on the board, it shows whether the hashes match. That agent is unusable until one of them is removed (step 4 above).
- `board doctor` warns when the applied version is behind the board's `agentsVersion` (the last sync failed), when an agent is unusable because the board and a local file both define it, and when a board entry failed to parse. It does not fail.
- The machine catalogue (`set-catalog`) gains the applied version and per-agent hashes, so the browser's Agents page can show which machines are behind.

## Wire protocol

Additive. A feature name `agents.shared` in `packages/shared/src/features.mts`, no change to `MIN_CLIENT`.

| Command      | Body                                           | Answer                                     |
| ------------ | ---------------------------------------------- | ------------------------------------------ |
| `get-agents` | none                                           | `{ "version", "document" }` or `null`      |
| `set-agents` | `{ "document", "version", "expectedVersion" }` | `null`, or a 409 when the version moved on |

`set-agents` refuses a `version` that is not `expectedVersion + 1`. The document is shape-checked as a sealed value only; the server cannot read it.

## Threat model

The server is untrusted. It holds no key, so it cannot write a definition that opens. What it can still do, and what the design does about it:

| The server…                                  | Effect                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| serves an older document                     | Refused: the version is in the binding and a machine never applies a version lower than the one it has |
| swaps one agent's definition for another's   | Not possible: all names and definitions are inside one ciphertext                                      |
| withholds a newer document, or reports none  | Machines keep the version they applied. `board doctor` cannot see a newer version the server hides     |
| deletes the row                              | Machines keep their copies. Taking an agent off every machine needs a pushed document without it       |
| reports a higher `agentsVersion` than it has | `get-agents` does not open under that version; nothing changes, the tick warns                         |

**What this gives up.** Before, an agent definition changed on a machine only when the user read and confirmed it there. Now a push from any one machine reaches all of them within a dispatch tick, without a reading on each. The push needs the data key, and `board agents push` is refused inside a run. But the data key sits in `~/.config/agent-board/env` on every worker machine ([What the server can still do](../encryption.md#what-the-server-can-still-do)), so a run in `auto` mode that reads it can seal and push a definition with broader grants, and every machine applies it. Before this change such a run could already rewrite the agent files of its own machine; the new reach is every other machine.

## Open questions for the implementation

1. **Limit the cross-machine reach.** Options, not decided:
   - a per-machine switch (`"agents": { "sync": false }` in `config.json`) for machines that should keep only local agents,
   - apply a narrowing change by itself, but hold a change that widens grants (a new tool, allow rule or `env` name, a removed deny rule) until someone confirms it on the board,
   - sign the document with a key that worker machines do not hold (the user's push key, kept off `env`), and have machines verify it before applying.
2. **Event on change.** Whether a machine that applies a new version posts anything the user sees, beyond the browser's Agents page.
3. **Migrating existing agents.** Whether `board agents push --all` exists, and what it does with names that differ between machines (refuse and list them, most likely).
4. **Pinned versions on tasks.** Whether a task should seal the hash of the definition it was created for, so a run never starts under a definition the user did not see when making the task. Probably not, since the point is that a schedule picks up the current definition.
