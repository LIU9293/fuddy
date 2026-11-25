import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkout = process.argv[2]
if (!checkout) throw new Error('Pass the path of the pinned T3 Code checkout.')
const source = fileURLToPath(new URL('../vendor/t3-code/', import.meta.url))
const runtime = join(checkout, 'apps/server/src/orchestration-v2')
const providerCore = join(checkout, 'packages/provider-core/src/server')
const openCode = join(checkout, 'packages/provider-opencode/src/server')
copyFileSync(join(source, 'FuddyBridge.ts'), join(runtime, 'FuddyBridge.ts'))
copyFileSync(join(source, 'FuddyTurnContext.ts'), join(providerCore, 'FuddyTurnContext.ts'))
copyFileSync(join(source, 'FuddyProjectTool.ts'), join(checkout, 'apps/server/src/mcp/toolkits/FuddyProjectTool.ts'))
writeFileSync(join(runtime, 'FuddyTurnContext.ts'), 'export * from "../../../../packages/provider-core/src/server/FuddyTurnContext.ts";\n')

function patchFile(path, edits) {
  let content = readFileSync(path, 'utf8')
  for (const [before, after] of edits) {
    if (content.includes(after)) continue
    if (content.split(before).length !== 2) throw new Error(`T3 Code source changed: ${path}\n${before}`)
    content = content.replace(before, () => after)
  }
  writeFileSync(path, content)
}

patchFile(join(checkout, 'apps/server/src/server.ts'), [
  [
    'const layerMakeServer = Layer.unwrap(',
    'import { fuddyBridgeLayer } from "./orchestration-v2/FuddyBridge.ts";\n\nconst layerMakeServer = Layer.unwrap('
  ],
  [
    '      layerDesktopReadySignal,\n      layerRuntimeState',
    '      layerDesktopReadySignal,\n      fuddyBridgeLayer,\n      layerRuntimeState'
  ]
])

patchFile(join(checkout, 'apps/server/src/mcp/McpHttpServer.ts'), [
  [
    'import * as ProjectHandlers from "./toolkits/project/handlers.ts";',
    'import * as ProjectHandlers from "./toolkits/project/handlers.ts";\nimport * as FuddyProjectTool from "./toolkits/FuddyProjectTool.ts";'
  ],
  [
    '  layerProjectRegistration,\n  layerFeedbackToolkit,',
    '  layerProjectRegistration,\n  toolkitRegistration(FuddyProjectTool.toolkit, FuddyProjectTool.handlers),\n  layerFeedbackToolkit,'
  ]
])

patchFile(join(runtime, 'Adapters/CodexAdapterV2.ts'), [
  [
    'export const CODEX_THREAD_CONFIG = {',
    'import { fuddyDefaultModel, fuddyTurnContexts } from "../FuddyTurnContext.ts";\n\nexport const CODEX_THREAD_CONFIG = {'
  ],
  [
    '  const { mcpSession } = input;\n  const t3Server =',
    '  const { mcpSession } = input;\n  const fuddy = input.threadId == null ? undefined : fuddyTurnContexts.get(input.threadId);\n  const t3Server ='
  ],
  [
    '    mcpSession === undefined\n      ? undefined\n      : {\n          url: mcpSession.endpoint,',
    '    mcpSession === undefined || fuddy !== undefined\n      ? undefined\n      : {\n          url: mcpSession.endpoint,'
  ],
  [
    '  readonly config: Readonly<Record<string, Schema.Json>>;\n} {\n  const { mcpSession }',
    '  readonly config: Readonly<Record<string, Schema.Json>>;\n  readonly developerInstructions?: string;\n  readonly runtimeWorkspaceRoots?: string[];\n  readonly sandbox?: "danger-full-access";\n  readonly approvalPolicy?: "never";\n} {\n  const { mcpSession }'
  ],
  [
    '    ...(input.modelSelection === undefined ? {} : { model: input.modelSelection.model }),\n    config: {\n      ...CODEX_THREAD_CONFIG,',
    `    ...(input.modelSelection === undefined || input.modelSelection.model === fuddyDefaultModel
      ? {} : { model: input.modelSelection.model }),
    ...(fuddy ? {
      developerInstructions: fuddy.instructions,
      runtimeWorkspaceRoots: [...fuddy.workspaceRoots],
      sandbox: "danger-full-access" as const,
      approvalPolicy: "never" as const,
    } : {}),
    config: {
      ...CODEX_THREAD_CONFIG,
      ...Object.fromEntries((fuddy?.mcpServers ?? []).map((server) => [
        \`mcp_servers.\${server.name}\`, {
          command: server.command, args: [...server.args], ...(server.env ? { env: server.env } : {}),
        },
      ])),`
  ],
  [
    '      model: input.modelSelection.model,\n      // Catalogues can default',
    '      ...(input.modelSelection.model === fuddyDefaultModel ? {} : { model: input.modelSelection.model }),\n      // Catalogues can default'
  ],
  [
    '      collaborationMode: {\n        mode: input.runtimePolicy.interactionMode,\n        settings: {\n          model: input.modelSelection.model,\n          ...(effort === undefined ? {} : { reasoning_effort: effort }),\n        },\n      },',
    '      ...(input.modelSelection.model === fuddyDefaultModel ? {} : { collaborationMode: {\n        mode: input.runtimePolicy.interactionMode,\n        settings: {\n          model: input.modelSelection.model,\n          ...(effort === undefined ? {} : { reasoning_effort: effort }),\n        },\n      } }),'
  ],
  [
    '            const turnStartParams = yield* buildCodexTurnStartParams({\n              cyberAccess:',
    '            const fuddy = fuddyTurnContexts.get(turnInput.threadId);\n            const turnStartParams = yield* buildCodexTurnStartParams({\n              cyberAccess:'
  ],
  [
    '              codexInput,\n              runtimePolicy: turnInput.runtimePolicy,\n              modelSelection: turnInput.modelSelection,\n              hasT3Mcp: mcpSession !== undefined,',
    `              codexInput: [...codexInput, ...(fuddy?.nativeImages ?? []).map((path) => ({ type: "localImage" as const, path }))],
              runtimePolicy: fuddy ? { ...turnInput.runtimePolicy, approvalPolicy: "never" } : turnInput.runtimePolicy,
              modelSelection: turnInput.modelSelection,
              hasT3Mcp: mcpSession !== undefined && fuddy === undefined,`
  ],
  [
    '            const started = yield* client\n              .request("turn/start", turnStartParams)',
    `            const started = yield* client
              .request("turn/start", fuddy ? {
                ...turnStartParams,
                additionalContext: {
                  ...turnStartParams.additionalContext,
                  fuddy_project: { kind: "application", value: fuddy.instructions },
                },
              } : turnStartParams)`
  ]
])

