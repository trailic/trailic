import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Services } from "@/application/services";
import { startWorkspace, type MemberWorkspace } from "@/application/workspaces";
import { answer, refusal } from "./tool";

/** A tool that isn't in a workspace: it says which there are. It only reads, and offers no way to change who belongs where. */
export function workspaceListTool(server: McpServer, workspaces: MemberWorkspace[]): void {
  server.registerTool(
    "list_workspaces",
    {
      title: "This member’s workspaces",
      description: "The workspaces this member belongs to, one per company, with their role in each. With several, every other tool says which one it acts in through its workspace argument.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => answer({ workspaces: workspaces.map(({ id, name, role }) => ({ id, name, role })) }),
  );
}

interface WorkspaceStarter {
  services: Services;
  userId: string;
  email: string;
  workspaces: MemberWorkspace[];
}

/** The other one, only for those an instance lets start workspaces. Who else belongs to one stays on the screen. */
export function workspaceStartTool(server: McpServer, { services, userId, email, workspaces }: WorkspaceStarter): void {
  server.registerTool(
    "create_workspace",
    {
      title: "Start a workspace",
      description: "Starts a workspace for a company, when the member asked for one, with them as its owner. It starts with nothing from their other workspaces.",
      inputSchema: z.object({ name: z.string().min(1).describe("The company’s name.") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ name }) => {
      // Tools pick a workspace by its exact name, so a second one of the same name could never be chosen by it.
      if (workspaces.some((workspace) => workspace.name === name.trim())) return refusal(`This member already has a workspace called ${JSON.stringify(name.trim())}.`);
      const id = await startWorkspace(services.db, services.settings, { userId, email }, name);
      return id ? answer({ workspace: { id, name: name.trim(), role: "owner" } }) : refusal("Give the workspace a name.");
    },
  );
}
