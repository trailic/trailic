"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavLink {
  href: string;
  label: string;
  /** Other paths that belong to this entry. */
  also?: string[];
}

const LINK = "rounded-sm py-1 whitespace-nowrap transition-colors hover:text-foreground";

/** The way to each part of the app, with the one you're on marked like a footpath on a map. */
export function NavLinks({ links }: { links: NavLink[] }) {
  const pathname = usePathname();
  const isHere = ({ href, also = [] }: NavLink) => [href, ...also].some((path) => pathname === path || pathname.startsWith(`${path}/`));
  return links.map((link) => (
    <Link key={link.href} href={link.href} aria-current={isHere(link) ? "page" : undefined} className={`${LINK} ${isHere(link) ? "trail-underline font-medium text-foreground" : ""}`}>
      {link.label}
    </Link>
  ));
}

/** The same links before the address is known, while a page with a parameter in its path is prerendered. */
export function PlainNavLinks({ links }: { links: NavLink[] }) {
  return links.map((link) => (
    <Link key={link.href} href={link.href} className={LINK}>
      {link.label}
    </Link>
  ));
}