patchFile(join(runtime, 'Adapters/ClaudeAdapterV2.ts'), [
  [
    'export function makeClaudeQueryOptions(input: {\n  readonly modelSelection',
    'import { fuddyContextFingerprint, fuddyDefaultModel, fuddyTurnContexts, type FuddyTurnContext } from "../FuddyTurnContext.ts";\n\nexport function makeClaudeQueryOptions(input: {\n  readonly fuddyContext?: FuddyTurnContext;\n  readonly modelSelection'
  ],
  [
    '  const options: ClaudeAgentSdkQueryOptions = {\n    model: compiledSelection.apiModelId,',
    `  const fuddyContext = input.fuddyContext;
  const options: ClaudeAgentSdkQueryOptions = {
    ...(input.modelSelection.model === fuddyDefaultModel ? {} : { model: compiledSelection.apiModelId }),
    ...(fuddyContext ? {
      settingSources: ["user", "project", "local"],
      mcpServers: Object.fromEntries(fuddyContext.mcpServers.map((server) => [server.name, {
        type: "stdio", command: server.command, args: [...server.args], ...(server.env ? { env: server.env } : {}),
      }])),
    } : {}),`
  ],
  [
    '        ...launchAppendSystemPrompt,\n      ].join',
    '        ...(fuddyContext ? [fuddyContext.instructions] : []),\n        ...launchAppendSystemPrompt,\n      ].join'
  ],
  [
    '    ...claudeLaunchArgDirectories(input.settings?.launchArgs),\n  ];',
    '    ...claudeLaunchArgDirectories(input.settings?.launchArgs),\n    ...(fuddyContext?.workspaceRoots ?? []),\n  ];'
  ],
  [
    '          const mcpSession = yield* mcpSessions.read(turnInput.threadId);\n          // Claude Code defers',
    '          const fuddyContext = fuddyTurnContexts.get(turnInput.threadId);\n          const mcpSession = fuddyContext ? undefined : yield* mcpSessions.read(turnInput.threadId);\n          // Claude Code defers'
  ],
  [
    '          const queryPolicyKey = claudeEffectiveQueryPolicyKey(\n            queryPolicy,\n            mcpOverrides,\n            turnInput.runtimePolicy.workspace,\n          );',
    '          const queryPolicyKey = claudeEffectiveQueryPolicyKey(\n            queryPolicy,\n            mcpOverrides,\n            turnInput.runtimePolicy.workspace,\n          ) + (fuddyContext ? fuddyContextFingerprint(fuddyContext) : "");'
  ],
  [
    '          const queryOptions = makeClaudeQueryOptions({\n            agentFeedback:',
    '          const queryOptions = makeClaudeQueryOptions({\n            ...(fuddyContext ? { fuddyContext } : {}),\n            agentFeedback:'
  ]
])

