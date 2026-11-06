# trailic

Page views and events from a Next.js site to your own Trailic instance. No cookies, nothing in storage before you call `identify`, and no dependency beyond React.

## Setup

Until it's on npm, install it from its release:

```bash
npm install https://github.com/trailic/trailic/releases/download/v0.1.1/trailic-0.1.1.tgz
```

```tsx
// app/layout.tsx
import { Trailic } from "trailic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Trailic siteKey="site_…" endpoint="https://trailic.example.com/api/e" />
      </body>
    </html>
  );
}
```

That counts page views, route changes included. The site's key is on its page in the app.

## Events and people

```ts
import { identify, reset, track } from "trailic";

track("signup", { plan: "pro" });          // numbers, strings and booleans
identify("user_123", { plan: "pro" });     // after sign-in. Only now is anything kept in the browser
reset();                                   // at sign-out
```

From a route handler:

```ts
import { trackServer } from "trailic/server";

await trackServer("payment", { amount: 49 }, { siteKey: "site_…", endpoint: "https://trailic.example.com/api/e", userId: "user_123" });
```

It never throws, and answers whether the collector took the event. `siteKey` and `endpoint` fall back on `TRAILIC_SITE_KEY` and `TRAILIC_ENDPOINT`.

## Through your own domain

With a collector on Vercel, use the relay: a route of yours says who the visitor is, with a key from the site's page. A rewrite can't: Vercel overwrites `X-Forwarded-For` on what it receives, so the collector would see the proxy's address and country, and every visitor would merge into one.

```ts
// app/trailic/e/route.ts. TRAILIC_URL and TRAILIC_RELAY_KEY are read from the environment.
import { trailicRelay } from "trailic/next";

export const POST = trailicRelay();
```

```tsx
<Trailic siteKey="site_…" endpoint="/trailic/e" />
```

With a collector you run behind your own proxy, which passes the visitor's address on, a rewrite is enough:

```ts
// next.config.ts
import { trailicRewrite } from "trailic/next";

export default { rewrites: async () => [trailicRewrite("https://trailic.example.com")] };
```

Through a rewrite, the browser's cookies for your domain travel with a beacon. The collector neither reads nor keeps them.

## Privacy

What leaves the browser: the page's path with its query removed except for `utm_*` tags, emails and long tokens in the path replaced by `[email]` and `[token]`, the referrer on a load's first page, the events you record, and what you pass to `identify`. The collector cleans all of that again, since anyone can post to a public address.

What's kept in the browser: nothing, until `identify`, which keeps the id you gave it in `localStorage` under `trailic.user`. `reset()` removes it. No cookies, ever.

Anonymous visitors are counted server-side by a hash of their address and browser, salted per day and per site. The address isn't stored. The same person is someone else tomorrow, and on another of your sites. So only people you identify can be followed from one day to the next.

**Consent.** `consent={false}` holds everything in memory until it turns true, and nothing is sent or stored before that. `setConsent()` does the same from anywhere. Withdrawing it removes what `identify` kept.

**Objecting.** `optOut()` stops everything for this visitor and remembers it in `localStorage`, under `trailic.optOut`, only once they've chosen. `optIn()` takes that back, and `isOptedOut()` says which it is. `<Trailic>` honours the choice on every page. For a privacy page there's a button that does it all, in a separate import so that other pages don't carry it:

```tsx
import { TrailicOptOut } from "trailic/opt-out";

<TrailicOptOut stop="Stop measuring my visits" resume="Measure my visits again" />
```

**Do Not Track and Global Privacy Control.** `respectPrivacySignals` sends nothing for a browser that says either. It's off by default, because what's counted here doesn't follow anyone across sites, but that's your decision to make.

What your visitors are owed, in law and in words, is for you, as the site's owner, to work out: this library gives you the means, not the answer.

## Web vitals

Optional, and a separate import, so a site that doesn't want them doesn't carry them.

```tsx
import { TrailicVitals } from "trailic/vitals";

<TrailicVitals />
```

## Size

`pnpm size` measures it. A test fails if the bundle grows past its limit.

## License

AGPL-3.0-only.
