import { z } from "zod";

/**
 * What the app needs from its environment: its database, its sign-in, the secret its site keys and
 * visitor hashes come from, where it buffers events, and its own mail.
 */
const schema = z.object({
  TRAILIC_DATABASE_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  /** Who may sign up and start workspaces: comma-separated emails. Anyone else needs an invitation, and can only join. */
  TRAILIC_ADMINS: z.string().default(""),
  /** Signs site keys and derives each day's visitor salt. Changing it ends every site key in every project. */
  TRAILIC_SECRET: z.string().min(32).optional(),
  /** Where events wait for the database: Vercel Queues, or a folder for a server with a disk. */
  TRAILIC_BUFFER: z.enum(["vercel-queue", "file"]).optional(),
  TRAILIC_BUFFER_DIR: z.string().default(".trailic-buffer"),
  /** Messages can only be read from the region they were sent to, so it is fixed. */
  TRAILIC_QUEUE_REGION: z.string().default("fra1"),
  /** A company's own identity provider (any OpenID Connect server): when set, members sign in there and nowhere else. */
  OIDC_ISSUER: z.url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  /** Its name on the sign-in page. */
  OIDC_NAME: z.string().default("SSO"),
  /** Whether members may sign in with an address and a password; a company's provider stays the only way in when set. */
  TRAILIC_PASSWORD_SIGN_IN: z.stringbool().default(false),
  /** Google's OAuth app, for signing in unless a company's provider is set. */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** The instance's own mail to its members (sign-in links, invitations), through Resend. */
  RESEND_API_KEY: z.string().optional(),
  TRAILIC_MAIL_FROM: z.string().default("Trailic <no-reply@example.com>"),
  /** The scheduled jobs are called with this bearer. */
  CRON_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let parsed: Env | undefined;

/** A variable left blank means not set: `.env.example` is copied with most of them empty, and an empty address isn't an address. */
export const withoutBlanks = (values: Record<string, string | undefined>) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));

/** The environment, read once and checked. */
export function env(): Env {
  parsed ??= schema.parse(withoutBlanks(process.env));
  return parsed;
}

/** Whether this email may sign up without an invitation and start workspaces. */
export function isAdmin(email: string, settings: Pick<Env, "TRAILIC_ADMINS"> = env()): boolean {
  return settings.TRAILIC_ADMINS.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .includes(email.trim().toLowerCase());
}
