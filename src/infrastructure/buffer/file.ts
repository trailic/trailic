import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Claim, EventBuffer } from "@/application/event-buffer";
import type { BufferedBatch } from "@/domain/collected";

const LEASE_MS = 15 * 60_000;
const PENDING = "pending";
const LEASED = "leased";
const WRITING = "writing";

/** `<received ms>-<id>.<deliveries>.json`, so the oldest sort first; a lease adds when it runs out in front. */
const pendingName = (receivedAt: number, id: string, deliveries: number) => `${String(receivedAt).padStart(15, "0")}-${id}.${deliveries}.json`;
const leasedName = (name: string, expiresAt: number) => `${expiresAt}~${name}`;

/**
 * A folder, for a server with a disk of its own. Renaming a file is atomic, so a batch is either
 * waiting or leased, and two flushes can't take the same one. Not for Vercel, whose functions have no
 * disk that lasts.
 */
export function fileBuffer(folder: string, now: () => number = Date.now): EventBuffer {
  const at = (...parts: string[]) => join(folder, ...parts);
  const ready = async () => {
    await Promise.all([PENDING, LEASED, WRITING].map((name) => mkdir(at(name), { recursive: true })));
  };

  /** Leases nobody finished: whatever held them died, or gave up. They go back in line with one more delivery on their name. */
  async function reclaimExpired(): Promise<void> {
    for (const name of await readdir(at(LEASED))) {
      const [expiresAt, original] = name.split("~");
      if (Number(expiresAt) > now()) continue;
      const [stem, deliveries] = original.split(".");
      await rename(at(LEASED, name), at(PENDING, `${stem}.${Number(deliveries) + 1}.json`)).catch(() => {});
    }
  }

  async function take(name: string, expiresAt: number): Promise<Claim | null> {
    const leased = at(LEASED, leasedName(name, expiresAt));
    // Someone else took it: rename fails for exactly one of two.
    if (!(await rename(at(PENDING, name), leased).then(() => true, () => false))) return null;
    const [stem, deliveries] = name.split(".");
    const giveBack = async () => {
      await rename(leased, at(PENDING, `${stem}.${Number(deliveries) + 1}.json`)).catch(() => {});
    };
    return {
      batch: JSON.parse(await readFile(leased, "utf8")) as unknown,
      deliveries: Number(deliveries),
      done: () => rm(leased, { force: true }),
      giveBack,
    };
  }

  return {
    async append(batch: BufferedBatch) {
      await ready();
      const receivedAt = now();
      const writing = at(WRITING, randomUUID());
      await writeFile(writing, JSON.stringify(batch));
      await rename(writing, at(PENDING, pendingName(receivedAt, batch.id, 1)));
    },
    async claim(max) {
      await ready();
      await reclaimExpired();
      const names = (await readdir(at(PENDING))).sort().slice(0, max);
      const expiresAt = now() + LEASE_MS;
      const taken = await Promise.all(names.map((name) => take(name, expiresAt)));
      return taken.filter((claim) => claim !== null);
    },
  };
}
