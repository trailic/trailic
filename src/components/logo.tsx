import { BRAND } from "@/domain/brand";

/** The mark: a lowercase t that is a signpost. The stem is the path, hooking away at its foot; the crossbar is a pointed sign. */
export function LogoMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={`shrink-0 ${className}`}>
      <path d="M13 4.5V21.5c0 3.7 2.3 6 6 6h2.5" fill="none" strokeWidth={3.6} strokeLinecap="round" className="stroke-foreground" />
      <path d="M6 9h16l4.5 4.2L22 17.4H6c-.8 0-1.5-.7-1.5-1.5v-5.4C4.5 9.7 5.2 9 6 9Z" className="fill-mark-plate" />
    </svg>
  );
}

/** Mark and wordmark, set in the signage face, tight. */
export function Logo() {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <LogoMark />
      <span className="translate-y-px truncate font-heading text-[1.2rem] leading-none font-bold tracking-[-0.03em]">{BRAND}</span>
    </span>
  );
}
