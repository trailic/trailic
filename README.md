# Trailic

What people do on your Next.js sites: page views, custom events, funnels, retention and journeys, for all of a company's sites, usable from screens and from an assistant (Claude or ChatGPT, through MCP). An npm library plus one app on Next.js and Postgres, with no cloud service you don't control and nothing to run beyond what runs on Vercel. Open source (AGPL-3.0), self-hostable, with no seats or credits. See [docs/00-product.md](docs/00-product.md).

**Under construction.** This is a first version. It works end to end on a test instance with real browsers, a real assistant and five million synthetic events, but it hasn't collected real traffic yet, its Vercel Queues buffer has only run against a stand-in for that service, its data model may change, and it has no upgrade path between versions so far. Don't rely on it as your only analytics yet.

## What works today

- **The library** (`packages/trailic`): `<Trailic siteKey endpoint />` for the App Router counts page views and route changes. `track`, `identify`, `reset`, `setConsent` and a server-side `trackServer`. No dependency beyond React, about 1.5 KB gzipped, and no effect on rendering if the collector is down.
- **Privacy by default**: no cookies, and nothing in storage before `identify`. Anonymous visitors are counted by a daily-rotating salted hash of address and browser, computed server-side, and the address is never stored. Query strings are dropped except `utm_*`, and emails and long tokens are taken out of paths.
- **Collecting**: `POST /api/e` with a public site key, checks on the site's domains, payload limits, rate limits and a bot filter. An event never touches the database: at most, a directory of sites is read once a day to refresh a cache.
- **Buffering**: events wait in Vercel Queues, or a folder on a server of your own, and reach Postgres in batches once an hour, so the database can sleep. A failed write loses nothing and a repeated one counts nothing twice.
- **Storing**: raw events partitioned by month, with retention per site, and daily rollups that stay for good. Row-level security on every table and every partition.
- **Screens**: sites and keys with the setup snippet, an overview per site and across a workspace, custom events, funnels, retention cohorts, journeys, and identified people with deletion of one person's data.
- **Assistants**: an MCP server with `list_workspaces`, `list_sites`, `site_overview`, `top_pages`, `run_funnel`, `run_retention` and `list_events`, which only read, plus `create_site` and, for an instance's admins, `create_workspace`, so an assistant can set up a project.
- **Figures**: `GET /api/v1/figures` per site and per day.
- **Several companies**: workspaces kept apart by row-level security, with a switcher, a team and invitations.

What isn't there yet is listed in [section 9 of the spec](docs/00-product.md#9-planned).

## Setting up a site

Add a site in the app, then in your project:

```bash
npm install trailic
```

```tsx
// app/layout.tsx, inside <body>, once
import { Trailic } from "trailic";

<Trailic siteKey="site_…" endpoint="https://your-instance.example/api/e" />
```

That's all it takes to count page views. [The library's README](packages/trailic/README.md) covers events, identifying people, consent and collecting through your own domain.

### Moving from Vercel Analytics

Swap one component for the other, keep both for a while if you'd like to compare, then remove the old one:

```diff
- import { Analytics } from "@vercel/analytics/next";
+ import { Trailic } from "trailic";

- <Analytics />
+ <Trailic siteKey="site_…" endpoint="https://your-instance.example/api/e" />
```

`track("name", props)` takes the same arguments as Vercel's. History doesn't move across. Expect the numbers to differ a little: Trailic counts a visitor once per site per UTC day and leaves out the bots it recognises.

## Running it locally

You need Node 20 or later, pnpm and Postgres. Docker gives you one:

```bash
docker run -d --name trailic-db -e POSTGRES_PASSWORD=local -e POSTGRES_DB=trailic -p 127.0.0.1:5432:5432 postgres:17-alpine
pnpm install
cp .env.example .env.local   # then fill it in, TRAILIC_DATABASE_URL=postgres://postgres:local@localhost:5432/trailic
pnpm db:migrate
pnpm dev
```

Sign in needs one of the ways below. The quickest locally is `TRAILIC_PASSWORD_SIGN_IN=true` with `RESEND_API_KEY` set, and your address in `TRAILIC_ADMINS`.

Events wait until the flush runs. Locally, call it yourself:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/flush
```

Checks before committing: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build`, and `pnpm test:library` for the library. Tests run against an in-process Postgres (PGlite) and need no database. `pnpm load-test` loads millions of synthetic events into a database on your machine and measures what they cost; it refuses anything but localhost.

## Running your own

