/** What the library sends to the collector, as JSON in a text/plain body: a page can post that to another domain with no preflight to pay for. */

export type EventKind = "page" | "event" | "identify" | "vital";

export type Traits = Record<string, string | number | boolean>;

export interface WireEvent {
  kind: EventKind;
  /** How long ago it happened, in milliseconds: a visitor's clock can't be trusted, and this needs none. */
  ago?: number;
  path?: string;
  /** Only with the first page of a load. */
  referrer?: string;
  /** A custom event's or a web vital's name. */
  name?: string;
  props?: Traits;
  /** A web vital's measure. */
  value?: number;
  /** Only once the site called identify. */
  userId?: string;
  traits?: Traits;
}

export interface WireBatch {
  key: string;
  /** Sent by trackServer: no visitor behind it, so nothing to hash or filter. */
  server?: boolean;
  events: WireEvent[];
}

/** Where a project can send through its own domain, with the rewrite or the relay in trailic/next. */
export const FIRST_PARTY_PATH = "/trailic/e";
