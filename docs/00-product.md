# Trailic

> Status: under construction. What people do on a company's sites, from an npm library to one app on Next.js and Postgres, usable from screens and from an assistant.

## 1. What it does

A company with many Next.js sites shouldn't need a cloud service to know what happens on them, and shouldn't pay for it per seat or per event. Trailic is what you add to each project in a few lines, and one app that holds it all.

1. **Workspaces and sites.** A workspace is a company. A site is what it measures: a name, the domains its pages send from, a public key, and how long raw events stay.
2. **Events.** Four kinds: a page view, a custom event, an identify, and a web vital. Each has a moment, a path, and what's known about who and from where.
3. **Visitors.** Someone anonymous is a hash that lasts one day on one site. Someone a site identifies is a person, on that site, across days and devices.
4. **Rollups.** Each day's figures per site, per page, referrer, UTM tag, country, device, browser, system and custom event. Dashboards read these, and they stay when raw events go.

All days are UTC.

## 2. The library

`packages/trailic`, published as `trailic`. React is its only peer, and nothing else is bundled: about 1.5 KB gzipped.

```tsx
<Trailic siteKey="site_…" endpoint="https://your-instance.example/api/e" />
```

| What | Does |
|---|---|
| `<Trailic>` | Counts the page it starts on, and every move through the history API, which is what Next's router moves with. It renders nothing. Props: `siteKey`, `endpoint`, `consent`, `respectPrivacySignals`. |
| `track(name, props)` | A custom event. Props are strings, numbers and booleans, 16 at most. |
| `identify(userId, traits)` | Who this is from here on. Only when a project calls it, typically after sign-in. |
| `reset()` | Forgets them, typically at sign-out. |
| `setConsent(granted)` | The same as the `consent` prop, from anywhere. |
| `optOut()`, `optIn()`, `isOptedOut()` | The visitor objects, or takes it back. It's remembered in `localStorage` once they choose, and `<Trailic>` honours it on every page. |
| `<TrailicOptOut stop resume />` | `trailic/opt-out`, a separate import: a button for a privacy page. |
| `trackServer(name, props, options)` | `trailic/server`, for route handlers. It says whether the event was taken and never throws. |
| `<TrailicVitals />` | `trailic/vitals`, optional and a separate import: LCP, CLS and INP. |
| `trailicRewrite()`, `trailicRelay()` | `trailic/next`, to collect through the project's own domain. |

**Batches.** Events wait up to 5 seconds, or until there are 10, and go in one request. On page hide they leave by `sendBeacon`. Everything is sent as JSON in a `text/plain` body, which a page can post to another domain with no preflight, so a page view costs one request. A collector that's down changes nothing on the page: every failure is swallowed, nothing is retried, and what can't leave stays in memory, 50 events at most.

**Through your own domain.** With a collector on Vercel, use the relay: a route of yours passes the visitor's address and country on, with a key from the site's page proving it's the site's own. A plain rewrite can't do that between two Vercel projects: Vercel overwrites `X-Forwarded-For` on what it receives, so the collector would see the proxy's address and every visitor behind it would merge into one. The rewrite is there for a collector you run behind your own proxy.

## 3. Privacy

**What's collected.** The path of the page, with its query dropped except for `utm_*` tags on a site that isn't in anonymous mode, and emails and long tokens replaced by `[email]` and `[token]`. The referrer's host, on the first page of a load, unless it's the site itself. The events and traits the site sends. From the request: a country, a coarse device (desktop, mobile, tablet), browser and system, and the hash below.

**What isn't.** No address is stored, anywhere: the buffer and the database never see it. No user agent is stored. No cookie is ever set. Nothing is kept in the browser until `identify`, which keeps the id it was given in `localStorage`, and `reset` removes it, or until a visitor objects with `optOut`, which `optIn` removes.

