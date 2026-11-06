import type { ButtonHTMLAttributes, ReactNode } from "react";
import { LogoMark } from "./logo";

const BUTTON = "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm leading-5 font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";

/** The page's main action: ink, since red is the trail and stays off buttons. */
export function PrimaryButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`${BUTTON} bg-primary text-primary-foreground hover:opacity-90 ${className}`} />;
}

export function QuietButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`${BUTTON} border border-input bg-card text-foreground hover:bg-accent ${className}`} />;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border bg-card p-6 ${className}`}>{children}</div>;
}

/** A list of rows in one frame: sites, funnels, people. */
export const ROWS = "divide-y rounded-xl border bg-card";

/**
 * A place with nothing on it yet: an unwalked path, dashed like one on a map. It says why it's empty and
 * what fills it.
 */
export function EmptyState({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex gap-4 rounded-xl border-2 border-dashed p-6 ${className}`}>
      <LogoMark className="mt-0.5 size-6 opacity-80" />
      <div className="min-w-0 flex-1 text-sm text-muted-foreground">
        {title && <h2 className="mb-1 text-base font-semibold text-foreground">{title}</h2>}
        {children}
      </div>
    </div>
  );
}

/** Whether a connection works, at a glance. */
export function StatusDot({ status }: { status: "connected" | "failing" }) {
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${status === "connected" ? "bg-calm" : "bg-alert"}`} />;
}

/** A short label beside a title: a status, a priority. */
export function Badge({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "calm" | "alert" }) {
  const colours = { plain: "text-muted-foreground", calm: "border-calm/40 text-calm", alert: "border-alert/50 text-alert" };
  return <span className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 font-mono text-[11px] ${colours[tone]}`}>{children}</span>;
}

/** A value to copy: an address, a key, a command. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="block rounded-lg border bg-surface px-3 py-2 font-mono text-xs break-all">{children}</code>;
}

/** Several lines to copy: a snippet. */
export function CodeBlock({ children }: { children: ReactNode }) {
  return <pre className="overflow-x-auto rounded-lg border bg-surface px-3 py-2 font-mono text-xs leading-relaxed">{children}</pre>;
}

/** The look of a field beside others in a row, as wide as what it holds. */
export const INLINE_FIELD = "rounded-lg border border-input bg-card px-3 py-2 text-sm leading-5 outline-none transition-shadow focus:border-ring focus:ring-3 focus:ring-ring/20";

/** The look of every text field and list in a form. */
export const FIELD = `w-full ${INLINE_FIELD}`;

/** A label over its field. */
export function Labelled({ label, hint, className = "", children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 text-sm font-medium ${className}`}>
      {label}
      {children}
      {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
    </label>
  );
}
