import { Suspense } from "react";
import { NavLinks, PlainNavLinks } from "./nav-links";

const SECTIONS = [
  { href: "/settings", label: "Workspace" },
  { href: "/keys", label: "API keys" },
];

/** The settings' sections, the same at the top of each. */
export function SettingsNav() {
  return (
    <nav aria-label="Settings" className="mb-8 flex flex-wrap gap-x-5 gap-y-1 border-b pb-3 text-sm text-muted-foreground">
      <Suspense fallback={<PlainNavLinks links={SECTIONS} />}>
        <NavLinks links={SECTIONS} />
      </Suspense>
    </nav>
  );
}