**The hash.** `sha256(salt, site, address, user agent)`, where the salt is derived from `TRAILIC_SECRET` and the day. So the same person is someone else tomorrow, and on another site. Everyone behind one address with the same browser is one visitor, which is a known undercount. Whoever holds `TRAILIC_SECRET` and knows someone's address and browser could work out that person's hash for any day: it stops anyone reading who visited from the database, not someone with the secret and a suspect.

What follows from this: a visitor is one per site per day, so a period's visitors add its days up. Across sites, a workspace's visitors add its sites up. Only identified people can be followed from one day to the next. Retention counts only them, and someone anonymous can only convert in a funnel within a day.

**The hash a sender is counted by.** To count requests from one address across all sites, the collector keeps a second hash in memory: the address, or an IPv6 address's /64, under a key of its own derived from `TRAILIC_SECRET`. It shares nothing with the hash above, it stays in one server instance's memory until the next request after its minute, and it's never stored, sent or logged.

**Anonymous mode.** A setting per site, on unless someone who manages the workspace's settings turns it off on the site's page. On, the collector shortens the address before hashing it (IPv4 to /24, IPv6 to /48), keeps no UTM tags, and refuses `identify`, dropping any user id or traits sent with an event. It never counts anything in a sign-in, account, admin or profile area: a path that starts, after any locale, with `/login`, `/signin`, `/sign-in`, `/signup`, `/sign-up`, `/register`, `/logout`, `/auth`, `/reset-password`, `/forgot-password`, `/admin`, `/account`, `/dashboard`, `/settings`, `/u`, `/user`, `/users`, `/profile`, `/profil`, `/me`, `/onboarding`, `/favorites` or `/portal`, matched on whole segments, so `/admin-tools-guide` and `/universities` still count. The list is `PERSONAL_AREAS` in `src/domain/anonymous.ts`. An app kept under some other path can't be told apart, so such a site should leave that part out itself. So more people count as one visitor, campaigns can't be measured, and funnels and retention that follow someone across days have nobody to follow. Off, for a site that needs those and has dealt with what that asks of it, the whole address goes into the hash and everything else below applies. When the collector can't tell which a site asked for, it assumes on, since what it keeps can't be taken back later. A change reaches the collector within a minute and rewrites nothing already collected. Figures are exact counts in both states, with no rounding: a known gap, since a page with very few visits can be told apart. This setting decides what's collected, and it says nothing about what law applies.

**Identifying.** Only with anonymous mode off. What a visitor did in the half hour before `identify` becomes theirs, on the same hash, so a funnel that starts anonymous and ends signed in stays one person's. Two people behind one address with the same browser can be mixed up in that half hour. That's as far as a hash should be trusted, which is why it's no longer than that.

**Objecting.** A visitor can opt out, through `optOut()` or the `<TrailicOptOut>` button on a privacy page. Nothing more leaves that browser, what was waiting goes, and what `identify` kept is removed. The choice stays in `localStorage` under `trailic.optOut`, and nothing is stored until they make it.

**Choices for a site.** `consent={false}` holds everything in memory until it turns true; nothing is sent or stored before that. Withdrawing it removes what `identify` kept. `respectPrivacySignals` sends nothing for a browser saying Do Not Track or Global Privacy Control; it's off by default, because nothing here follows anyone across sites, but that's the site's decision.

**Consent obligations are the site owner's.** Whether a site must ask, and what it must tell its visitors, depends on where it runs and what it does. This isn't legal advice. Trailic gives the means, and says plainly what it does so that a site's owner can decide.

**Erasing someone.** A person's page has a button for when they ask: their events, their traits, and their part in the days whose raw events are still there go at once. What's still in the buffer about them is dropped when it arrives, by a hash of who they were, kept for eight days and no longer. Days whose raw events have aged out are counts with nobody in them and stay as they are. If the site identifies them again later, they're someone new.

**What a site's id holds.** `userId` and traits are whatever a project sends. Prefer an opaque id to an address.

## 4. Collecting

`POST /api/e`, as JSON in the body, from any browser or server.