// Remove the old compatibility override from existing managed source checkouts.
const openCodeDriverPath = join(openCode, 'driver.ts')
const openCodeDriver = readFileSync(openCodeDriverPath, 'utf8')
const previousOpenCodeOverride = '  // Fuddy registers workspace MCP processes on the isolated OpenCode v1 server.\n  if (process.env.FUDDY_T3_BRIDGE === "1") return input.v1;\n'
if (openCodeDriver.includes(previousOpenCodeOverride)) {
  writeFileSync(openCodeDriverPath, openCodeDriver.replace(previousOpenCodeOverride, ''))
}

patchFile(join(openCode, 'v2/adapter.ts'), [
  [
    'import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";',
    'import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";\nimport { fuddyDefaultModel, fuddyTurnContexts } from "../../../../provider-core/src/server/FuddyTurnContext.ts";'
  ],
  [
    '      const instructions = [\n        buildRuntimeInstructions(',
    '      const context = fuddyTurnContexts.get(turnInput.threadId);\n      const instructions = [\n        context?.instructions,\n        context ? "Additional workspace roots: " + JSON.stringify(context.workspaceRoots) : undefined,\n        buildRuntimeInstructions('
  ],
  [
    '          if (model === undefined) {\n            return yield* new ProviderAdapter.ProviderAdapterProtocolError({\n              driver: OPENCODE_PROVIDER,\n              detail: malformedModel(threadInput.modelSelection.model),',
    '          if (model === undefined && threadInput.modelSelection.model !== fuddyDefaultModel) {\n            return yield* new ProviderAdapter.ProviderAdapterProtocolError({\n              driver: OPENCODE_PROVIDER,\n              detail: malformedModel(threadInput.modelSelection.model),'
  ],
  [
    '            location: Location.PublicRef.make({ directory: AbsolutePath.make(directory) }),\n            model,\n            permissions,',
    '            location: Location.PublicRef.make({ directory: AbsolutePath.make(directory) }),\n            ...(model === undefined ? {} : { model }),\n            permissions,'
  ],
  [
    '              if (model === undefined) {\n                yield* begin;',
    '              if (model === undefined && turnInput.modelSelection.model !== fuddyDefaultModel) {\n                yield* begin;'
  ],
  [
    '              if (!sameModel(model, state.model)) {\n                yield* client.session.switchModel(',
    '              if (model !== undefined && !sameModel(model, state.model)) {\n                yield* client.session.switchModel('
  ]
])

patchFile(join(checkout, 'packages/provider-acp/src/server/adapter.ts'), [
  [
    'import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";',
    'import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";\nimport { fuddyTurnContexts } from "../../../provider-core/src/server/FuddyTurnContext.ts";'
  ],
  [
    '            Effect.map((session) =>\n              acpMcpContext(session, self, flavor.mcpOverHttp, flavor.deferMcpTools, callLauncher),\n            ),',
    `            Effect.map((session) => {
              const upstream = acpMcpContext(session, self, flavor.mcpOverHttp, flavor.deferMcpTools, callLauncher);
              const context = fuddyTurnContexts.get(threadId);
              if (!context) return upstream;
              return { ...upstream, servers: [...upstream.servers, ...context.mcpServers.map(server => ({
                name: server.name, command: server.command, args: server.args,
                env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
              }))] };
            }),`
  ],
  [
    '          const runtimeInstructions = buildRuntimeInstructions({',
    '          const context = fuddyTurnContexts.get(turnInput.threadId);\n          const runtimeInstructions = [context?.instructions, context ? "Additional workspace roots: " + JSON.stringify(context.workspaceRoots) : undefined, buildRuntimeInstructions({'
  ],
  [
    '              flavor.sessionCarriesPullRequestLinking?.(sessionSetup.initializeResult) !== true,\n          });',
    '              flavor.sessionCarriesPullRequestLinking?.(sessionSetup.initializeResult) !== true,\n          })].filter(Boolean).join("\\n\\n");'
  ]
])

patchFile(join(checkout, 'packages/provider-cursor/src/server/adapter.ts'), [
  [
    'import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";',
    'import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";\nimport { fuddyTurnContexts } from "../../../provider-core/src/server/FuddyTurnContext.ts";'
  ],
  [
    '          const runtimeInstructions = buildRuntimeInstructions({',
    '          const fuddy = fuddyTurnContexts.get(turnInput.threadId);\n          const runtimeInstructions = [fuddy?.instructions, fuddy ? "Additional workspace roots: " + JSON.stringify(fuddy.workspaceRoots) : undefined, buildRuntimeInstructions({'
  ],
  [
    '            runtimePolicy: turnInput.runtimePolicy,\n          });\n          // Resend only',
    '            runtimePolicy: turnInput.runtimePolicy,\n          })].filter(Boolean).join("\\n\\n");\n          // Resend only'
  ]
])

