# MCP server

OpenScreen offers the in-app agent's tools to MCP clients the user runs themselves (Claude Code, Codex, Cursor, anything that speaks MCP), on any of the user's projects, not only the one open in the editor. The client brings its own model and its own sign-in; OpenScreen never sees, stores or relays those credentials.

The same tools are served over two transports, by two different processes:

| | In-app server (HTTP) | `openscreen mcp` (stdio) |
|---|---|---|
| Process | The running app (the GUI) | A process of its own, started by the client: the app's executable with `mcp` |
| Setup | **AI settings → MCP server**: turn it on, copy the `claude mcp add` / `codex mcp add` command (it carries the token) | `claude mcp add openscreen -- <executable> mcp` ([executables](../../website/docs/cli.md#running-the-cli)) |
| Auth | Bearer token, `127.0.0.1` only, Host/Origin check | None: the client launched the process with the user's rights |
| Edits | Off until the user turns on **MCP edits** | Always allowed |
| Project open in the editor | Edited live through the editor, one undo step per call | Read only: an edit to it is refused ([the marker](#the-open-in-editor-marker)) |
| Other projects | Read from and saved to their file, a checkpoint first | Same |
| Tools | `listProjects`, the agent's tools, the checkpoint tools | The same, plus the media tools: `listSources`, `startRecording`, `stopRecording`, `setPointerTrack`, `exportVideo`, `getFrames` |
| Checkpoints | In memory, lost when the app quits or the server restarts | In memory, lost when the process exits, which it does when the client disconnects |

Neither server knows about the other. Two processes may therefore write the same project folder; the [open-in-editor marker](#the-open-in-editor-marker) and the byte compare of `saveProjectIfUnchanged` are what keep them from overwriting each other's work.

| File | Role |
|---|---|
| [`electron/mcp/openscreen-mcp-server.ts`](../../electron/mcp/openscreen-mcp-server.ts) | The tools both transports serve, the tool runner (routing, refusals, checkpoints), the texts per transport (`mcpInstructions`), and the local HTTP guard. |
| [`electron/mcp/stdio-server.ts`](../../electron/mcp/stdio-server.ts) | `openscreen mcp`: the same server and runner on stdin/stdout, with the media tools. |
| [`electron/mcp/media-tools.ts`](../../electron/mcp/media-tools.ts) | The media tools and their capability block (`MEDIA_PREAMBLE`). |
| [`electron/mcp/editor-document-host.ts`](../../electron/mcp/editor-document-host.ts) | Main-process side of the live document: asks the editor window for a snapshot and hands edits back. |
| [`electron/mcp/mcp-controller.ts`](../../electron/mcp/mcp-controller.ts) | In-app server lifecycle: start when enabled, restart on a port or token change, status for the settings UI. |
| [`electron/mcp/mcp-settings-store.ts`](../../electron/mcp/mcp-settings-store.ts) | `mcp-server.json` (enabled, port, allowEdits) and `mcp-token.enc` (bearer token, `safeStorage`). |
| [`src/lib/ai-edition/store/mcpDocumentHost.ts`](../../src/lib/ai-edition/store/mcpDocumentHost.ts) | Renderer side: answers snapshot / apply requests from the project store. Mounted by `NewEditorShell`. |
| [`src/components/ai-edition/McpServerSettings.tsx`](../../src/components/ai-edition/McpServerSettings.tsx) | The settings section: server toggle, the **MCP edits** toggle, port, token, copyable `claude mcp add` / `codex mcp add` commands. |

## One tool surface, two agents

Nothing about the tools is reimplemented. The server registers `TOOL_ARG_SCHEMAS` (names and zod schemas) and `TOOL_DESCRIPTIONS`, and builds its `instructions` around `buildSystemPrompt`, all exported from [`deep-agent/service.ts`](../../electron/ai-edition/deep-agent/service.ts), where `buildTools` builds the in-app agent from the same table. Every call goes through `runDocumentTool`, the function the in-app agent's `documentTool` also calls: the cursor-telemetry read the zoom tools need, then `executeAgentTool`.

So a tool added to the agent appears over MCP with no further work, and the MCP test asserts the listed tools equal `listProjects`, then `OPENSCREEN_TOOL_NAMES`, then the two checkpoint tools below. What the server adds:

- **`listProjects`**, a tool of its own: every project's id, title, `updatedAt`, asset count, and `open` for the one in an editor (this process's, or the app's seen through the marker).
- **An optional `projectId` on every agent tool and both checkpoint tools**, added to its schema with `.extend()` at registration and stripped again before the call reaches the executor, which never sees it. See [Which project a call acts on](#which-project-a-call-acts-on).
- **`createCheckpoint` / `restoreCheckpoint`**, see [Checkpoints](#checkpoints).
- MCP metadata: `readOnlyHint` for the reads (`!isMutatingTool`), `listProjects` and `createCheckpoint`, and `destructiveHint` for `replaceTimeline`, the three `remove*` tools and `restoreCheckpoint`.

## What each transport tells its client

Every text a client reads must be true on the server that serves it, so the texts are composed rather than shared verbatim. `McpToolDeps.transport` (`"http"` or `"stdio"`) selects them:

- **Instructions** (`mcpInstructions`): the media tools' capability block when they are registered, then the projects-and-checkpoints rules of the transport, then how long checkpoints live there, then `buildSystemPrompt`. The checkpoint rule is in both. Over HTTP the rules speak of the editor and its undo stack and add "Nothing here records, exports or imports media"; over stdio they say a `projectId` is needed on every call, that `Ctrl/Cmd+Z` cannot undo an edit, and that a project open in the app is refused.
- **`buildSystemPrompt`** takes the transport's facts as options: `editsSetting` names the switch its consent block points to (the MCP server's **MCP edits**, not the in-app agent's **Agent edits**), and `canExport` drops "exporting" from its examples of a request with no tool when `exportVideo` is served.
- **Tool descriptions**: `projectId` is "omit it for the open project" over HTTP and "pass it on every call" over stdio; `restoreCheckpoint` mentions the undo step only over HTTP, and the pointer track only where `setPointerTrack` is served.
- **Messages**: no project to fall back on, a checkpoint required, an unknown checkpoint, edits turned off. Each has a version per transport, or exists only on the one that can produce it.

The in-app chat agent keeps `buildSystemPrompt`'s defaults: its own switch, no export.

**Writes on the in-app server are a second opt-in.** MCP clients have their own **MCP edits** switch, `allowEdits` in `mcp-server.json`, **off by default** and independent of the in-app agent's **Agent edits** (`allowAgentEdits`). Turning the server on therefore grants read access only. The value is read on every call; while it is off every mutating tool, `setPointerTrack` and `restoreCheckpoint` are refused with the executor's `consent_required` payload naming **MCP edits**, and the consent block of the system prompt is in the instructions. It is independent because `allowAgentEdits` defaults to allowed and lives in the provider form, so a user with no provider configured could never have turned MCP writes off. Toggling it does not restart the server. `openscreen mcp` has no such switch: the client started it itself, and there is no other caller to keep out.

## Which project a call acts on

| `projectId` | In-app server | `openscreen mcp` |
|---|---|---|
| omitted | The project open in the editor, through the editor. With none open the call fails and points at `listProjects`. | Fails: there is no editor to fall back on. The message asks for a `projectId`. |
| the id of the project open in this process's editor | The same: through the editor, never its file. The file is read first all the same (see below). | Cannot happen: this process has no editor. |
| any other id | That project's file, through the process's one `DocumentService` (`getProjectForUpdate` → tool → `saveProjectIfUnchanged`). Works with no editor window at all. A write needs a checkpoint of that project first, and is refused while another process's editor holds it. | Same. |

The open project is never written to disk from here because the editor holds it in memory and saves it as a whole: a file edit under it would be overwritten by the editor's next save, and the editor would never show it.

## Where the document comes from

### The open project (in-app server)

The in-app agent is handed a document snapshot per chat turn. An MCP client has no turn, so each call reads the **live** document from the editor window, which owns it (`useProjectStore`, with its `revision`):

1. `EditorDocumentHost.snapshot()` sends `{op: "snapshot"}` on `ai-edition.mcp-request` to the editor; it answers `{document, revision}` (or `null` with no project open).
2. `runDocumentTool` runs against that document.
3. If the tool changed it, `apply(document, revision)` sends it back; the editor applies it through `applyAgentDocumentIfCurrent` — the same revision-guarded apply an in-app chat turn uses — so it is saved and becomes **one undo step**.

A user edit that lands between 1 and 3 moves the revision and the apply is refused as a conflict; the client is told to re-read. The renderer also compares the project id, because the revision counter restarts at 0 when a project closes and a quick switch to another project could otherwise match. Calls are serialised in the main process so two of them never interleave.

Only the webContents that registered on `ai-edition.mcp-host` is asked, and only its replies count. An editor that unmounts or is destroyed stops being asked. A request unanswered for 30 s resolves to "no project" (reads) or `timeout` (writes, reported as "did not confirm", not as a failure, since the save may have landed).

`openscreen mcp` builds the same `EditorDocumentHost`, but no editor window ever exists in that process, so its snapshot is always `null`.

### Any other project

Read with `DocumentService.getProjectForUpdate` (`getProject`, migrated and relinked like any open, plus a version) and, if the tool changed it, saved with `saveProjectIfUnchanged` — the same instance every other save in the process goes through. Reads and saves of one project share its queue, so a read returns only once every read and save asked for before it is done.

A call naming a project reads its file **before** asking the editor for a snapshot. An editor open of that project already under way has then returned, and the editor installs what it read before it answers, so the snapshot shows the project and the call goes through the editor.

Before the save, the runner refuses, in this order and with nothing written:

1. **Another process's editor holds the project** ([the marker](#the-open-in-editor-marker)). That editor would save over the edit.
2. **The project has no checkpoint** in this server's memory. An edit to a file is on no undo stack, so the checkpoint is its only way back ([Checkpoints](#checkpoints)).
3. **The project changed since the call read it.** There is no revision to guard a file with, so the save is refused with "NOT applied … re-read, then retry" when, since the read:
   - **anything read the project.** This is the editor opening it: from that read on it holds a copy without the MCP edit, and its next save would drop the edit without a word. A snapshot cannot see this in time, since the editor installs what it read only after the read returns. `DocumentService` counts every read and save of a project instead. The client's retry, with the same `projectId`, then goes through the editor. The open-file dialog never saves back a project's own file: it loads that project by id (`storedProjectId`), a read like any other.
   - **anything saved it, or its file changed.** The file must still be, byte for byte, the one the tool ran against. This also covers the other process, a writer outside the app (a sync tool, a restored copy) and a delete.

The check runs inside the project's queue, so nothing in the process reads or saves the project between the check and the write.

### The open-in-editor marker

`openscreen mcp` cannot ask the app's editor anything, so the app says which project its editor holds: the editor sends the project id on `AI_EDITION_OPEN_PROJECT_CHANNEL`, and `DocumentService.markOpenInEditor` writes `.open-in-editor.json` (`{pid, projectId}`, temp file then rename) in the projects folder. Only the window that set it clears it, on closing the project or on being destroyed. `projectOpenInEditor()` reads it back and ignores a marker whose `pid` is no longer running, so an app that crashed blocks nothing. The runner checks it just before any write to a file; `listProjects` reports the project as `open`.

An edit refused this way is answered with `ProjectOpenInEditorError`'s message: close the project in the app, or connect to the in-app server, which edits the open project through the editor.

## Checkpoints

A client chains several edits in one turn, and each is its own undo step, so reverting a turn by hand means one Ctrl+Z per call, interleaved with whatever the user did meanwhile. `createCheckpoint` saves the document in the server's memory and returns a `checkpointId`; `restoreCheckpoint` hands that document back as the call's new document. On the project open in the in-app server's editor it goes through the same revision-guarded apply, so the whole revert is **one undo step** the user can itself undo. The server instructions tell the client to checkpoint before a series of edits.

- They take `projectId` like every tool, so a project that is not open has them too: the checkpoint is read from its file, and the restore is saved to it with the same guards as any edit. That restore is not one undo step, since nothing holds the project's history.
- **A project that is not open cannot be edited without one.** Ctrl+Z cannot reach an edit to it, so a write there is refused until a checkpoint of that project is in memory, and the client is told to call `createCheckpoint` first. Over stdio that is every project. `stopRecording` creates one for each new take and returns its id.
- **They cover the cursor sidecar.** `setPointerTrack` rewrites `<video>.cursor.json`. Before the runner writes a sidecar, it keeps the file's previous content (or its absence) in every checkpoint of that project that has none for it yet; a restore writes those back, and deletes a sidecar the take never had. A restore is itself such a write, so each checkpoint gets back its own state whatever order they are restored in.
- A restore is a write: refused while **MCP edits** is off, and refused when the checkpoint belongs to another project than the one the call acts on. That message names the checkpoint's `projectId`: restoring a closed project's checkpoint takes it explicitly.
- It discards every edit since the checkpoint, the user's included. The tool description says so.
- **Lifetime.** Checkpoints live in the runner's memory, the 20 most recent. On the in-app server they are lost when the app quits or the server restarts: turned off and on, its port changed, or its token regenerated, since each of those starts a new server with a new runner. Over stdio they are lost when the process exits, which it does when the client disconnects. The unknown-checkpoint message says which. The in-app agent does not need them: its whole turn is a single apply.

## The media tools (stdio)

`registerMediaTools` adds the tools that make a video around the edits. They share the runner the document tools use (`createToolRunner` in `stdio-server.ts`):

- `stopRecording` turns the take into a project and creates its checkpoint through the runner.
- `setPointerTrack` gives a script-driven take a pointer track and plans zooms on its clicks. It computes the new sidecar and the zooms from the project the runner read, writes nothing itself, and hands both to the runner as a `RunnerEdit`. The runner then applies the same refusals as any edit (another process's editor, no checkpoint, a project changed mid-call) before writing anything, saves the project, and only then writes the sidecar, keeping its previous content for the checkpoints. Every refusal comes back as the tool's own text result. A sidecar write that fails after the save is reported as a partial edit: the project was saved, the pointer track was not.
- `exportVideo` and `getFrames` read projects; they write none.

## Transport and security

**In-app server (HTTP)**

- Streamable HTTP, **stateless**: a fresh `McpServer` + transport per request, the SDK's documented shape for a server that keeps no session state. The runner, and so the checkpoints, live as long as the running server.
- Bound to `127.0.0.1` only, endpoint `/mcp`, default port 47821 (configurable, 1024–65535).
- Every request needs `Authorization: Bearer <token>`, compared in constant time. The token is 32 random bytes, stored with `safeStorage`, and read only once the server is enabled, so users who never enable it never meet a Keychain prompt for it. Regenerating it restarts the server, so the old one stops working at once.
- The `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, and a request carrying any other `Origin` is refused — this blocks a web page from reaching the server through DNS rebinding.

**`openscreen mcp` (stdio)**

- One `McpServer` on the process's stdin/stdout for the whole session. It exits when stdin ends, closes or errors, whichever the client's pipe reports.
- No port and no token: only the client that launched the process can talk to it, with the user's rights, as it would run `openscreen record` or `openscreen export`.

## Lifecycle

`registerIpcHandlers` builds the `McpController` (it is where the agent's own dependencies — the cursor reader, the LLM config — live) and returns it; **`main.ts` starts it**. The headless CLI shares `registerIpcHandlers` and must never bind the port a running app is listening on, and a bench run has no use for it, so neither calls `startIfEnabled`. `openscreen mcp` reuses the same dependencies (`mcpToolDeps`) with `transport: "stdio"` and edits always allowed.

## Connecting a client

The settings section shows both commands for the in-app server with the real URL, and copies them with the real token:

```sh
claude mcp add --transport http openscreen http://127.0.0.1:47821/mcp --header "Authorization: Bearer <token>"

export OPENSCREEN_MCP_TOKEN=<token>
codex mcp add openscreen --url http://127.0.0.1:47821/mcp --bearer-token-env-var OPENSCREEN_MCP_TOKEN
```

For `openscreen mcp`, the client starts the executable itself:

```sh
claude mcp add openscreen -- "<executable>" mcp
codex mcp add openscreen -- "<executable>" mcp
```

## Known gaps

- **Two servers that ignore each other.** No connection gives an agent the whole loop: the in-app server edits the open project live but cannot record or export; `openscreen mcp` records and exports but refuses the project open in the app. Checkpoints are per process and never shared. Tracked in #1174.
- **No Ctrl+Z for edits to closed projects.** Their undo is the checkpoint the write requires, which lives in memory: it is gone once its server goes away or 20 newer ones push it out, and the edits stay.
- **An editor that stops answering looks closed.** A snapshot unanswered for 30 s reads as "no project open", so an edit naming the project that editor holds would go to its file, and the editor's next save would drop it. It takes a renderer hung for 30 s.
- **No project management.** Projects can be listed, read and edited, and `openscreen mcp` creates one per take; none can be renamed or deleted, and nothing imports media.