**The collector's own address.** A site's pages name the collector, in their code and in any Content-Security-Policy. With `TRAILIC_COLLECTOR_URL` set, they name that address instead of the instance's, on the site's page and from `create_site`, so what a visitor can read says that the site uses Trailic and nothing about whose instance it is. Only `/api/e` answers there: everything else gets an empty 404, so the address leads nowhere.

```json
{ "key": "site_…", "events": [{ "kind": "page", "path": "/pricing?utm_source=news", "referrer": "https://news.example/a", "ago": 120 }] }
```

An event never touches the database: the one read here is the directory of sites, about once a day, and whenever a site changes or a new version is deployed. In order:

- **Size.** 32 KB and 20 events at most: `413` or `400`. One bad event is dropped without losing the rest.
- **The key.** It's signed by the instance and says which site it's for, so a forged one gets `404` for free.
- **The sender and the instance.** 600 requests a minute from one address across every site, a whole IPv6 /64 counting as one, and 6,000 a minute for everything an instance takes, each counted in that instance's memory: `429` with `Retry-After`, and nothing below this line runs. A relay's visitors count as themselves once its key proves it speaks for them. A request with no address to go by counts towards the instance only.
- **The site.** Its domains come from a directory of every site, kept in the platform's cache, one read a day and cleared when any site changes, and in a server instance's memory for a minute. If the directory can't be read in 1.5 seconds, the events are kept anyway and the flush checks them.
- **The origin.** A browser must come from an allowed domain or a subdomain of one: otherwise `403`. CORS answers only those, and a client posting JSON rather than plain text, which costs a preflight with no body to read, names its key in the address as well: `/api/e?key=site_…`. A server sends `server: true`, and no browser can: it has no origin to check, only custom events are taken, and no visitor is counted.
- **Bots.** Known crawlers, headless browsers, monitors, and anything with no user agent or fetching ahead of time get an ordinary `202` and nothing is kept.
- **Limits.** 120 requests a minute per visitor and 3,000 per site, half of what an instance takes so that a flood aimed at one site leaves the others room, counted in each server instance's memory: `429` with `Retry-After`. Only what passes these uses up the instance's 6,000.
- **The buffer.** Only what the buffer has kept is answered `202`. If it can't, `503`.

Site keys are public, so anyone can send fake events to a site, as with any analytics of this kind. Domains and limits make it harder, not impossible.

**A refused event is lost.** Nothing retries it, and all that's left is one line a minute per instance with the number each limit refused: no address, hash, key or site. So the limits sit where real traffic can't reach them. One real instance, measured at about 300,000 page views a month, averages 7 requests a minute across all its sites, and has reached 39 in its busiest minute so far. That's 15 times under one sender's limit even if every visitor of every site shared one address, as people behind an office's or a mobile carrier's address partly do, and 150 times under the instance's.

### What a flood can cost

Prices are Vercel's public ones for `fra1`, in November 2026. What a request costs, by how far it gets:

| Where it stops | Answer | Queue operations | Database |
|---|---|---|---|
| Over 32 KB, not JSON, over 20 events | `413`, `400` | none | none |
| A forged key | `404` | none | none |
| Over the sender's or the instance's limit | `429` | none | none, nor a look at the directory |
| A real key that was replaced | `404` | none | none: a read of the platform's cache |
| An origin that isn't the site's | `403` | none | none |
| A known bot | `202` | none | none |
| Over the site's or the visitor's limit | `429` | none | none |
| Kept | `202` | one send per 4 KiB | none until the flush |

Origins and bots stop browsers and honest clients. A script writes any `Origin` and `User-Agent` it likes, or says `server: true` and needs no origin at all, and keys are in every page. So what bounds the queue is the limits.

Reaching the project costs money before the app answers anything, so the worst case comes in two parts:

