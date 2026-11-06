import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DayColumns } from "@/components/charts";
import { ImportedNote } from "@/components/reading";

const DAYS = [
  { date: "2026-11-01", value: 3, imported: true },
  { date: "2026-11-02", value: 5, imported: true },
  { date: "2026-11-03", value: 4 },
  { date: "2026-11-04", value: 8 },
];

describe("imported figures on a screen", () => {
  it("say where they came from, how far they go, and what they count", () => {
    const html = renderToStaticMarkup(<ImportedNote history={[{ source: "Another tool", counts: "every page view it recorded", note: "It holds nothing for August.", firstDay: "2026-06-01", lastDay: "2026-11-02", sites: 1 }]} />);
    expect(html).toContain("Imported from Another tool");
    expect(html).toContain("1 Jun 2026 to 2 Nov 2026");
    expect(html).toContain("every page view it recorded");
    expect(html).toContain("It holds nothing for August.");
    expect(html).not.toContain("sites");
  });

  it("say on how many sites, across a workspace", () => {
    expect(renderToStaticMarkup(<ImportedNote history={[{ source: "Another tool", counts: "x", note: null, firstDay: "2026-06-01", lastDay: "2026-11-02", sites: 12 }]} />)).toContain("on 12 sites");
  });

  it("show nothing when there are none", () => {
    expect(renderToStaticMarkup(<ImportedNote history={[]} />)).toBe("");
  });

  it("are paler on the chart, and said in words to whoever can't see that", () => {
    const html = renderToStaticMarkup(<DayColumns days={DAYS} measure="Page views" />);
    expect(html).toContain('aria-label="1 Nov: 3, imported"');
    expect(html).toContain('aria-label="4 Nov: 8"');
    expect(html.match(/bg-data\/35/g)).toHaveLength(2);
    expect(html).toContain("bg-blaze ");
  });

  it("stay paler when an imported day is the busiest", () => {
    const html = renderToStaticMarkup(<DayColumns days={[{ date: "2026-11-01", value: 9, imported: true }, { date: "2026-11-02", value: 1 }]} measure="Page views" />);
    expect(html).toContain("bg-blaze/45");
  });
});
