import type { EventBuffer } from "@/application/event-buffer";
import { env, type Env } from "../env";
import { fileBuffer } from "./file";
import { vercelQueueBuffer } from "./vercel-queue";

type BufferSettings = Pick<Env, "TRAILIC_BUFFER" | "TRAILIC_BUFFER_DIR" | "TRAILIC_QUEUE_REGION">;

/** Vercel Queues on Vercel, a folder anywhere else, unless the environment says which. */
export function bufferFor(settings: BufferSettings, onVercel = Boolean(process.env.VERCEL)): EventBuffer {
  const chosen = settings.TRAILIC_BUFFER ?? (onVercel ? "vercel-queue" : "file");
  if (chosen === "file") return fileBuffer(settings.TRAILIC_BUFFER_DIR);
  return vercelQueueBuffer({
    region: settings.TRAILIC_QUEUE_REGION,
    fetch,
    // Loaded here so an instance with a folder never touches it.
    token: async () => (await import("@vercel/oidc")).getVercelOidcToken(),
  });
}

let shared: EventBuffer | undefined;

/** The instance's buffer, made on first use so a build without its environment still succeeds. */
export function eventBuffer(): EventBuffer {
  shared ??= bufferFor(env());
  return shared;
}