- **Reaching it**, whatever the answer: $2.60 per million CDN requests and $0.60 per million function invocations, so $3.20 per million, plus $0.06 per GB of body. The app can't lower this. A thousand requests a second is 86.4 million a day: $276, or about $450 with every body at 32 KB. The app's own work on a refused request is next to nothing, about 0.1 ms of CPU, under a cent per million. Only the firewall takes this away: what it stops pays no CDN request and no transfer, and never reaches a function.
- **Being kept**, $0.78 per million queue operations. An instance takes at most 6,000 requests a minute, 8.64 million a day: **$6.74 a day** in ordinary batches, since ten page views fit in one operation, and **$67 a day** if every request is the largest message there can be, 37 KB, ten operations. One address gets a tenth of that. An instance kept this busy can add about $5 a day of CPU and memory.

The flush reads for four minutes an hour at most, so reading and acknowledging stays under about $5 a day, and the database's work stays bounded, whatever is waiting. Fake events it does write stay until the site's retention ends.

What these limits leave open:

- **They count per instance.** Windows live in memory, as they must for an event not to touch a database, so the figures above multiply by however many instances the platform runs, which a big enough flood raises. A new instance starts with empty windows, and a fixed window lets twice the limit through across the turn of a minute.
- **Many addresses.** A botnet stays under each sender's limit and is only stopped by the instance's, and it can use up that allowance so that real visitors' events are refused until the next minute.
- **Size isn't counted.** A request counts as one however large its message.
- **A long flood outruns the flush**, which then runs behind by what it can't read in an hour. Messages live seven days, so real events waiting behind fake ones can be lost after that.
- **A relay's key.** Whoever holds it can name any visitor address, so only the site's and the instance's limits apply to them. It stays on the server: if it leaks, replace it.
- **Fake events under the limits.** One address can still put 600 requests a minute into a site's figures. The limits cap the bill, not the truth of what's counted.
- **Off Vercel**, a sender is only as real as the proxy in front. Vercel overwrites `X-Forwarded-For`. Without a proxy that does the same, anyone can claim any address, and only the instance's limit holds.

### The outer limits

The app's limits protect the queue. These two protect the bill, and an instance on Vercel should have both before it's public.

**A firewall rule**, which stops one address before it costs anything, in every instance at once:

1. In the project, open **Firewall**, then **Configure**, then **+ New Rule**.
2. Name it `Collector flood`. Under **If**, choose **Request Path**, **Equals**, `/api/e`.
3. Under **Then**, choose **Rate Limit**, with **Fixed Window**, a **Time Window** of `60` seconds, a **Request Limit** of `600` and the **IP** key. Leave the action on **Default (429)**.
4. Choose **Save Rule**, then **Review Changes**, then **Publish**.

Or, with the CLI:

```bash
vercel firewall rules add "Collector flood" --project <project> --condition '{"type":"path","op":"eq","value":"/api/e"}' --action rate_limit --rate-limit-algo fixed_window --rate-limit-window 60 --rate-limit-requests 600 --rate-limit-keys ip
vercel firewall diff --project <project>
vercel firewall publish --project <project>
```

What it stops is free. What it allows costs $0.65 per million requests, about 20 cents a month at 300,000 page views. Unlike the app, it can't tell a relay's visitors apart: if your sites relay and one of them sends more than 10 requests a second, raise the limit for all rather than exempting a header, which anyone could send. Leave `/api/e` out of **Attack Mode** and **Bot Protection**, or keep them off: a page's beacon can't answer a challenge, so every event would be lost.

**Spend Management**, for what comes from many addresses, which no rule can stop. It's on Pro, for the whole team, and it's the only limit that holds whatever the app and the flood do:

1. In the team, open **Settings**, then **Billing**, then **Spend Management**, and turn it on. You need the Owner or Billing role.
2. Set the **On-Demand Budget** in dollars, per billing cycle, above an ordinary month.
3. Turn on **Pause Production Deployments** if you'd rather stop than pay, and add a webhook if you'd like to be told at 50%, 75% and 100%. Add your phone under **My Notifications** to get a text at 100%.

Or `vercel budgets set --amount <dollars> --pause --webhook <address>`, which CLI 65.11 and later call `vercel billing budgets`.

