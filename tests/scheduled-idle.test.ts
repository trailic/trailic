import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as flushRoute } from "@/app/api/cron/flush/route";
import { GET as retentionRoute } from "@/app/api/cron/retention/route";
import { memoryBuffer, untouchableDatabase } from "./support/analytics";

/** What's cached says what the database last said: here, these jobs must not ask it again. */
const known = vi.hoisted(() => ({ hasSites: false }));
const shared = vi.hoisted(() => ({ buffer: undefined as unknown }));
vi.mock("@/app/api/cron/scheduled-work", () => ({ cronRefusal: () => null, knownWork: async () => ({ hasSites: known.hasSites }) }));
vi.mock("@/infrastructure/db/client", async (original) => ({ ...(await original<typeof import("@/infrastructure/db/client")>()), db: () => untouchableDatabase() }));
vi.mock("@/infrastructure/buffer", () => ({ eventBuffer: () => shared.buffer }));

const scheduler = (route: typeof flushRoute) => route(new Request("https://trailic.test/api/cron/x", { headers: { authorization: "Bearer cron-secret" } }));

beforeEach(() => {
  shared.buffer = memoryBuffer();
});

describe("with nothing to do", () => {
  it("the flush answers without the database or the buffer when there's no site", async () => {
    known.hasSites = false;
    expect(await (await scheduler(flushRoute)).json()).toEqual({ idle: true });
    expect((shared.buffer as ReturnType<typeof memoryBuffer>).claims).toBe(0);
  });

  it("the retention job answers without the database when there's no site", async () => {
    known.hasSites = false;
    expect(await (await scheduler(retentionRoute)).json()).toEqual({ idle: true });
  });

  it("the flush reads the buffer and not the database when there are sites and nothing waiting", async () => {
    known.hasSites = true;
    const answer = await scheduler(flushRoute);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ idle: true, batches: 0 });
    expect((shared.buffer as ReturnType<typeof memoryBuffer>).claims).toBe(1);
  });
});
