import { z } from "zod";

/** What a funnel asks and what its numbers mean. Pure: the database counts people, and this lays them out. */

export const FUNNEL_STEP = z.object({ kind: z.enum(["page", "event"]), match: z.string().trim().min(1).max(512) });
export const FUNNEL_STEPS = z.array(FUNNEL_STEP).min(2).max(8);
export type FunnelStepInput = z.infer<typeof FUNNEL_STEP>;

export const DEFAULT_WINDOW_HOURS = 168;
export const LONGEST_WINDOW_HOURS = 24 * 90;

export interface FunnelStepResult {
  step: FunnelStepInput;
  /** People who got this far, in order, inside the window. */
  people: number;
  /** Share of those who started, 0 to 1. */
  conversion: number;
  /** Share of the previous step's people lost here, 0 to 1. */
  dropOff: number;
}

const share = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);

export function funnelResult(steps: readonly FunnelStepInput[], counts: readonly number[]): FunnelStepResult[] {
  return steps.map((step, index) => {
    const people = counts[index] ?? 0;
    return { step, people, conversion: share(people, counts[0] ?? 0), dropOff: index === 0 ? 0 : share((counts[index - 1] ?? 0) - people, counts[index - 1] ?? 0) };
  });
}

export const stepLabel = ({ kind, match }: FunnelStepInput) => (kind === "page" ? `Visited ${match}` : `Did ${match}`);

/** "/docs/*" matches anything under it, as a LIKE pattern with what it holds escaped; anything else matches exactly. */
export function pathPattern(match: string): { exact: string } | { like: string } {
  if (!match.endsWith("*")) return { exact: match };
  return { like: `${match.slice(0, -1).replace(/[\\%_]/g, "\\$&")}%` };
}

/** Steps as a member types them, one per line: what starts with a slash is a page, anything else an event. */
export const stepsFromLines = (text: string): FunnelStepInput[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ kind: line.startsWith("/") ? "page" : "event", match: line }));

export const linesFromSteps = (steps: readonly FunnelStepInput[]) => steps.map(({ match }) => match).join("\n");
