import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryEntry } from "@/application/sites";

const answers = vi.hoisted(() => ({ next: async (): Promise<DirectoryEntry[]> => [] }));
vi.mock("next/cache", () => ({ cacheLife: () => {}, cacheTag: () => {}, revalidateTag: () => {} }));
vi.mock("@/application/sites", () => ({ collectorDirectory: () => answers.next() }));
vi.mock("@/infrastructure/db/client", () => ({ db: () => ({}) }));

const SOME: DirectoryEntry[] = [{ siteId: "a", key: "k", allowedDomains: ["acme.example"], anonymous: true }];

async function freshDirectory() {
  vi.resetModules();
  return (await import("@/infrastructure/collector/directory")).directoryForCollector;
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("what the collector knows about sites", () => {
  it("comes from the cached read, then from memory for a minute", async () => {
    const read = vi.fn(async () => SOME);
    answers.next = read;
    const directory = await freshDirectory();
    expect(await directory()).toEqual(SOME);
    expect(await directory()).toEqual(SOME);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("looks again after that minute", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-05T09:00:00Z") });
    const read = vi.fn(async () => SOME);
    answers.next = read;
    const directory = await freshDirectory();
    await directory();
    vi.setSystemTime(new Date("2026-11-05T09:01:01Z"));
    await directory();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("is unknown rather than an error when the database can't answer", async () => {
    answers.next = async () => {
      throw new Error("Connection refused");
    };
    expect(await (await freshDirectory())()).toBeNull();
  });

  it("doesn't keep a visitor waiting on a database that hangs", async () => {
    vi.useFakeTimers();
    answers.next = () => new Promise(() => {});
    const asked = (await freshDirectory())();
    await vi.advanceTimersByTimeAsync(1_600);
    expect(await asked).toBeNull();
  });

  it("falls back on what it last knew", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-05T09:00:00Z") });
    answers.next = async () => SOME;
    const directory = await freshDirectory();
    await directory();
    vi.setSystemTime(new Date("2026-11-05T09:05:00Z"));
    answers.next = async () => {
      throw new Error("Connection refused");
    };
    expect(await directory()).toEqual(SOME);
  });
});
