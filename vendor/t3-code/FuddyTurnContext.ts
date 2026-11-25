import { createHash } from "node:crypto";

// Fuddy-owned turn context. Populated only through the inherited IPC channel.
export interface FuddyTurnContext {
  readonly instructions: string;
  readonly instructionsPath?: string;
  readonly workspaceRoots: readonly string[];
  readonly mcpServers: ReadonlyArray<{
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
  }>;
  readonly nativeImages: readonly string[];
}

export const fuddyTurnContexts = new Map<string, FuddyTurnContext>();
export const fuddyDefaultModel = "fuddy-native-default";

export function fuddyContextFingerprint(context: FuddyTurnContext): string {
  return createHash("sha256").update(JSON.stringify([
    context.instructions, context.workspaceRoots, context.mcpServers,
  ])).digest("hex");
}