Vercel checks every few minutes, so a flood runs on for a few minutes past the amount. And pausing stops the production deployment of **every project in the team**, until each is resumed by hand. On a team that also hosts sites you can't lose, a flood on the collector takes them down with it. If that matters more than the bill, give the collector a team and a budget of its own, or have the webhook pause only the collector, with `POST /v1/projects/{id}/pause`. Sites keep working while their collector is paused: they lose those events, nothing else.

## 5. Buffering

A serverless database bills by the hour it's awake, and at a steady trickle of events, per-event inserts would never let it sleep. So events wait in a buffer, and a job writes them in batches on the hour. An empty buffer doesn't wake the database, and a dashboard reads data up to an hour old, saying how old.

The buffer is one small port, `EventBuffer`: append a batch; claim some; each is then done or given back.

| | Vercel Queues (the default on Vercel) | A folder (the default elsewhere) |
|---|---|---|
| Status | In beta, on all plans | Yours |
| Holds a batch for | 7 days, the longest a message may live | Until it's written |
| Delivery | At least once, leased for 15 minutes | At least once, leased for 15 minutes |

Vercel Blob was the other candidate. It's generally available and keeps things for ever, but a put costs about seven times a queue's operation, reading one back counts as a CDN request too, and uploads are limited to 75 a second on Pro. In `fra1`, per million collector requests, Queues comes to about $1.70 (a send, a tenth of a receive, an acknowledgement, at $0.78 per million operations), and Blob to about $8.40 (a put at $5.40, a read at $0.43 and $2.60 for its CDN request). A topic also needs no listing or deleting, and its leases are what a flush wants. Being in beta is the risk, and the port is the answer to it.

A flush reads the queue's HTTP API rather than its SDK, whose `receive` acknowledges each message when its handler returns, one at a time, where a flush holds a thousand until one transaction has written them. No deployment is pinned, so a flush reads what the last deployment collected, and messages are sent to a fixed region, so they can be read back. Vercel doesn't yet promise that a message never leaves its region during a failover. No address is ever in one.

**What happens when a flush fails.** Each workspace's batches are written in one transaction: the ledger of batch ids, the events, the people, the day's rollups. If it fails, nothing is written, the batches go back to the buffer, and the next run tries again, with other workspaces unaffected. If the database doesn't answer within 20 seconds, the flush gives everything back and says so with a `503`. On Vercel Queues that can go on for a week; after that, a message expires and those events are gone.

**What happens when it succeeds and then dies.** A batch written but not acknowledged is delivered again, finds its id in the ledger, and adds nothing. So a batch is counted once, however often it's delivered. Rollups are rebuilt from raw rows rather than added to, so doing that twice is the same as once.

A batch that makes no sense, or for a site that's gone, or from a domain the flush finds isn't allowed, is dropped on purpose and counted in the report.

## 6. Storing

Postgres, with no extension. Raw events are in `event`, partitioned by month, made as events need them. Each partition carries its own row-level security, policy and grants, since a partition read directly doesn't go through its parent's.

**Retention.** 90 days of raw events by default, between 14 and 730 per site. A daily job deletes whole days past each site's retention, and drops a month's partition once no site keeps anything from it. Someone unseen for as long is forgotten too, traits and all. Rollups stay until the site is deleted.

**Row-level security.** Every table that belongs to a workspace has it, and a test reads the database to fail on any that hasn't, partitions included. Flushes and screens run as the restricted role, bound to one workspace.

**Importing history.** A site that moves here from another tool can bring its daily figures, so its charts don't start from nothing. It's for whoever runs the instance, not for a key: `pnpm import-history history.ndjson --source "Another tool" --counts "every page view it recorded" [--note "…"] [--dry-run]`, with the file holding one JSON object per line and a site's lines together.

```json
{ "site": "…", "day": "2026-09-30", "visitors": 2, "pageViews": 3, "events": 1, "bounces": 1, "dimensions": { "page": [{ "value": "/pricing", "count": 2, "visitors": 1 }], "referrer": [{ "value": "(direct)", "count": 3, "visitors": 2 }], "event": [{ "value": "signup", "count": 1, "visitors": 1 }] } }
```

