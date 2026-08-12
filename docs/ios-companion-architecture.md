# iOS Companion architecture

## Decision

Build the companion as a native SwiftUI app. Keep every Agent runtime, shell command, database connection, project credential, and workspace mutation on the Mac. The iPhone owns presentation, a read cache, attachment previews, and a constrained command queue.

React Native is technically viable: React Navigation's Native Stack uses `UINavigationController` on iOS and supports native headers, large titles, search bars, gestures, and form sheets. It is not the preferred choice here because this client is iOS-only and its highest-risk surfaces—APNs background delivery, Keychain, Quick Look, file caching, and platform navigation—are already native. A React Native layer would mainly reuse TypeScript types, not the Electron UI or main-process services. See [React Navigation Native Stack](https://reactnavigation.org/docs/native-stack-navigator/).

## Runtime topology

```mermaid
flowchart LR
  Phone["SwiftUI iPhone app\nread cache + commands"]
  Relay["Cloudflare Worker\nauth + API boundary"]
  DO["Durable Object per pairing\nevent log + command queue + WebSocket"]
  R2["Private R2 bucket\nattachments"]
  APNS["Apple Push Notification service\nbackground wake-up + Run alerts"]
  Mac["Electron Mac app\nSQLite outbox + Agent runtimes"]
  Workspaces["Project workspace roots\nDBs + files + coding agents"]

  Phone <-->|"HTTPS / foreground WebSocket"| Relay
  Relay <--> DO
  Relay <--> R2
  DO -. "silent wake-up / visible Run alert" .-> APNS
  APNS -.-> Phone
  Mac <-->|"HTTPS / WebSocket"| Relay
  Mac <--> Workspaces
```

