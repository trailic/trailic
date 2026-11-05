import { z } from "zod";
import { createSite, NO_SECRET } from "@/application/sites";
import { relayKeyOf } from "@/infrastructure/crypto/site-key";
import { sitesChanged } from "@/infrastructure/scheduling/scheduled-work";
import { answer, appUrl, refusal, type ToolRegistrar } from "./tool";

/**
 * What starts measuring a site, so that an assistant can set up a member's projects. It runs the use
 * case the screen does, with its rule on who may. Changing or deleting a site stays on the screen.
 */
export const siteSetupTools: ToolRegistrar = (server, context) => {
  const { services, workspaceId, userId } = context;

  server.registerTool(
    "create_site",
    {
      title: "Add a site",
      description: "Adds a site to this workspace, when the member asked to measure it, and returns what its project needs. Its pages can only send from the domains given. Refused unless this member manages the workspace’s settings.",
      inputSchema: z.object({
        name: z.string().min(1).describe("How the site is called on the screens. One name per site in a workspace."),
        domains: z.string().min(1).describe("The domains it runs on, one per line. Subdomains are included."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ name, domains }) => {
      const secret = services.settings.TRAILIC_SECRET;
      if (!secret) return refusal(NO_SECRET);
      const made = await createSite(services.db, secret, workspaceId, userId, { name, domains });
      if (!made.ok) return refusal(made.error);
      sitesChanged();
      const instance = services.settings.BETTER_AUTH_URL;
      return answer(
        { siteId: made.id, siteKey: made.key, collector: new URL("/api/e", instance).toString(), relay: { TRAILIC_URL: instance, TRAILIC_RELAY_KEY: relayKeyOf(made.id, secret) }, url: appUrl(context, `/sites/${made.id}`) },
        "The site key is public: it goes in the page. The relay key is secret: it goes in the project’s environment and nowhere else, so don’t repeat it to anyone.",
      );
    },
  );
};