Dimensions are those of the rollups, each optional. A visitor is what it is here: who saw a page that day. A site's figures go in one transaction, as the restricted role.

- **What's kept.** The counts are taken as given, and the values get the collector's rules: paths are cleaned, a site in anonymous mode keeps no UTM tags and doesn't count personal areas, which come off the day's page views too. No raw row is written, and nobody in it can be followed.
- **A day has one source.** An import writes only whole days before the first one the site collected, so it can't overlap what's here, and a late event on an imported day stays in the raw rows and leaves that day's figures alone. The day a site starts collecting is its own, so it's usually a short one.
- **Doing it again.** A source's import for a site is one thing: the same figures write nothing, and other figures replace only what that source wrote.
- **What a member sees.** Imported days are paler on the chart and marked in its table, and a note beside the figures says where they came from, what they count, and the note given. `/api/v1/figures` and its breakdown say `imported: true` on such a day, and the tools that read figures carry the same. An app reading figures with a key gets those days in the same series, so its charts reach further back: it reads them as ordinary figures unless it checks `imported`, which it should if the difference matters to it. A site's page lists its imports, and an owner or an admin can remove one.
- **What they can't do.** Funnels, retention, journeys and people read raw rows, so they don't reach imported days. The rollups stay for good, like any others.

**What it costs.** Measured with `pnpm load-test` on Postgres 17 limited to one CPU and 4 GB: 5 million synthetic events over 120 days on 30 sites, the biggest with a quarter of the traffic, so about 950,000 events in its last 90 days.

| | One CPU | A quarter of a CPU |
|---|---|---|
| Raw events | 1.64 GB: 640 MB of rows and 1 GB of indexes, about 340 bytes an event | |
| Rollups | 139 MB | |
| A flush of 4,500 batches | 4 s | 36 s |
| Overview, biggest site, 90 days | 70 ms | 200 ms |
| Overview, all sites, 90 days | 600 ms | 2.7 s |
| Funnel, three steps, biggest site, 90 days | 130 ms | 700 ms |
| Retention, 13 weeks | 150 ms | 700 ms |
| Journeys from a page few visitors start on, 90 days | 200 ms | 1.1 s |
| Journeys from the biggest site's top page, 30 days | 1.6 s | 7.4 s |
| Journeys from the biggest site's top page, 90 days | 3.5 s | 20 s |

Journeys follow each visitor who reached the page, about 300,000 in that last case, so they're the one thing here that grows with a page's traffic rather than with what's asked.

## 7. Screens

- **Sites** (`/sites`). Each with its key, setup snippet, relay key, domains, retention and imported history. Replacing a key ends the old one. Owners and admins change these.
- **Overview** (`/overview`). Per site or across a workspace: visitors, page views, events, bounce rate, a chart per day, top pages, referrers, UTM tags, countries, devices, browsers, systems, and web vitals if sent. Imported days are marked.
- **Custom events** (`/events`). Each with its count, visitors and days.
- **Funnels** (`/funnels`). A funnel is two to eight steps, each a page (a trailing `*` matches anything under it) or an event, and how long people have from the first step. It shows how many reached each step, in order, and how many stopped there.
- **Retention** (`/retention`). Cohorts by the Monday of the week someone was first identified, and what share came back each week after, by any activity or by a chosen event.
- **Journeys** (`/journeys`). From a page: each visitor's first time on it that day, and the next three pages within half an hour, most common first.
- **People** (`/people`). Whoever a site identified, one person's recent activity and traits, and the way to erase them.
- **Settings.** The team and invitations, connecting an assistant, API keys.

Every page says when data was last written. Funnels, retention, journeys and people read raw events, so they reach back as far as the site keeps them.

## 8. Assistants and figures