The deployed relay is `https://project-agent-companion-relay.moghub.workers.dev`. It uses one Durable Object per random account/pairing ID, the Hibernation WebSocket API, SQLite-backed ordered events and commands, and a private R2 bucket. Cloudflare recommends Hibernation because the object can sleep while clients remain connected: [Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

## Consistency model

The Mac database is authoritative.

1. A Mac mutation writes the application record and a `companion_sync_outbox` event to local SQLite.
2. `CompanionSyncService` reads pending events in insertion order and uploads them in batches of at most 100 events / 512 KiB. Each batch is authenticated once and written by one Durable Object SQLite transaction; failed events remain in the outbox with attempt count and error.
3. The Durable Object assigns a monotonic sequence number and broadcasts the event.
4. iOS asks for `events?after=<lastSequence>`, applies idempotent upserts, then atomically saves its cache.
5. A phone action creates a command with a client UUID. The Mac stores that command before execution, so reconnects cannot execute a terminal command twice. Every command transition is monotonic, and each update is also persisted to the ordered event log so an offline phone can recover completion or failure.
6. Mac execution writes normal application mutations, which return through the same outbox as evidence of the result.

The WebSocket is a wake-up hint, not the source of truth. A committed batch emits one content-free `sync.available(lastSequence)` hint, and both clients replay the ordered HTTP event log after reconnecting, on launch or foreground activation, and when the user refreshes. While connected, Mac and foreground iOS use a five-minute replay fallback; while disconnected they return to a 60-second fallback. Both clients send an application-level heartbeat every 20 seconds; one missed `pong` discards the stale socket and starts the 5, 15, then 60-second reconnect backoff instead of leaving a half-open connection marked as healthy. When iOS enters the background it explicitly cancels the fallback timer and closes the socket; foreground activation reconnects and immediately replays from the last persisted sequence.

Mac keeps complete Agent tool output only in its authoritative local database. Snapshot and incremental Relay payloads retain the tool name and terminal status, normalize whitespace, remove native metadata/arguments, and cap the displayed summary at 600 characters. User messages, assistant answers, and provider-supported reasoning summaries continue to replay normally; raw private chain-of-thought is never part of the protocol.

Each event page and WebSocket presence frame also carries current Durable Object presence. The iPhone updates presence directly from `sync.ready` and `presence.updated`, and distinguishes “Relay unreachable” from “Relay connected but Mac offline”; commands may still be queued in the second state and will execute when the Mac reconnects. The Mac settings UI reports HTTP replay and realtime WebSocket health separately so a successful replay cannot hide a stale socket.

## Pairing and authentication

- Mac requests an account ID, a one-time pairing secret, and a Mac bearer token.
- The pairing secret expires after ten minutes and can be claimed once.
- Mac renders the complete pairing payload as a QR code. iOS scans it with VisionKit's native `DataScannerViewController`, validates an HTTPS Relay origin, and claims it without retyping secrets; Universal Clipboard paste remains the fallback.
- iOS stores its bearer token in Keychain with `AfterFirstUnlockThisDeviceOnly`; Mac stores its token in the existing encrypted credential vault/macOS Keychain path.
- Durable Object storage contains only SHA-256 token hashes. Tokens and pairing secrets are never logged or stored in SQLite on the Mac.
- Every account/device operation requires account ID, device ID, and bearer token. Role checks ensure only Mac can append authoritative events or complete commands, while only iOS can create commands.
- Disconnecting from the Mac revokes every paired device, clears the Durable Object event/command data, closes sockets, and deletes that account's R2 objects. A stale phone token receives `401` afterward.

Current transport is HTTPS and private Cloudflare storage. Before distributing the app beyond trusted personal devices, add application-layer end-to-end encryption so Cloudflare stores opaque event and attachment ciphertext, plus abuse protection or authenticated account creation on the public pairing endpoint.

The current personal-device MVP retains ordered events, terminal commands, and R2 attachments until the Mac disconnects the account. Before long-lived multi-user rollout, add per-device replay acknowledgements, snapshot compaction, and attachment retention/garbage collection; deleting history without an acknowledged snapshot would create silent gaps for an offline phone.

## Foreground and background delivery

While iOS is active, `URLSessionWebSocketTask` receives immediate event notifications and the app replays the event log. A WebSocket is not a reliable suspended-app channel. The relay therefore sends a collapsed, content-free background notification only to iOS devices without an active socket. iOS then fetches the event log; invalid or unregistered APNs tokens are removed after provider rejection.

Each terminal Agent turn adds one `agent-turn.settled` event after the Run transitions from `running` to `idle` or `failed`. Its stable turn ID is the triggering user-message ID, so Relay retries remain idempotent. The Mac displays a local notification; Relay converts the same event into an APNs alert for every registered iPhone, including a foreground device. The alert contains only the Run title, Run ID, turn ID, and replay sequence. Tapping it replays events and opens the matching Run; full messages and tool output never enter the APNs payload. User-initiated stops intentionally do not produce a completion alert.

Apple explicitly treats background notifications as low priority and does not guarantee delivery; they can be throttled. Therefore the app always refreshes on foreground entry and manual pull-to-refresh as well. See [Pushing background updates to your app](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app).

APNs requires an Apple Developer team and a `.p8` key. The non-secret Team ID, Key ID, topic, and APNs environment live in `cloud/relay/wrangler.jsonc`; only the private key is stored as a Cloudflare Worker secret:

```bash
cd cloud/relay
npx wrangler secret put APNS_PRIVATE_KEY
```

Set `APNS_ENVIRONMENT` to `development` for locally signed development builds and change it to `production` before deploying a Relay used by TestFlight/App Store builds. The APNs key itself supports both environments. Without the required private-key secret, deployment is rejected; foreground realtime and ordered replay do not depend on APNs.

## Images and attachments

Agent-generated files already become `AgentRunArtifact` records on Mac. Work Assistant image attachments use the same transport instead of syncing their inline `data:` URLs. During sync:

1. Mac first resolves project artifacts inside the registered project file space, then falls back to the Run working directory for coding-Agent artifacts; both paths enforce containment and reject missing files, directories, and traversal attempts.
2. Files up to 100 MiB are streamed to a private R2 object under the account ID. The initial pairing snapshot uploads existing Run artifacts too, so historical Sessions are not display-only.
3. The event contains filename, MIME type, size, SHA-256, and artifact linkage; it never exposes a local Mac path as a downloadable URL.
4. iOS downloads with its device token, verifies the expected byte length and SHA-256 before moving the file into Caches, and opens the local file with Quick Look. Image, PDF, text, and video types use native previews.

The initial pairing snapshot still uploads descriptors and bytes for historical artifacts. If an artifact descriptor is missing later, the Session's “信息与文件” Modal sends the persisted `artifact.request-upload` command. An online Mac resolves and streams that one file, then returns its verified descriptor through the durable `command.updated` event; WebSocket delivery is only the fast wake-up path and ordered replay remains the fallback. The chat timeline itself does not duplicate the artifact list.

The local path remains visible only as descriptive metadata. R2 objects are not public and cannot be enumerated without a valid paired device token. iOS preserves the original filename extension in its private cache so Quick Look can select the correct native previewer.

## Native application structure

- `CompanionStore`: main-actor state, event reducer, command methods, polling, and atomic offline cache.
- `RelayClient`: pairing, authenticated REST calls, WebSocket wake-ups, push-token registration, and attachment downloads.
- `KeychainStore`: device credentials.
- `WorkAssistantView`: the cross-project assistant timeline and constrained remote message command.
- `RunsListView` / `RunDetailView`: persistent Session list and native chat UI; active runs show a spinner; tool calls use collapsed `DisclosureGroup` rows; Session metadata and artifacts live in the top-right “信息与文件” Modal instead of the message timeline.
- `DecisionListView`: inbox and constrained status commands.
- `ProjectDetailView`: project status, goals, progress, and milestones from the same Mac snapshot/event log.
- `ArtifactRow`: authenticated download and `QLPreviewController` presentation.
- `CompanionAppDelegate`: APNs authorization, device-token registration, foreground presentation, background update, and notification-to-Run navigation bridge.

The deployment target is iOS 17. The project is generated with XcodeGen from `ios/project.yml` so target settings and file membership remain reviewable.

## What is shared with the Mac app

| Area | Reuse |
| --- | --- |
| Domain meaning and wire protocol | Shared conceptually; TypeScript and Swift have matching versioned Codable contracts |
| Cloud relay API | Fully shared by both clients |
| SQLite schema and Electron services | Mac only; iOS has a deliberately smaller JSON read cache |
| React components and CSS | Not reused |
| Agent runtime adapters, zsh environment, workspace tools | Mac only |
| Product terminology, information hierarchy, visual behavior | Reimplemented natively in SwiftUI |
| Attachments | Shared object metadata and R2 bytes; Mac uploads, iOS caches/previews |

Generating Swift models from a language-neutral JSON Schema is the next maintainability improvement. Runtime code should not be shared merely to avoid duplicating small models; execution authority must remain visibly separated.

## Build and verification

```bash
# Cloud relay
npm --prefix cloud/relay run typecheck
npm --prefix cloud/relay test
npm --prefix cloud/relay run smoke

# Regenerate iOS project
brew install xcodegen
npm run ios:generate

# Swift 6 typecheck for the app and XCTest sources; this works before accepting
# the local Xcode license because it invokes the installed toolchain directly.
npm run ios:typecheck

# Build and run XCTest after accepting the local Xcode license and installing an
# iOS Simulator runtime. Keep local ad-hoc signing enabled: the Keychain APIs used
# by pairing require the generated application identifier entitlement.
cd ios
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -project ProjectAgentCompanion.xcodeproj \
  -scheme ProjectAgentCompanion \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  build

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild test \
  -project ProjectAgentCompanion.xcodeproj \
  -scheme ProjectAgentCompanion \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

Device/APNs verification additionally requires selecting an Apple Developer team, enabling Push Notifications for the app identifier, and installing a development provisioning profile.
