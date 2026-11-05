import type { Claim, EventBuffer } from "@/application/event-buffer";
import type { BufferedBatch } from "@/domain/collected";

const TOPIC = "trailic-events";
const CONSUMER_GROUP = "flush";
/** The longest a message may live: a database down for a week loses nothing until then. */
const RETENTION_SECONDS = 604_800;
/** Longer than a flush lasts: a message comes back only if the flush that held it died. */
const LEASE_SECONDS = 900;
const MOST_PER_RECEIVE = 10;
const RECEIVES_AT_ONCE = 8;

interface ReceivedMessage {
  receiptHandle: string;
  deliveryCount: number;
  body: string;
}

export interface VercelQueueOptions {
  /** Messages are read from the region they were sent to, so it is fixed rather than wherever a function runs. */
  region: string;
  token: () => Promise<string>;
  fetch: typeof fetch;
}

/**
 * Vercel Queues in poll mode, through its documented HTTP API (https://vercel.com/docs/queues/api):
 * the SDK's `receive` acknowledges each message as its handler returns, one at a time, while here a
 * thousand are held until one transaction has written them all. No deployment id is sent, so a flush
 * reads what an earlier deployment collected: pinned to a deployment, a release would strand the
 * events waiting behind it.
 */
export function vercelQueueBuffer({ region, token, fetch: fetchUrl }: VercelQueueOptions): EventBuffer {
  const topicUrl = `https://${region}.vercel-queue.com/api/v3/topic/${TOPIC}`;
  const consumerUrl = `${topicUrl}/consumer/${CONSUMER_GROUP}`;
  const leaseUrl = (handle: string) => `${consumerUrl}/lease/${encodeURIComponent(handle)}`;
  const bearer = async () => ({ authorization: `Bearer ${await token()}` });

  async function receive(): Promise<ReceivedMessage[]> {
    const response = await fetchUrl(consumerUrl, {
      method: "POST",
      headers: { ...(await bearer()), accept: "application/x-ndjson", "vqs-max-messages": String(MOST_PER_RECEIVE), "vqs-visibility-timeout-seconds": String(LEASE_SECONDS) },
    });
    if (response.status === 204) return [];
    if (!response.ok) throw new Error(`The queue answered ${response.status} when asked for messages.`);
    return (await response.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ReceivedMessage);
  }

  const claimOf = ({ receiptHandle, deliveryCount, body }: ReceivedMessage): Claim => ({
    batch: JSON.parse(Buffer.from(body, "base64").toString("utf8")) as unknown,
    deliveries: deliveryCount,
    async done() {
      // 404 and 409 mean someone else has it now: whoever does will find it already written.
      await fetchUrl(leaseUrl(receiptHandle), { method: "DELETE", headers: await bearer() }).catch(() => {});
    },
    async giveBack() {
      await fetchUrl(leaseUrl(receiptHandle), { method: "PATCH", headers: { ...(await bearer()), "content-type": "application/json" }, body: JSON.stringify({ visibilityTimeoutSeconds: 0 }) }).catch(() => {});
    },
  });

  return {
    async append(batch: BufferedBatch) {
      const response = await fetchUrl(topicUrl, {
        method: "POST",
        headers: { ...(await bearer()), "content-type": "application/json", "vqs-retention-seconds": String(RETENTION_SECONDS) },
        body: JSON.stringify(batch),
      });
      if (!response.ok) throw new Error(`The queue answered ${response.status} when given a batch.`);
    },
    async claim(max) {
      const claims: Claim[] = [];
      let drained = false;
      const receiveUntilDrained = async () => {
        while (!drained && claims.length < max) {
          const messages = await receive();
          if (messages.length === 0) drained = true;
          claims.push(...messages.map(claimOf));
        }
      };
      await Promise.all(Array.from({ length: RECEIVES_AT_ONCE }, receiveUntilDrained));
      return claims;
    },
  };
}
