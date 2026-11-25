import {
  CommandId,
  ChatAttachmentId,
  MessageId,
  OrchestrationV2Command,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type ChatImageAttachment,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AcpRegistryCatalog } from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { fuddyDefaultModel, fuddyTurnContexts } from "./FuddyTurnContext.ts";
import { OrchestrationEventStore } from "../persistence/OrchestrationEventStore.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ProviderAuthService } from "../provider/ProviderAuthService.ts";
import { ProviderInstallation } from "../provider/providerInstallation.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { ServerConfig } from "../config.ts";
import { chatAttachmentStableKey, createDeterministicAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";

const id = z.string().min(1).max(200);
const path = z.string().min(1).max(4096);
const driverByProvider = {
  codex: "codex", claude: "claudeAgent", cursor: "cursor", grok: "grok", fx: "fx",
  opencode: "opencode", antigravity: "antigravity", kiro: "kiro", pi: "pi", muse: "muse",
} as const;
const provider = z.string().refine(value => Object.hasOwn(driverByProvider, value) || /^acp-[a-zA-Z0-9_-]{1,60}$/u.test(value));
const nativeDefaults: Readonly<Record<string, string>> = {
  codex: fuddyDefaultModel, claude: fuddyDefaultModel, opencode: fuddyDefaultModel,
  cursor: "auto", grok: "grok-build", antigravity: "antigravity-default",
};
const selection = {
  provider,
  model: z.string().max(200).nullable(),
  effort: z.string().max(32).nullable(),
};
const image = z.object({
  path, name: z.string().min(1).max(255),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
});
const request = z.discriminatedUnion("type", [
  z.object({ type: z.literal("providers"), refresh: z.boolean().optional() }),
  z.object({ type: z.literal("acp-search"), query: z.string().trim().max(120) }),
  z.object({ type: z.literal("acp-add"), agentId: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/u) }),
  z.object({ type: z.literal("antigravity-setup"), operation: z.enum(["status", "install", "sign-in", "cancel-sign-in", "finish-sign-in"]),
    flowId: id.optional(), callbackUrl: z.string().trim().max(16_384).optional() }),
  z.object({
    type: z.literal("send"),
    threadId: id, requestId: id, title: z.string().min(1).max(500),
    cwd: path, nativeId: id.nullable(), prompt: z.string(),
    images: z.array(image).max(4).default([]),
    ...selection,
    context: z.object({
      instructions: z.string(),
      workspaceRoots: z.array(path),
      mcpServers: z.array(z.object({
        name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        command: path,
        args: z.array(z.string()),
        env: z.record(z.string(), z.string()).optional(),
      })),
      nativeImages: z.array(path),
    }),
  }),
  z.object({ type: z.literal("snapshot"), threadId: id, requestId: id }),
  z.object({ type: z.literal("steer"), threadId: id, requestId: id, parentRequestId: id,
    prompt: z.string(), images: z.array(image).max(4) }),
  z.object({ type: z.literal("steer-status"), threadId: id, requestId: id }),
  z.object({ type: z.literal("stop"), threadId: id, requestId: id }),
  z.object({
    type: z.literal("answer"), threadId: id, requestId: z.string().min(1).max(400),
    answers: z.record(z.string().min(1).max(400), z.union([
      z.string().max(4000), z.array(z.string().max(4000)).max(32),
    ])).nullable(),
  }),
]);
const envelope = z.object({ id: z.number().int().positive(), command: request });
const decodeCommand = Schema.decodeUnknownEffect(OrchestrationV2Command);
const provenance = { createdBy: "user", creationSource: "server" } as const;
const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const fuddyBridgeLayer = Layer.effectDiscard(Effect.gen(function* () {
  if (process.env.FUDDY_T3_BRIDGE !== "1" || typeof process.send !== "function") return;
  const startup = yield* ServerRuntimeStartup;
  const threads = yield* ThreadManagementService;
  const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
  const projects = yield* ProjectService;
  const events = yield* OrchestrationEventStore;
  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const providerAuth = yield* ProviderAuthService;
  const providerInstallation = yield* ProviderInstallation;
  const providerRegistry = yield* ProviderRegistry;
  const acpCatalog = yield* AcpRegistryCatalog;
  const active = new Set<string>();
  const send = (message: unknown) => {
    if (process.connected && process.send) process.send(message as object, () => {});
  };
  const dispatch = (command: unknown) =>
    decodeCommand(command).pipe(Effect.flatMap(threads.dispatch));
  const steerStatus = Effect.fnUntraced(function* (threadId: ThreadId, messageId: MessageId) {
    const projection = yield* threads.getThreadRecords(threadId, ["runs", "turnItems"], {
      messageIds: [messageId], turnItemTypes: ["user_message"],
    });
    const run = projection.runs.find(row => row.userMessageId === messageId);
    if (run) return { status: run.status === "cancelled" ? "cancelled" : "queued" };
    const item = projection.turnItems.find(row => row.type === "user_message" && row.messageId === messageId);
    if (!item) return { status: "missing" };
    if (item.status === "cancelled") return { status: "cancelled" };
    const delivery = Option.getOrUndefined(yield* effectOutbox.firstSteer(threadId, messageId))?.status;
    if (delivery === "failed" || delivery === "cancelled") return { status: "unknown" };
    if (delivery === "pending" || delivery === "running" || item.status === "pending") return { status: "pending" };
    return item.status === "completed" ? { status: "delivered", ordinal: item.ordinal } : { status: "unknown" };
  });

  const storeImages = (threadId: string, messageId: string, images: Array<z.infer<typeof image>>) =>
    Effect.tryPromise(async () => {
      if (images.length) await mkdir(config.attachmentsDir, { recursive: true, mode: 0o700 });
      const attachments: ChatImageAttachment[] = [];
      for (const [index, file] of images.entries()) {
        const metadata = await stat(file.path);
        if (!metadata.isFile() || metadata.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
          throw new Error("Image is outside the T3 attachment size limit.");
        }
        const bytes = await readFile(file.path);
        if (bytes.length !== metadata.size) throw new Error("Image changed before it was staged.");
        const id = createDeterministicAttachmentId(threadId, chatAttachmentStableKey(messageId, index, bytes));
        if (!id) throw new Error("Invalid attachment thread.");
        const attachment: ChatImageAttachment = {
          type: "image", id: ChatAttachmentId.make(id), name: file.name,
          mimeType: file.mimeType, sizeBytes: bytes.length,
        };
        const destination = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
        if (!destination) throw new Error("Invalid attachment path.");
        await writeFile(destination, bytes, { mode: 0o600 });
        attachments.push(attachment);
      }
      return attachments;
    });

  const runCommand = Effect.fnUntraced(function* (command: z.infer<typeof request>) {
    if (command.type === "antigravity-setup") {
      const target = { instanceId: ProviderInstanceId.make("antigravity") };
      const caller = "fuddy-desktop";
      if (command.operation === "install") yield* providerInstallation.start(target);
      if (command.operation === "sign-in") yield* providerAuth.start(target, caller);
      if (command.operation === "cancel-sign-in" && command.flowId) {
        yield* providerAuth.cancel({ ...target, flowId: command.flowId }, caller);
      }
      if (command.operation === "finish-sign-in" && command.flowId && command.callbackUrl) {
        yield* providerAuth.complete({ ...target, flowId: command.flowId, callbackUrl: command.callbackUrl }, caller);
      }
      const install = Option.getOrUndefined(yield* Stream.runHead(providerInstallation.subscribe(target)));
      const auth = Option.getOrUndefined(yield* Stream.runHead(providerAuth.subscribe(target, caller)));
      return {
        installPhase: install?.phase ?? "idle", authPhase: auth?.phase ?? "idle",
        installed: Boolean(install?.installedVersion), flowId: auth?.flowId ?? null,
        authorizationUrl: auth?.authorizationUrl ?? null,
      };
    }
    if (command.type === "providers") {
      const providers = yield* (command.refresh ? providerRegistry.rebuildMissingAndRefresh : providerRegistry.getProviders);
      const settings = yield* serverSettings.getSettings;
      const rows = providers.map(({ instanceId, displayName, message, installed, status, models }) => ({
        instanceId, displayName, message, installed, status, models,
      }));
      return [...rows, ...Object.entries(settings.providerInstances)
        .filter(([id, instance]) => instance.driver === "acpRegistry" && instance.enabled && !rows.some(row => row.instanceId === id))
        .map(([id, instance]) => ({ instanceId: id, displayName: instance.displayName, installed: false, status: "pending", models: [] }))];
    }
    if (command.type === "acp-search") {
      const result = yield* acpCatalog.search({ query: command.query });
      return result.agents.filter(agent => /^[a-zA-Z0-9_-]{1,60}$/u.test(agent.id))
        .map(({ id, name, description }) => ({ id, name, description }));
    }
    if (command.type === "acp-add") {
      const result = yield* acpCatalog.search({ query: command.agentId });
      const agent = result.agents.find(candidate => candidate.id === command.agentId);
      if (!agent) return yield* Effect.fail(new Error("ACP 注册表中找不到该 Agent。"));
      const instanceId = ProviderInstanceId.make(`acp-${agent.id}`);
      yield* serverSettings.updateProviderInstance({
        operation: "upsert", instanceId, instance: {
          driver: "acpRegistry", enabled: true, displayName: agent.name,
          config: { source: "registry", agentId: agent.id },
        },
      });
      return instanceId;
    }
    const threadId = ThreadId.make(command.threadId);
    if (command.type === "answer") {
      const requestId = RuntimeRequestId.make(command.requestId);
      const commandId = `fuddy:answer:${digest(JSON.stringify([requestId, command.answers]))}`;
      yield* dispatch(command.answers === null
        ? { type: "thread.user-input.dismiss", commandId, threadId, requestId }
        : { type: "runtime-request.respond", commandId, threadId, requestId, answers: command.answers });
      return null;
    }
    const messageId = MessageId.make(command.requestId);
    if (command.type === "steer-status") {
      return yield* steerStatus(threadId, messageId);
    }
    if (command.type === "steer") {
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      const parent = runs.find(row => row.userMessageId === command.parentRequestId);
      if (parent?.status !== "running") return false;
      const attachments = yield* storeImages(threadId, messageId, command.images);
      // Target the observed run explicitly. T3 owns native delivery and the
      // fallback to a follow-up if that run completes while the command arrives.
      return yield* dispatch({
        type: "message.dispatch", commandId: `fuddy:steer:${messageId}`, threadId, messageId,
        text: command.prompt, attachments, modelSelection: parent.modelSelection,
        dispatchMode: { type: "steer_active", targetRunId: parent.id },
        ...provenance,
      }).pipe(Effect.as(true), Effect.catchTag("OrchestratorDispatchError", () => Effect.succeed(false)));
    }
    if (command.type === "send") {
      const builtInDriver = Object.hasOwn(driverByProvider, command.provider)
        ? driverByProvider[command.provider as keyof typeof driverByProvider] : undefined;
      const instanceId = ProviderInstanceId.make(builtInDriver ?? command.provider);
      if (!builtInDriver) {
        const instance = (yield* serverSettings.getSettings).providerInstances[instanceId];
        if (instance?.driver !== "acpRegistry" || !instance.enabled) {
          return yield* Effect.fail(new Error("请先在执行 Mac 的 Agent 设置中添加这个 ACP Agent。"));
        }
      }
      active.add(threadId);
      const current = yield* threads.getThreadShell(threadId).pipe(
        Effect.catchTag("OrchestratorProjectionError", (error) => {
          const cause = error.cause as { _tag?: string } | undefined;
          return cause?._tag === "ProjectionStoreThreadNotFoundError"
            ? Effect.succeed(null)
            : Effect.fail(error);
        }),
      );
      const driver = builtInDriver ?? "acpRegistry";
      const model = command.model ?? nativeDefaults[command.provider] ?? "default";
      const catalog = command.effort ? yield* providerRegistry.getProviders : [];
      const models = catalog.find(item => item.instanceId === instanceId)?.models ?? [];
      const selected = models.find(item => item.slug === model) ?? (command.model === null ? models.find(item => item.isDefault) : undefined);
      const reasoning = selected?.capabilities?.optionDescriptors?.find(option => option.type === "select" && option.role === "reasoning");
      const optionId = reasoning?.id ?? (command.provider === "opencode" ? "variant" : "reasoningEffort");
      const modelSelection = { instanceId, model,
        ...(command.effort ? { options: [{ id: optionId, value: command.effort }] } : {}),
      };
      let projectId = current?.projectId;
      if (projectId === undefined) {
        const existing = yield* projects.getByWorkspaceRoot(command.cwd);
        const project = Option.isSome(existing) ? existing.value : yield* projects.bootstrap({
          commandId: CommandId.make(`fuddy:project:${digest(command.cwd)}`),
          projectId: ProjectId.make(`fuddy-${digest(command.cwd)}`),
          title: command.title,
          workspaceRoot: command.cwd,
        }).pipe(Effect.map((result) => result.project));
        projectId = project.id;
        yield* dispatch({
          type: "thread.create", commandId: `fuddy:thread:${threadId}`, threadId, projectId,
          ...provenance, title: command.title, titleRenamed: true, modelSelection,
          runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null,
          ...(command.nativeId ? {
            importedNativeThread: { ref: { driver, nativeId: command.nativeId, strength: "strong" } },
          } : {}),
        });
      } else {
        const known = yield* threads.getThreadRecords(threadId, ["runs"]);
        const existingRun = known.runs.find((run) => run.userMessageId === messageId);
        if (existingRun && terminal.has(existingRun.status)) return { runId: existingRun.id };
      }
      const instructionsPath = command.provider === "pi"
        ? join(config.attachmentsDir, `fuddy-context-${digest(threadId)}.txt`) : undefined;
      if (instructionsPath) yield* Effect.tryPromise(async () => {
        await mkdir(config.attachmentsDir, { recursive: true, mode: 0o700 });
        await writeFile(instructionsPath,
          command.context.instructions + "\n\nAdditional workspace roots: " + JSON.stringify(command.context.workspaceRoots),
          { mode: 0o600 });
      });
      fuddyTurnContexts.set(threadId, { ...command.context, ...(instructionsPath ? { instructionsPath } : {}) });
      if (current) {
        const known = yield* threads.getThreadRecords(threadId, ["runs"]);
        const existingRun = known.runs.find(run => run.userMessageId === messageId);
        if (existingRun) return { runId: existingRun.id };
      }
      const attachments = command.provider === "codex"
        ? [] : yield* storeImages(threadId, messageId, command.images);
      const result = yield* threads.sendToThread({
        threadId, projectId, commandId: CommandId.make(`fuddy:send:${messageId}`), messageId,
        text: command.prompt, attachments, modelSelection, mode: "queue", ...provenance,
        ...(current && command.nativeId === null ? { freshContext: true } : {}),
      });
      return { runId: result.run.id };
    }
    if (command.type === "snapshot") {
      const { snapshotSequence, projection } = yield* threads.getThreadSnapshot(threadId);
      const run = projection.runs.find((row) => row.userMessageId === messageId);
      if (!run) return { sequence: snapshotSequence, run: null, items: [], nativeId: null };
      const attempt = projection.attempts.find((row) => row.id === run.activeAttemptId);
      const native = projection.providerThreads.find((row) => row.id === run.providerThreadId);
      if (terminal.has(run.status) && !projection.runs.some(row => !terminal.has(row.status))) {
        active.delete(threadId);
        const instructionsPath = fuddyTurnContexts.get(threadId)?.instructionsPath;
        if (instructionsPath) yield* Effect.tryPromise(() => rm(instructionsPath, { force: true })).pipe(Effect.ignore);
        fuddyTurnContexts.delete(threadId);
      }
      return {
        sequence: snapshotSequence,
        run: { id: run.id, status: run.status, attemptId: attempt?.id ?? null },
        items: projection.turnItems.filter((item) => item.runId === run.id).sort((a, b) => a.ordinal - b.ordinal),
        nativeId: native?.nativeThreadRef?.nativeId ?? null,
        canSteer: run.status === "running" && projection.providerTurns.some(
          turn => turn.status === "running" && turn.runAttemptId === run.activeAttemptId &&
            turn.nodeId === run.rootNodeId,
        ) && projection.providerSessions.some(session => session.id === native?.providerSessionId &&
          (session.capabilities.turns.supportsActiveSteering || session.capabilities.turns.supportsSteeringByInterruptRestart)),
      };
    }
    const target = yield* threads.getThreadRecords(threadId, ["runs"]);
    const run = target.runs.find((row) => row.userMessageId === messageId);
    if (!run) return null;
    yield* dispatch({
      type: "run.interrupt", commandId: `fuddy:stop:${messageId}`, threadId, runId: run.id,
    });
    return null;
  });

  yield* Effect.gen(function* () {
    yield* startup.awaitCommandReady;
    const settings = yield* serverSettings.getSettings;
    for (const { driverKind: driver } of BUILT_IN_DRIVERS) {
      if (driver === "acpRegistry") continue;
      const instanceId = ProviderInstanceId.make(driver);
      const instance = settings.providerInstances[instanceId];
      if (instance?.enabled === true) continue;
      yield* serverSettings.updateProviderInstance({
        operation: "upsert", instanceId,
        instance: { ...instance, driver, enabled: true },
      });
    }
    const sequence = yield* events.latestApplicationSequence;
    yield* events.streamProjectedApplicationEvents({
      afterSequence: sequence,
      project: (event) => ({
        sequence: event.sequence,
        threadId: "event" in event ? event.event.threadId : null,
      }),
    }).pipe(
      Stream.runForEach(({ threadId, sequence }) => Effect.sync(() => {
        if (threadId && active.has(threadId)) send({ type: "changed", threadId, sequence });
      })),
      Effect.forkScoped,
    );
    const run = yield* Effect.context<never>().pipe(Effect.map((context) => Effect.runPromiseWith(context)));
    const onMessage = (raw: unknown) => {
      const parsed = envelope.safeParse(raw);
      if (!parsed.success) return;
      const { id, command } = parsed.data;
      void run(runCommand(command)).then(
        (result) => send({ type: "result", id, result }),
        (error) => send({ type: "error", id, message: error instanceof Error ? error.message : String(error) }),
      );
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.on("message", onMessage);
        send({ type: "ready", version: 1 });
      }),
      () => Effect.sync(() => { process.off("message", onMessage); }),
    );
    yield* Effect.never;
  }).pipe(Effect.forkScoped);
})).pipe(Layer.provide(EffectOutbox.layer));
