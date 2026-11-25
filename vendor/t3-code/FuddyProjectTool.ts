import { execFile } from "node:child_process";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import { fuddyTurnContexts } from "../../orchestration-v2/FuddyTurnContext.ts";
import * as Invocation from "../../mcp/McpInvocationContext.ts";
import * as Access from "../../mcp/McpToolAccess.ts";

const UpdateProject = Tool.make("fuddy_update_project_info", {
  description: "Update this Fuddy project's settings. Omit unchanged fields. Available fields: name, summary, focus, status, productType, stage, mission, vision, websiteUrl, defaultAgent, focusAreas, dataSources, nextMoves, currentStateSummary, currentStateFacts, workspaceRoots, primaryWorkspaceRootId. A workspace root has id, label, and path.",
  parameters: Schema.Struct({ patch: Schema.Record(Schema.String, Schema.Json) }),
  success: Schema.Struct({ message: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [Invocation.McpInvocationContext],
}).annotate(McpSchema.EnabledWhen, Invocation.hiddenFromOutsideClients)
  .annotate(Tool.Readonly, false);

export const toolkit = Toolkit.make(UpdateProject);
const invalid = (message: string) => new OrchestratorMcpFailure({ code: "invalid_request", message });

export const handlers = Access.toLayer(toolkit, {
  fuddy_update_project_info: Access.actsAsCaller(({ patch }) => Effect.gen(function* () {
    const { thread } = yield* Invocation.McpInvocationContext;
    const server = thread && fuddyTurnContexts.get(thread.threadId)?.mcpServers.find(
      item => item.name === "project_agent",
    );
    if (!server) return yield* invalid("This Chat has no active Fuddy project.");
    const input = JSON.stringify(patch);
    if (Buffer.byteLength(input) > 64_000) return yield* invalid("The project update is too large.");
    const result = yield* Effect.tryPromise({
      try: signal => new Promise<string>((resolve, reject) => {
        const process = execFile(server.command, [...server.args, "--update-from-stdin"], {
          env: { ...globalThis.process.env, ...server.env }, signal, timeout: 10_000, maxBuffer: 64_000,
        }, (error, output) => error ? reject(error) : resolve(output));
        process.stdin?.on("error", reject);
        process.stdin?.end(input);
      }).then(output => JSON.parse(output) as { isError?: boolean; content?: Array<{ text?: string }> }),
      catch: () => invalid("Fuddy rejected the project update."),
    });
    const message = result.content?.[0]?.text ?? "Fuddy returned no result.";
    if (result.isError) return yield* invalid(message);
    return { message };
  })),
});
