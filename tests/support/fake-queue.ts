/**
 * Stands in for Vercel Queues, speaking its documented HTTP API (https://vercel.com/docs/queues/api):
 * send, receive with leases and redelivery, acknowledge, and change a lease. Nothing here reaches the
 * real service: what's checked is that the adapter asks for the right things.
 */

interface Message {
  id: string;
  body: string;
  deliveries: number;
  /** Hidden until then. */
  visibleAt: number;
  handle?: string;
}

const LARGEST_RECEIVE = 10;

export function fakeQueue() {
  let now = 0;
  let nextId = 0;
  const messages: Message[] = [];
  const requests: { method: string; url: string; headers: Headers }[] = [];
  const state = { refuseSends: false, refuseReceives: false, refuseAcknowledgements: false };

  const fetchFake = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input.toString();
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    requests.push({ method, url, headers });
    const { pathname } = new URL(url);
    if (headers.get("authorization") !== "Bearer token") return new Response(null, { status: 401 });

    if (method === "POST" && /\/api\/v3\/topic\/[\w-]+$/.test(pathname)) {
      if (state.refuseSends) return new Response(null, { status: 500 });
      messages.push({ id: `msg_${(nextId += 1)}`, body: Buffer.from(String(init.body)).toString("base64"), deliveries: 0, visibleAt: 0 });
      return Response.json({ messageId: `msg_${nextId}` }, { status: 201 });
    }

    if (method === "POST" && /\/consumer\/[\w-]+$/.test(pathname)) {
      if (state.refuseReceives) return new Response(null, { status: 500 });
      const most = Math.min(Number(headers.get("vqs-max-messages") ?? 1), LARGEST_RECEIVE);
      const lease = Number(headers.get("vqs-visibility-timeout-seconds") ?? 60);
      const taken = messages.filter(({ visibleAt }) => visibleAt <= now).slice(0, most);
      if (taken.length === 0) return new Response(null, { status: 204 });
      const lines = taken.map((message) => {
        message.deliveries += 1;
        message.visibleAt = now + lease;
        message.handle = `rh_${message.id}_${message.deliveries}`;
        return JSON.stringify({ messageId: message.id, receiptHandle: message.handle, deliveryCount: message.deliveries, timestamp: "2026-11-05T09:00:00.000Z", expiresAt: "2026-11-12T09:00:00.000Z", contentType: "application/json", body: message.body });
      });
      return new Response(lines.join("\n"), { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }

    const lease = /\/lease\/([^/]+)$/.exec(pathname);
    if (lease) {
      if (state.refuseAcknowledgements) throw new TypeError("fetch failed");
      const handle = decodeURIComponent(lease[1]);
      const at = messages.findIndex((message) => message.handle === handle);
      if (at < 0) return new Response(null, { status: 404 });
      if (method === "DELETE") {
        messages.splice(at, 1);
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH") {
        const { visibilityTimeoutSeconds } = JSON.parse(String(init.body)) as { visibilityTimeoutSeconds: number };
        messages[at].visibleAt = now + visibilityTimeoutSeconds;
        return Response.json({ success: true });
      }
    }
    return new Response(null, { status: 400 });
  }) as typeof fetch;

  return {
    fetch: fetchFake,
    requests,
    leasesExpire: () => void (now += 3_600),
    get waiting() {
      return messages.length;
    },
    set refuseSends(value: boolean) {
      state.refuseSends = value;
    },
    set refuseReceives(value: boolean) {
      state.refuseReceives = value;
    },
    set refuseAcknowledgements(value: boolean) {
      state.refuseAcknowledgements = value;
    },
  };
}
