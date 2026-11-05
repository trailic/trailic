import { describe, expect, it } from "vitest";
import { cleanPagePath } from "../src/clean-url.js";

describe("an address, cleaned", () => {
  it.each([
    ["/", "/"],
    ["", "/"],
    ["/pricing", "/pricing"],
    ["/a/b/c", "/a/b/c"],
    ["/a?x=1", "/a"],
    ["/a#b", "/a"],
    ["/a?x=1#b", "/a"],
    ["/a?utm_source=news", "/a?utm_source=news"],
    ["/a?x=1&utm_source=news&y=2&utm_campaign=autumn", "/a?utm_source=news&utm_campaign=autumn"],
    ["/a?utm_source=", "/a"],
    ["/a?utmsource=news", "/a"],
    ["/a?email=ada@acme.example", "/a"],
    ["/a?utm_source=ada@acme.example", "/a"],
    ["/a?utm_source=ada%40acme.example", "/a"],
    ["/a?utm_content=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "/a"],
    ["/users/ada@acme.example", "/users/[email]"],
    ["/users/ada%40acme.example/settings", "/users/[email]/settings"],
    ["/reset/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc", "/reset/[token]"],
    ["/invite/a1b2c3d4e5f6a7b8c9d0e1f2", "/invite/[token]"],
    ["/orders/550e8400-e29b-41d4-a716-446655440000", "/orders/[token]"],
    ["/k/AbCdEfGhIjKlMnOpQrStUvWx", "/k/[token]"],
  ])("%s becomes %s", (raw, clean) => {
    expect(cleanPagePath(raw)).toBe(clean);
  });

  it.each(["/blog/how-to-install-nextjs-on-a-very-small-server-in-2026", "/docs/getting-started-with-webhooks", "/products/internationalization", "/orders/42", "/a/1234567890", "/release-notes-v16-4-3"])("%s is left alone: a long slug is words", (path) => {
    expect(cleanPagePath(path)).toBe(path);
  });
});
