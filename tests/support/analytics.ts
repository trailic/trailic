import { createSite } from "@/application/sites";
import type { Claim, EventBuffer } from "@/application/event-buffer";
import type { BufferedBatch, CollectedEvent } from "@/domain/collected";
import type { Database } from "@/infrastructure/db/client";

export const SECRET = "a-long-enough-secret-for-site-keys-in-tests";
export const NOW = new Date("2026-11-05T09:00:00.000Z");

/** A site, with its id and key. */
export async function addSite(db: Database, workspaceId: string, userId: string, name = "Acme", domains = "acme.example") {
  const made = await createSite(db, SECRET, workspaceId, userId, { name, domains });
  if (!made.ok) throw new Error(made.error);
  return { id: made.id, key: made.key };
}

/** An event as the collector shapes it, a page view unless told otherwise. */
export function collected(overrides: Partial<CollectedEvent> = {}): CollectedEvent {
  return {
    kind: "page",
    at: NOW.toISOString(),
    path: "/",
    name: null,
    visitor: "00000000-0000-4000-8000-000000000001",
    userId: null,
    referrer: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
    country: "FR",
    device: "desktop",
    browser: "Firefox",
    os: "Linux",
    props: null,
    traits: null,
    value: null,
    ...overrides,
  };
}

/** A visitor's id from a small number, so a test can say who is who. */
export const visitor = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

export function batchOf(site: { id: string; key: string }, events: CollectedEvent[], overrides: Partial<BufferedBatch> = {}): BufferedBatch {
  return { id: crypto.randomUUID(), siteId: site.id, key: site.key, originHost: "acme.example", verified: true, events, ...overrides };
}

export interface MemoryBuffer extends EventBuffer {
  /** Nothing acknowledged or returned so far is here. */
  waiting: { batch: unknown; deliveries: number }[];
  /** What a buffer may do: the write committed and the acknowledgement was lost, so it delivers again once the lease runs out. */
  loseAcknowledgements: boolean;
  leasesExpire(): void;
  acknowledged: number;
  claims: number;
}

/** A buffer that keeps its promises in memory: at least once, nothing gone until acknowledged. */
export function memoryBuffer(): MemoryBuffer {
  const leased: MemoryBuffer["waiting"] = [];
  const buffer: MemoryBuffer = {
    waiting: [],
    loseAcknowledgements: false,
    acknowledged: 0,
    claims: 0,
    leasesExpire: () => void buffer.waiting.push(...leased.splice(0, leased.length)),
    async append(batch) {
      buffer.waiting.push({ batch: JSON.parse(JSON.stringify(batch)), deliveries: 0 });
    },
    async claim(max) {
      buffer.claims += 1;
      return buffer.waiting.splice(0, max).map((entry): Claim => {
        entry.deliveries += 1;
        return {
          batch: entry.batch,
          deliveries: entry.deliveries,
          done: async () => {
            if (buffer.loseAcknowledgements) leased.push(entry);
            else buffer.acknowledged += 1;
          },
          giveBack: async () => void buffer.waiting.push(entry),
        };
      });
    },
  };
  return buffer;
}

/** A database that must not be touched: any use of it fails the test that reached for it. */
export const untouchableDatabase = () =>
  new Proxy({} as Database, {
    get(_, property) {
      throw new Error(`The database was touched: ${String(property)}`);
    },
  });