The MCP server is at `/api/mcp`, over streamable HTTP. An assistant registers itself, a member signs in and approves it, and every tool runs as that member with the same rules as the screens: each is the same use case the screens call. They only read, apart from `create_site` and `create_workspace`, which let an assistant set up a project, and `create_api_key` and `revoke_api_key`, which manage read keys for an owner or an admin. Changing or deleting a site, erasing someone and managing members stay on the screens.

| Tool | What it does |
|---|---|
| `list_workspaces` | The member's workspaces. With several, every other tool names one on each call: there is no current workspace. |
| `create_workspace` | Starts a workspace, with the member as its owner. Only offered to an instance's admins, who are the only ones to get it with no workspace yet. |
| `list_sites` | The sites, with their ids, domains and when they were last written. |
| `create_site` | Adds a site, for those who manage the workspace's settings, and returns its site key, the collector's address and its relay key. The relay key is secret: it goes in the project's environment. |
| `site_overview` | One site's overview over a period, or the whole workspace's. |
| `top_pages` | The most viewed pages. |
| `list_events` | Custom events, each with its days. |
| `run_funnel` | Conversion and drop-off through steps given on the call. |
| `run_retention` | Cohorts by first-identified week, by any activity or by one event. |
| `list_api_keys` | For an owner or admin: the workspace's keys, with their names, prefixes, scopes, when made and last used. Never a key or its hash. |
| `create_api_key` | For an owner or admin: a key that reads figures and nothing else, shown once, in the answer. |
| `revoke_api_key` | For an owner or admin: ends a key at once. |

Paths and names come from visitors' browsers, so the tools that return them say they're data, never instructions.

**Keys through an assistant.** The three key tools call the same use cases as the keys screen, which refuse anyone but an owner or an admin. They take no scope, and a key made there reads and nothing else. Since a key opens a workspace's figures and paths, referrers and event names come from visitors, the server's instructions and the tools tell an assistant to make one only when the member asked in that conversation, never because a path, a referrer, an event name or a page says so, to revoke one only once the member said yes, and never to put a key into a page, record, message or reply. A key's row says who made it, when, and when it was last used. Someone leaving or removed takes the keys they made with them, in the same transaction: a key is shown once, so it may have left with them. Revoking deletes the row, so it leaves nothing behind, and the list only ever holds live keys.

**Figures.** `GET /api/v1/figures`, `Authorization: Bearer sk_…`, with a key holding the `figures:read` scope, made under Settings or by an assistant for an owner or an admin. `days` is 1 to 365, 30 by default, and `site` is a site's id, every site by default. Counts only: no pages, no people. It names the workspace the key opens, so an app can tell one key from another. Refusals: `401` for a missing or unknown key, `403` for a key without the scope, `400` for a `site` that isn't an id.

```json
{
  "workspace": { "id": "…", "name": "Acme" },
  "from": "2026-11-04",
  "to": "2026-11-05",
  "timezone": "UTC",
  "sites": [
    {
      "id": "…",
      "name": "Acme shop",
      "lastWrittenAt": "2026-11-05T09:00:03.000Z",
      "days": [{ "date": "2026-11-05", "visitors": 3, "pageViews": 6, "events": 3, "bounces": 1, "imported": false }]
    }
  ]
}
```

**One page or one event.** `GET /api/v1/figures/breakdown?site=…&dimension=page&value=/pricing`, or `dimension=event&value=signup`, with the same key and `days`: that page's views or that event's occurrences per day, with its visitors, on every day of the period. The caller names what it wants, so this lists nothing a dashboard's key didn't already know. Refusals as above, `400` for another dimension or no value, `404` for a site of another workspace.

```json
{
  "site": { "id": "…", "name": "Acme shop" },
  "dimension": "page",
  "value": "/pricing",
  "from": "2026-11-04",
  "to": "2026-11-05",
  "timezone": "UTC",
  "days": [{ "date": "2026-11-05", "count": 2, "visitors": 1, "imported": false }]
}
```

## 9. Planned

None of this exists yet:

- Session replay.
- Automatic capture of every click.
- Heatmaps.
- Feature flags and A/B tests.
- Surveys.
- Account health.
