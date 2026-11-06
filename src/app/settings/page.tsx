import type { Metadata } from "next";
import { Suspense } from "react";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { Card, Code } from "@/components/ui";
import { BRAND_SLUG } from "@/domain/brand";
import { mcpResource } from "@/infrastructure/auth/server";
import { currentSeat } from "@/infrastructure/auth/session";
import { env } from "@/infrastructure/env";
import { TeamSection } from "./team-section";

export const metadata: Metadata = { title: "Settings" };

/** How each assistant adds a remote MCP server, in its own words. Their menus move: the address is what counts. */
const ASSISTANTS = [
  { name: "Claude", steps: "Settings → Connectors → Add a custom connector, then paste the address." },
  { name: "ChatGPT", steps: "Settings → Apps and connectors → Advanced settings: turn on developer mode, create a connector and paste the address. Depending on your plan, this may be limited to admins." },
];

function ConnectAnAssistant() {
  const address = mcpResource(env());
  return (
    <Card>
      <h2 className="font-semibold">Connect your assistant</h2>
      <p className="mt-2 text-sm text-muted-foreground">The address of this instance’s MCP server. Assistants only read, as whoever signed them in:</p>
      <div className="mt-3">
        <Code>{address}</Code>
      </div>
      <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
        {ASSISTANTS.map((assistant) => (
          <li key={assistant.name}>
            <span className="font-medium text-foreground">{assistant.name}.</span> {assistant.steps}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm text-muted-foreground">Claude Code:</p>
      <div className="mt-2">
        <Code>
          claude mcp add --transport http {BRAND_SLUG} {address}
        </Code>
      </div>
    </Card>
  );
}

async function Content() {
  const seat = await currentSeat();
  return (
    <div className="max-w-3xl space-y-4">
      <ConnectAnAssistant />
      <TeamSection seat={seat} />
    </div>
  );
}

/** How to reach the instance from an assistant, and who works in this workspace. */
export default function SettingsPage() {
  return (
    <Shell>
      <PageHeading title="Settings" />
      <SettingsNav />
      <Suspense fallback={<Loading />}>
        <Content />
      </Suspense>
    </Shell>
  );
}
