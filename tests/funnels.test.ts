import { beforeAll, describe, expect, it } from "vitest";
import { createFunnel, deleteFunnel, funnelIn, funnelsOf, runFunnel } from "@/application/funnels";
import { flushBuffer } from "@/application/flush";
import { periodEndingAt } from "@/application/time-range";
import { funnelResult, linesFromSteps, pathPattern, stepLabel, stepsFromLines, type FunnelStepInput } from "@/domain/funnels";
import type { Database } from "@/infrastructure/db/client";
import { addSite, batchOf, collected, memoryBuffer, NOW, visitor } from "./support/analytics";
import { createTestDatabase, createTestWorkspace } from "./support/database";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

const hour = (hours: number) => new Date(Date.UTC(2026, 10, 3, 8) + hours * 3_600_000).toISOString();

async function seat(name = "Acme") {
  const { workspaceId, userId } = await createTestWorkspace(db, name);
  const site = await addSite(db, workspaceId, userId, name);
  return { workspaceId, userId, site };
}

async function flushed(site: { id: string; key: string }, events: ReturnType<typeof collected>[]) {
  const buffer = memoryBuffer();
  await buffer.append(batchOf(site, events));
  await flushBuffer({ db, buffer, now: () => NOW });
}

const page = (path: string, who: number, at: string, userId: string | null = null) => collected({ path, visitor: visitor(who), at, userId });
const did = (name: string, who: number, at: string, userId: string | null = null) => collected({ kind: "event", name, path: "/", visitor: visitor(who), at, userId });

const SIGN_UP: FunnelStepInput[] = [
  { kind: "page", match: "/pricing" },
  { kind: "event", match: "signup" },
  { kind: "page", match: "/welcome" },
];

const PERIOD = periodEndingAt(NOW, 30);
const run = async (workspaceId: string, siteId: string, steps: readonly FunnelStepInput[], windowHours = 24) => (await runFunnel(db, workspaceId, { siteId, steps, windowHours, period: PERIOD })).steps.map(({ people }) => people);

describe("a funnel, worked out by hand", () => {
  /**
   * A goes all the way. B stops after signing up. C only looks at the price. D signed up first, so
   * for D the pricing page comes after: one step. E signs up 25 hours later, outside 24. F does it
   * across two days on two devices, identified, within 24 hours: all the way. G never saw pricing.
   * So: 6 start (A B C D E F), 3 sign up (A B F), 2 arrive (A F).
   */
  const FIXTURE = [
    page("/pricing", 1, hour(0)), did("signup", 1, hour(1)), page("/welcome", 1, hour(2)),
    page("/pricing", 2, hour(0)), did("signup", 2, hour(1)),
    page("/pricing", 3, hour(0)),
    did("signup", 4, hour(0)), page("/pricing", 4, hour(1)),
    page("/pricing", 5, hour(0), "user_e"), did("signup", 5, hour(25), "user_e"),
    page("/pricing", 6, hour(0), "user_f"), did("signup", 16, hour(20), "user_f"), page("/welcome", 16, hour(21), "user_f"),
    page("/welcome", 7, hour(0)),
  ];

  it("counts who got how far, in order, inside the window", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, FIXTURE);
    expect(await run(workspaceId, site.id, SIGN_UP)).toEqual([6, 3, 2]);
  });

  it("says what share converted and what share dropped off at each step", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, FIXTURE);
    const { steps, windowHours, timezone } = await runFunnel(db, workspaceId, { siteId: site.id, steps: SIGN_UP, windowHours: 24, period: PERIOD });
    expect(timezone).toBe("UTC");
    expect(windowHours).toBe(24);
    expect(steps.map(({ conversion }) => conversion)).toEqual([1, 0.5, 1 / 3]);
    expect(steps.map(({ dropOff }) => dropOff)).toEqual([0, 0.5, 1 / 3]);
  });

  it("widens with its window: E makes it at 48 hours", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, FIXTURE);
    expect(await run(workspaceId, site.id, SIGN_UP, 48)).toEqual([6, 4, 2]);
  });
});

