# Project Agent Repository Guide

## Product intent

Project Agent is a macOS Electron app for operating several real projects through one work assistant, a decision inbox, project goals, automation, files, and persistent Agent Run sessions. Preserve the product's conversation-first, evidence-backed design. Do not turn it into a generic kanban board or a dashboard of unsupported metrics.

The current product language is primarily Chinese. Keep UI copy concise, direct, and consistent with the existing terminology in `README.md`.

## Repository layout

- `src/main/`: Electron main process, SQLite services, Agent runtimes, connectors, schedulers, credentials, IPC registration, and Sentry integration.
- `src/preload/`: the typed, sandbox-safe bridge exposed to the Renderer.
- `src/renderer/`: React UI and styles. The Renderer must not access Node.js directly.
- `src/shared/`: domain contracts and helpers shared across process boundaries.
- `prompts/`: versioned prompts used by product workflows.
- `scripts/`: local metrics and third-party tool preparation scripts.
- `docs/` and `design/`: examples and visual references.
- `cloud/relay/`: Cloudflare Worker, one Durable Object per paired account, WebSocket/event protocol, command queue, and private R2 attachment transport.
- `ios/`: native SwiftUI iPhone companion generated from `ios/project.yml`; it is a client and never executes project tools locally.

## Development commands

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
npm run relay:typecheck
npm run relay:test
```

Regenerate the iOS project with `cd ios && xcodegen generate`. Use `/Applications/Xcode.app` through `DEVELOPER_DIR` for builds; accepting the Xcode license and selecting an Apple Developer team are user-owned legal/account steps.

Use `npm run prepare:agent-tools` before packaging or running the optional Browser Use / Computer Use smoke tests. The integration smoke tests are opt-in because they require installed local tools and live authentication:

```bash
RUN_AGENT_TOOLS_SMOKE=1 npx vitest run src/main/services/third-party-mcp-runtime.integration.test.ts
RUN_CODING_CLI_SMOKE=1 npx vitest run src/main/services/coding-cli.integration.test.ts
RUN_COMPANION_RELAY_SMOKE=1 npx vitest run src/main/services/companion-sync.integration.test.ts
```

## Implementation invariants

### Electron boundaries

- Keep `contextIsolation` and the sandboxed Renderer. Add privileged behavior in the main process and expose the smallest typed API through `src/preload/index.ts` and `DesktopApi`.
- Validate every IPC payload in `src/main/ipc.ts` with Zod before calling a service.
- Update shared contracts, preload wiring, IPC validation, service behavior, and tests together when an IPC API changes.
- Never put credentials in Renderer state, SQLite records, logs, fixtures, or documentation. Use the credential vault / macOS Keychain.

### Agent Runs

- Agent Run is one unified session model. Do not reintroduce a Coding / General mode split; Pi, Codex, Claude Code, and OpenCode are providers of the same Run abstraction.
- Creating a Session creates a `draft`. Do not send a first message from the creation page. The chat composer owns message submission.
- Decision Inbox “去处理” creates the Session immediately, opens its chat, and prefills the suggested prompt without sending it.
- Persist the external runtime's native Session ID and resume it for subsequent messages.
- Run external Agents in the project's primary Workspace Root. Supply all additional Workspace Roots and the project file directory as accessible directories.
- A project-bound Run must never silently fall back to the app repository or another arbitrary directory. Require a configured Workspace Root.
- Project Agents should inspect the target project's `AGENTS.md`, README, scripts, data model, and Skills before making project-specific claims. Database or production claims require real evidence.
- The built-in Pi harness may update project configuration through the constrained project update tool; external Agents receive the project MCP server for the same purpose.

### Local Coding Agents

- Preserve each CLI's native account, provider, and default configuration. Do not inject CC Switch configuration into Codex, Claude Code, or OpenCode.
- The app hydrates `process.env` from an interactive zsh at startup so GUI launches inherit the user's terminal environment. Do not edit `.zshrc`, do not filter its exported Agent variables, and do not log their values.
- Pass an explicit model argument only when the user selected a model in Coding Agents settings. An empty model means “use this Agent's own default.”
- Keep the global default Coding Agent for entry points that do not explicitly choose a provider. Project defaults and per-Run overrides remain valid.
- Current product policy is Full Access with automatic approval for all Agent providers. Use each provider's exact supported parameters; Codex app-server uses `danger-full-access` for thread sandbox and `dangerFullAccess` for the structured turn policy.
- Do not collapse provider-specific adapters into guessed common CLI flags. Add focused argument and stream parsing tests for each runtime.

### Product data and evidence

- User-confirmed project state outranks Agent inference and repository evidence.
- Repository state proves engineering capability, not production users, revenue, conversion, or operational health.
- Keep production analytics fixed, aggregate, read-only, and versioned. Never let a model generate arbitrary SQL for a production connector.
- A missing connector or failed query is unknown state, not evidence that a problem is resolved.
- Keep Decision Inbox deduplication based on stable issue lifecycles, not dates or repeated wording.

### iOS Companion and Cloud relay

- The Mac database is authoritative. Persist outgoing mutations to `companion_sync_outbox` before network delivery, and treat WebSocket frames as wake-up hints followed by ordered event replay.
- Execute phone actions only through constrained, versioned command types. Persist command IDs on Mac before execution and never run the same terminal command twice.
- Keep Agent runtimes, project paths, database credentials, shell environment, and tool execution on Mac. iOS may cache display data and attachment bytes but must not receive local credentials.
- Keep device bearer tokens in Keychain/credential vault and only token hashes in Durable Object storage. Never place pairing secrets or tokens in logs.
- Mac disconnect must revoke the remote account and remove its Durable Object/R2 data; deleting only the local token leaves stale phone access and is not sufficient.
- Attachments belong in the private R2 binding. Resolve artifact paths inside the Run workspace, validate size, record SHA-256/MIME metadata, and require paired-device auth for download.
- A new pairing snapshot must upload descriptors and bytes for existing artifacts as well as future artifact events; otherwise the phone can render old Runs but cannot open their files.
- Foreground realtime uses the Hibernation WebSocket API. Suspended iOS delivery requires APNs and must always fall back to event replay on foreground because silent pushes are not guaranteed.
- Treat application-layer end-to-end encryption and abuse protection for the public pairing endpoint as release gates before untrusted multi-user distribution.

### UI conventions

- The main area should carry one primary task. Agent Run details use the full chat layout with the Session list in the sidebar.
- In Session lists, show a spinner only while running; completed and failed sessions do not need status icons or a “current” label.
- Tool activity is collapsed by default and emphasizes the latest active call. Keep reasoning summaries readable without exposing unsupported private chain-of-thought data.
- Session rename and archive belong in the three-dot menu in both list and detail contexts.
- Temporary success and error notices dismiss after five seconds unless the user must act on them.
- Preserve Light / Dark mode behavior, portal dropdowns, keyboard access, and the resizable sidebar when changing layout styles.

## Testing and completion

- Add or update unit tests for parsing, IPC-facing service behavior, provider arguments, persistence migrations, timeouts, and environment handling.
- Run `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check` before handing off code.
- Optional live integration tests must not be treated as unit tests and must not run by default.
- Do not claim an Agent task, database change, or deployment succeeded unless the relevant runtime or service returned evidence.

## Working-tree discipline

- Preserve unrelated user changes in a dirty worktree.
- Use `rg` / `rg --files` for search and `apply_patch` for manual edits.
- Do not change shell startup files, local Agent config, credentials, or user project repositories unless the user explicitly requests it.
- Do not commit or push unless the user asks. When asked to push all changes, review the final diff, run the full checks, and report the commit and remote branch.
- Keep `README.md` current when product behavior, Agent runtime policy, setup steps, or major workflow status changes.
