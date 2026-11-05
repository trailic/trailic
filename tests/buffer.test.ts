import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventBuffer } from "@/application/event-buffer";
import type { BufferedBatch } from "@/domain/collected";
import { bufferFor } from "@/infrastructure/buffer";
import { fileBuffer } from "@/infrastructure/buffer/file";
import { vercelQueueBuffer } from "@/infrastructure/buffer/vercel-queue";
import { batchOf, collected } from "./support/analytics";
import { fakeQueue } from "./support/fake-queue";

const SITE = { id: "11111111-2222-4333-8444-555555555555", key: "site_x" };
const folders: string[] = [];

function newFolder() {
  const folder = mkdtempSync(join(tmpdir(), "trailic-buffer-"));
  folders.push(folder);
  return folder;
}

afterAll(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));

const batchNamed = (path: string): BufferedBatch => batchOf(SITE, [collected({ path })]);
const pathOf = (batch: unknown) => (batch as BufferedBatch).events[0].path;

interface Harness {
  buffer: EventBuffer;
  /** Time passes: a lease that wasn't settled runs out. */
  leasesExpire: () => void;
}

function fileHarness(): Harness {
  let now = 1_000_000;
  const clock = vi.fn(() => now);
  return { buffer: fileBuffer(newFolder(), clock), leasesExpire: () => (now += 16 * 60_000) };
}

function queueHarness(): Harness {
  const queue = fakeQueue();
  return { buffer: vercelQueueBuffer({ region: "fra1", token: async () => "token", fetch: queue.fetch }), leasesExpire: queue.leasesExpire };
}

describe.each([
  ["a folder", fileHarness],
  ["Vercel Queues", queueHarness],
])("%s, as a buffer", (_, harness) => {
  let buffer: EventBuffer;
  let leasesExpire: () => void;
  beforeEach(() => {
    ({ buffer, leasesExpire } = harness());
  });

  it("answers nothing when nothing's there", async () => {
    expect(await buffer.claim(10)).toEqual([]);
  });

  it("hands back what it kept, in full", async () => {
    const batch = batchNamed("/a");
    await buffer.append(batch);
    const [claim] = await buffer.claim(10);
    expect(claim.batch).toEqual(batch);
    expect(claim.deliveries).toBe(1);
  });

  it("hands out no more than it's asked, and the rest next time", async () => {
    for (const path of ["/a", "/b", "/c"]) await buffer.append(batchNamed(path));
    const first = await buffer.claim(1);
    expect(first.length).toBeGreaterThanOrEqual(1);
    const rest = await buffer.claim(10);
    expect([...first, ...rest].map(({ batch }) => pathOf(batch)).sort()).toEqual(["/a", "/b", "/c"]);
  });

  it("forgets what's done", async () => {
    await buffer.append(batchNamed("/a"));
    const [claim] = await buffer.claim(10);
    await claim.done();
    leasesExpire();
    expect(await buffer.claim(10)).toEqual([]);
  });

  it("hides what's claimed from another flush", async () => {
    await buffer.append(batchNamed("/a"));
    expect(await buffer.claim(10)).toHaveLength(1);
    expect(await buffer.claim(10)).toEqual([]);
  });

  it("delivers again what's given back, counting the delivery", async () => {
    await buffer.append(batchNamed("/a"));
    const [claim] = await buffer.claim(10);
    await claim.giveBack();
    const [again] = await buffer.claim(10);
    expect(pathOf(again.batch)).toBe("/a");
    expect(again.deliveries).toBe(2);
  });

  it("delivers again what a dead flush was holding, once its lease runs out", async () => {
    await buffer.append(batchNamed("/a"));
    await buffer.claim(10);
    expect(await buffer.claim(10)).toEqual([]);
    leasesExpire();
    const [again] = await buffer.claim(10);
    expect(pathOf(again.batch)).toBe("/a");
    expect(again.deliveries).toBe(2);
  });

  it("holds more than one receive's worth", async () => {
    for (let count = 0; count < 35; count += 1) await buffer.append(batchNamed(`/${count}`));
    const claims = await buffer.claim(100);
    expect(new Set(claims.map(({ batch }) => pathOf(batch))).size).toBe(35);
  });
});

describe("a folder", () => {
  it("leaves no half-written file where a flush would read it", async () => {
    const folder = newFolder();
    const buffer = fileBuffer(folder);
    await buffer.append(batchNamed("/a"));
    expect(readdirSync(join(folder, "writing"))).toEqual([]);
    expect(readdirSync(join(folder, "pending"))).toHaveLength(1);
  });

  it("gives one batch to one of two flushes at once", async () => {
    const buffer = fileBuffer(newFolder());
    for (const path of ["/a", "/b", "/c", "/d"]) await buffer.append(batchNamed(path));
    const [one, two] = await Promise.all([buffer.claim(10), buffer.claim(10)]);
    expect(one.length + two.length).toBe(4);
    expect(new Set([...one, ...two].map(({ batch }) => pathOf(batch))).size).toBe(4);
  });
});

describe("Vercel Queues", () => {
  it("sends in one region, for as long as a message can live, with no deployment pinned", async () => {
    const queue = fakeQueue();
    await vercelQueueBuffer({ region: "fra1", token: async () => "token", fetch: queue.fetch }).append(batchNamed("/a"));
    const [sent] = queue.requests;
    expect(sent.url).toBe("https://fra1.vercel-queue.com/api/v3/topic/trailic-events");
    expect(sent.headers.get("authorization")).toBe("Bearer token");
    expect(sent.headers.get("vqs-retention-seconds")).toBe("604800");
    // Pinned to a deployment, a release would strand what the last one collected.
    expect(sent.headers.get("vqs-deployment-id")).toBeNull();
  });

  it("says when the queue refused, so the collector doesn't answer 202", async () => {
    const queue = fakeQueue();
    queue.refuseSends = true;
    await expect(vercelQueueBuffer({ region: "fra1", token: async () => "token", fetch: queue.fetch }).append(batchNamed("/a"))).rejects.toThrow(/answered 500/);
  });

  it("says when it can't read, so a flush doesn't take it for empty", async () => {
    const queue = fakeQueue();
    queue.refuseReceives = true;
    await expect(vercelQueueBuffer({ region: "fra1", token: async () => "token", fetch: queue.fetch }).claim(10)).rejects.toThrow(/answered 500/);
  });

  it("stays calm when an acknowledgement fails: writing it twice writes it once", async () => {
    const queue = fakeQueue();
    const buffer = vercelQueueBuffer({ region: "fra1", token: async () => "token", fetch: queue.fetch });
    await buffer.append(batchNamed("/a"));
    const [claim] = await buffer.claim(1);
    queue.refuseAcknowledgements = true;
    await expect(claim.done()).resolves.toBeUndefined();
    await expect(claim.giveBack()).resolves.toBeUndefined();
  });
});

describe("which buffer", () => {
  const settings = { TRAILIC_BUFFER_DIR: "unused", TRAILIC_QUEUE_REGION: "fra1" };

  it("is Vercel Queues on Vercel, a folder elsewhere, unless the environment says", () => {
    const named = (buffer: EventBuffer) => buffer.append.toString();
    expect(named(bufferFor(settings, true))).toContain("queue");
    expect(named(bufferFor(settings, false))).toContain("writing");
    expect(named(bufferFor({ ...settings, TRAILIC_BUFFER: "file" }, true))).toContain("writing");
    expect(named(bufferFor({ ...settings, TRAILIC_BUFFER: "vercel-queue" }, false))).toContain("queue");
  });
});