const pi = join(checkout, 'packages/provider-pi/src/server')
patchFile(join(pi, 'adapter.ts'), [
  [
    'const PI_INHERIT_MODEL_SLUG = "default";',
    'import { fuddyTurnContexts } from "../../../provider-core/src/server/FuddyTurnContext.ts";\n\nconst PI_INHERIT_MODEL_SLUG = "default";'
  ],
  [
    '            environment: { ...options.environment, T3CODE_THREAD_ID: input.threadId },',
    `            environment: {
              ...options.environment, T3CODE_THREAD_ID: input.threadId,
              FUDDY_PI_CONTEXT_PATH: fuddyTurnContexts.get(input.threadId)?.instructionsPath,
            },`
  ]
])
patchFile(join(pi, 'mcpExtensionSource.ts'), [
  [
    String.raw`  pi.on("before_agent_start", (event, ctx) => {
    reconcileDiscovery(ctx);
    const instructions = ORCHESTRATION_INSTRUCTIONS + "\\n\\n" + PULL_REQUEST_LINKING_INSTRUCTIONS;`,
    String.raw`  pi.on("before_agent_start", async (event, ctx) => {
    reconcileDiscovery(ctx);
    const path = process.env.FUDDY_PI_CONTEXT_PATH;
    const projectInstructions = path
      ? await (await import("node:fs/promises")).readFile(path, "utf8").catch(() => "")
      : "";
    const instructions = [ORCHESTRATION_INSTRUCTIONS, PULL_REQUEST_LINKING_INSTRUCTIONS, projectInstructions].filter(Boolean).join("\\n\\n");`
  ]
])

patchFile(join(openCode, 'adapter.ts'), [
  [
    'export const makeOpenCodeAdapterV2 = Effect.fn',
    'import { fuddyDefaultModel, fuddyTurnContexts } from "../../../provider-core/src/server/FuddyTurnContext.ts";\n\nexport const makeOpenCodeAdapterV2 = Effect.fn'
  ],
  [
    '        const hasT3Mcp = mcpSession !== undefined && !connection.external;',
    `        const fuddyContext = fuddyTurnContexts.get(input.threadId);
        if (fuddyContext && !connection.external) {
          for (const server of fuddyContext.mcpServers) {
            yield* OpenCodeRuntime.runOpenCodeSdk("mcp.add", () =>
              client.mcp.add({
                name: server.name,
                config: {
                  type: "local", command: [server.command, ...server.args],
                  ...(server.env ? { environment: server.env } : {}),
                },
              }),
            );
          }
        }
        const hasT3Mcp = fuddyContext === undefined && mcpSession !== undefined && !connection.external;`
  ],
  [
    '          const variant = OpenCodeRuntime.openCodeVariant(turn.modelSelection);\n          return {',
    '          const variant = OpenCodeRuntime.openCodeVariant(turn.modelSelection);\n          const context = fuddyTurnContexts.get(turn.threadId);\n          return {'
  ],
  [
    '              orchestrationSystemPrompt,\n              buildRuntimeInstructions',
    '              orchestrationSystemPrompt,\n              context?.instructions,\n              context ? "Additional workspace roots: " + JSON.stringify(context.workspaceRoots) : "",\n              buildRuntimeInstructions'
  ],
  [
    '              if (parsedModel === null) {\n                return yield* protocolError(\n                  `OpenCode model \'${turnInput.modelSelection.model}\'',
    '              if (parsedModel === null && turnInput.modelSelection.model !== fuddyDefaultModel) {\n                return yield* protocolError(\n                  `OpenCode model \'${turnInput.modelSelection.model}\''
  ],
  [
    '              if (parsedModel === null) {\n                return yield* protocolError(\n                  `OpenCode model \'${turn.modelSelection.model}\'',
    '              if (parsedModel === null && turn.modelSelection.model !== fuddyDefaultModel) {\n                return yield* protocolError(\n                  `OpenCode model \'${turn.modelSelection.model}\''
  ],
  [
    '                  messageID: turn.admissionMessageId!,\n                  model: parsedModel,',
    '                  messageID: turn.admissionMessageId!,\n                  ...(parsedModel ? { model: parsedModel } : {}),'
  ],
  [
    '                  messageID: turn.admissionMessageId,\n                  model: parsedModel,',
    '                  messageID: turn.admissionMessageId,\n                  ...(parsedModel ? { model: parsedModel } : {}),'
  ]
])
