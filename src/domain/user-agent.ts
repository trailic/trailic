/**
 * What a browser's user agent says, coarsely: enough to count devices and browsers, not enough to
 * tell two people apart. Nothing else of the user agent is stored.
 */

export interface CoarseClient {
  device: "desktop" | "mobile" | "tablet";
  browser: string;
  os: string;
}

// "cu" is for Cubot, whose phones are people.
const BOT = /(?<!cu)bot\b|bot[/;-]|crawl|spider|slurp|scrape|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|preview|facebookexternalhit|embedly|whatsapp|curl\/|wget\/|python-requests|python-urllib|go-http-client|node-fetch|axios\/|okhttp|java\/|libwww|phantomjs|playwright|puppeteer|selenium|vercel-screenshot/i;

/** Whether a request comes from a machine. No user agent at all counts: every browser sends one. */
export const isBot = (userAgent: string | null) => !userAgent || BOT.test(userAgent);

const BROWSERS: [RegExp, string][] = [
  [/edg(e|a|ios)?\//i, "Edge"],
  [/opr\/|opera/i, "Opera"],
  [/samsungbrowser/i, "Samsung Internet"],
  [/firefox|fxios/i, "Firefox"],
  [/chrome|crios|chromium/i, "Chrome"],
  [/safari/i, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/iphone|ipad|ipod/i, "iOS"],
  [/android/i, "Android"],
  [/windows/i, "Windows"],
  [/cros/i, "ChromeOS"],
  [/mac os x|macintosh/i, "macOS"],
  [/linux/i, "Linux"],
];

const firstMatch = (table: [RegExp, string][], text: string) => table.find(([pattern]) => pattern.test(text))?.[1] ?? "Other";

function deviceOf(userAgent: string): CoarseClient["device"] {
  if (/ipad|tablet|kindle|silk/i.test(userAgent) || (/android/i.test(userAgent) && !/mobile/i.test(userAgent))) return "tablet";
  return /mobi|iphone|ipod/i.test(userAgent) ? "mobile" : "desktop";
}

export const coarseClient = (userAgent: string): CoarseClient => ({ device: deviceOf(userAgent), browser: firstMatch(BROWSERS, userAgent), os: firstMatch(SYSTEMS, userAgent) });