describe("what counts as a step", () => {
  it("includes a page view and an event in the same millisecond", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [page("/pricing", 1, hour(0)), did("signup", 1, hour(0))]);
    expect(await run(workspaceId, site.id, [SIGN_UP[0], SIGN_UP[1]])).toEqual([1, 1]);
  });

  it("wants a second visit for the same step twice", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [page("/a", 1, hour(0)), page("/a", 2, hour(0)), page("/a", 2, hour(1))]);
    const twice: FunnelStepInput[] = [{ kind: "page", match: "/a" }, { kind: "page", match: "/a" }];
    expect(await run(workspaceId, site.id, twice)).toEqual([2, 1]);
  });

  it("matches anything under a path with a star, and nothing else", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [page("/docs/intro", 1, hour(0)), page("/docs", 2, hour(0)), page("/docsy", 3, hour(0)), page("/docs/intro", 4, hour(0)), did("read", 4, hour(1))]);
    expect(await run(workspaceId, site.id, [{ kind: "page", match: "/docs/*" }, { kind: "event", match: "read" }])).toEqual([2, 1]);
  });

  it("treats % and _ in a path as themselves", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [page("/100%/a", 1, hour(0)), page("/100x/a", 2, hour(0))]);
    expect(await run(workspaceId, site.id, [{ kind: "page", match: "/100%/*" }, { kind: "page", match: "/never" }])).toEqual([1, 0]);
  });

  it("follows someone who signs in partway: the half hour before is theirs", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [page("/pricing", 1, hour(0))]);
    await flushed(site, [collected({ kind: "identify", visitor: visitor(1), userId: "user_1", at: hour(0.25) }), did("signup", 2, hour(1), "user_1")]);
    expect(await run(workspaceId, site.id, [SIGN_UP[0], SIGN_UP[1]])).toEqual([1, 1]);
  });

  it("can't follow someone anonymous to the next day, by design: the hash has rotated", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [page("/pricing", 1, hour(0)), did("signup", 2, hour(24))]);
    expect(await run(workspaceId, site.id, [SIGN_UP[0], SIGN_UP[1]], 48)).toEqual([1, 0]);
  });

  it("leaves out what happened outside the period", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [page("/pricing", 1, "2026-10-01T08:00:00.000Z"), page("/pricing", 2, hour(0))]);
    expect(await run(workspaceId, site.id, [SIGN_UP[0], { kind: "page", match: "/never" }])).toEqual([1, 0]);
  });

  it("stays in its workspace", async () => {
    const mine = await seat("Mine");
    const theirs = await seat("Theirs");
    await flushed(theirs.site, [page("/pricing", 1, hour(0))]);
    expect(await run(mine.workspaceId, theirs.site.id, [SIGN_UP[0], SIGN_UP[1]])).toEqual([0, 0]);
  });

  it("answers an empty funnel with zeros, not a division by zero", async () => {
    const { workspaceId, site } = await seat();
    const { steps } = await runFunnel(db, workspaceId, { siteId: site.id, steps: SIGN_UP, period: PERIOD });
    expect(steps.map(({ people, conversion, dropOff }) => [people, conversion, dropOff])).toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  });
});

describe("saved funnels", () => {
  it("keep their steps, and refuse what isn't a funnel", async () => {
    const { workspaceId, userId, site } = await seat();
    const made = await createFunnel(db, workspaceId, { siteId: site.id, name: "Sign-up", steps: SIGN_UP, windowHours: 48 });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(await funnelIn(db, workspaceId, made.id)).toMatchObject({ name: "Sign-up", steps: SIGN_UP, windowHours: 48 });
    expect((await funnelsOf(db, workspaceId, site.id)).map(({ name }) => name)).toEqual(["Sign-up"]);
    expect((await createFunnel(db, workspaceId, { siteId: site.id, name: "Sign-up", steps: SIGN_UP })).ok).toBe(false);
    expect((await createFunnel(db, workspaceId, { siteId: site.id, name: " ", steps: SIGN_UP })).ok).toBe(false);
    expect((await createFunnel(db, workspaceId, { siteId: site.id, name: "One", steps: [SIGN_UP[0]] })).ok).toBe(false);
    expect((await createFunnel(db, workspaceId, { siteId: site.id, name: "Bad", steps: [{ kind: "nope", match: "x" }, SIGN_UP[0]] })).ok).toBe(false);
    expect((await deleteFunnel(db, workspaceId, userId, made.id)).ok).toBe(true);
    expect((await deleteFunnel(db, workspaceId, userId, made.id)).ok).toBe(false);
  });
});

describe("the arithmetic", () => {
  it("handles zero and labels steps", () => {
    expect(funnelResult(SIGN_UP, [0, 0, 0])[1]).toMatchObject({ conversion: 0, dropOff: 0 });
    expect(funnelResult(SIGN_UP, [10, 5, 5]).map(({ dropOff }) => dropOff)).toEqual([0, 0.5, 0]);
    expect(stepLabel(SIGN_UP[0])).toBe("Visited /pricing");
    expect(stepLabel(SIGN_UP[1])).toBe("Did signup");
    expect(pathPattern("/a")).toEqual({ exact: "/a" });
    expect(pathPattern("/a_b/*")).toEqual({ like: "/a\\_b/%" });
  });
});

describe("steps as a member types them", () => {
  it("are a page when they start with a slash, and an event otherwise, one per line", () => {
    expect(stepsFromLines(" /pricing\n\nsignup \n/docs/*\n")).toEqual([
      { kind: "page", match: "/pricing" },
      { kind: "event", match: "signup" },
      { kind: "page", match: "/docs/*" },
    ]);
    expect(linesFromSteps(stepsFromLines("/a\nb"))).toBe("/a\nb");
  });
});
