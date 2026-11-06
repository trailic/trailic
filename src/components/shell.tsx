import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { mayStartWorkspace } from "@/application/workspaces";
import { currentMember, workspacesInBrowser, type Member } from "@/infrastructure/auth/session";
import { env } from "@/infrastructure/env";
import { Logo } from "./logo";
import { NavLinks, PlainNavLinks, type NavLink } from "./nav-links";
import { SignOutButton } from "./sign-out-button";
import { WorkspaceMenu } from "./workspace-menu";

const NAV: NavLink[] = [
  { href: "/overview", label: "Overview" },
  { href: "/events", label: "Events" },
  { href: "/funnels", label: "Funnels" },
  { href: "/retention", label: "Retention" },
  { href: "/journeys", label: "Journeys" },
  { href: "/people", label: "People" },
  { href: "/sites", label: "Sites" },
  { href: "/settings", label: "Settings", also: ["/keys"] },
];

/** Which workspace this is and the way to another. With nothing else to reach, there's nothing to choose and nothing shows. */
async function WorkspaceSwitcher({ member }: { member: Member }) {
  const { workspaces, active } = await workspacesInBrowser(member.userId);
  const mayStart = mayStartWorkspace(member.email, env());
  if (!active || (workspaces.length === 1 && !mayStart)) return null;
  const others = workspaces.filter(({ id }) => id !== active.id).map(({ id, name }) => ({ id, name }));
  return <WorkspaceMenu current={active.name} others={others} mayStart={mayStart} />;
}

/** Who is signed in and where, streamed in once the session is read. */
async function WhoIsSignedIn() {
  const member = await currentMember();
  if (!member) return null;
  return (
    <span className="flex min-w-0 items-center gap-3 text-sm text-muted-foreground">
      <WorkspaceSwitcher member={member} />
      <SignOutButton />
    </span>
  );
}

/** The frame of the app's pages: the mark, what's reachable, who is signed in. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-30 border-b bg-background">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-8 gap-y-2 px-4 py-3">
          <Link href="/overview" aria-label="Overview" className="rounded-sm">
            <Logo />
          </Link>
          <nav aria-label="Main" className="order-last flex w-full flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground lg:order-none lg:w-auto lg:flex-1">
            <Suspense fallback={<PlainNavLinks links={NAV} />}>
              <NavLinks links={NAV} />
            </Suspense>
          </nav>
          <Suspense>
            <WhoIsSignedIn />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 md:py-10">{children}</main>
    </div>
  );
}

/** A page's heading and the sentence that says what it's for. */
export function PageHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-8">
      <h1 className="text-3xl font-bold tracking-[-0.03em] md:text-4xl">{title}</h1>
      {children && <p className="mt-2 max-w-2xl text-muted-foreground">{children}</p>}
    </div>
  );
}

/** Quiet placeholder while the server reads the workspace. */
export function Loading() {
  return <p role="status" className="font-mono text-xs text-muted-foreground">Loading…</p>;
}