It's a Next.js 16 app and a Postgres database. `vercel.json` deploys it on Vercel with its functions in Frankfurt (`fra1`); anywhere that runs Node works too. Apply migrations with `pnpm db:migrate` before starting a new version.

On Vercel, nothing else is needed for the buffer: Vercel Queues is on every plan, in beta, and authenticates by the deployment's own token. Vercel's Hobby plan refuses to deploy a cron job that runs more than once a day, so the hourly flush in `vercel.json` needs Pro. The rate limit in the app counts per server instance; for a hard limit against a flood, add a rule in Vercel's firewall.

Elsewhere than Vercel:

- Set `TRAILIC_BUFFER=file` and point `TRAILIC_BUFFER_DIR` at a disk that lasts, or write another buffer: it's one small port, `EventBuffer` in `src/application/event-buffer.ts`.
- Call `GET /api/cron/flush` hourly and `GET /api/cron/retention` daily, with `Authorization: Bearer <CRON_SECRET>`. With nothing to do they answer without touching the database.
- What the collector and the jobs know about sites is kept with Next's `use cache: remote`. Without a [cache handler](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers) it lives in the server's memory: fine for one server, and it asks the database again after a restart.
- Put it behind a proxy that sets `X-Real-IP` or `X-Forwarded-For`, and `X-Vercel-IP-Country` if you want countries. A visitor's hash reads the address, and without a proxy that overwrites these, anyone can claim any.

### Every environment variable

| Variable | Needed | What for |
|---|---|---|
| `TRAILIC_DATABASE_URL` | yes | Postgres. The role must be able to create tables: raw events get a new partition each month. |
| `TRAILIC_DATABASE_URL_UNPOOLED` | no | The direct address, used by `pnpm db:migrate` when the main one goes through a pooler. |
| `BETTER_AUTH_SECRET` | yes | At least 32 characters (`openssl rand -base64 32`). Signs sessions: changing it signs everyone out. |
| `BETTER_AUTH_URL` | yes | The instance's public address. Snippets and assistants' tokens are built from it. |
| `TRAILIC_SECRET` | to collect | At least 32 characters (`openssl rand -base64 32`). Signs site keys and derives each day's visitor salt. Changing it ends every site key in every project, and makes every visitor new for the rest of that day. |
| `TRAILIC_ADMINS` | yes, to get started | Comma-separated addresses that may sign up and start workspaces. Anyone else joins by invitation, from a workspace's settings. |
| `TRAILIC_BUFFER` | no | `vercel-queue` or `file`. Left out: Vercel Queues on Vercel, a folder elsewhere. |
| `TRAILIC_BUFFER_DIR` | with `file` | The folder. `.trailic-buffer` unless you say otherwise. |
| `TRAILIC_QUEUE_REGION` | no | The region for Vercel Queues, `fra1` unless you say otherwise. Messages can only be read from the region they were sent to, so changing it strands what's waiting. |
| `TRAILIC_PASSWORD_SIGN_IN` | no | `true` allows addresses and passwords. Needs `RESEND_API_KEY`: sign-in stays closed until a mailed link proves the address. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | no | A company's identity provider, any OpenID Connect server, with `<your address>/api/auth/callback/oidc` as its redirect address. It must vouch for each address (`email_verified`), and it is then the only way in. |
| `OIDC_NAME` | no | That provider's name on the sign-in page. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | A Google OAuth app for signing in, with `<your address>/api/auth/callback/google` as its redirect address. |
| `RESEND_API_KEY` | no | The instance's own mail to its members: sign-in links and invitations. Without it, an invitation's link is shown to copy. |
| `TRAILIC_MAIL_FROM` | with `RESEND_API_KEY` | Who that mail is from. |
| `CRON_SECRET` | for the jobs | The bearer the jobs must be called with. Without it, they refuse everyone. |

One of the ways to sign in has to be set: a company's provider, Google, or passwords.

In a project using the library, on its own server: `TRAILIC_SITE_KEY` and `TRAILIC_ENDPOINT` for `trackServer`, and `TRAILIC_URL` and `TRAILIC_RELAY_KEY` for the relay.

## Connecting an assistant

The MCP server is at `/api/mcp`. Add that address to Claude, ChatGPT or any MCP client as a remote connector: the client registers itself, you sign in and approve it, and it works inside your workspaces with their rules. If you belong to several, one connection covers them all and the assistant says which one on every call.

## License

Trailic is free software under the [GNU Affero General Public License v3.0](LICENSE): run it, study it, change it and share it; if you offer a modified version to others over a network, publish your changes under the same license.
