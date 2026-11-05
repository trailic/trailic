"use client";

import { useEffect } from "react";
import { setConsent, start, type StartOptions } from "./core.js";

export interface TrailicProps extends StartOptions {
  /** False holds everything back until it turns true. Leave it out if the site doesn't ask. */
  consent?: boolean;
}

/**
 * Put once in the root layout. It renders nothing and waits for nothing: the page paints the same
 * whether the collector answers or not.
 */
export function Trailic({ siteKey, endpoint, respectPrivacySignals, consent }: TrailicProps): null {
  // Left out, it leaves alone whatever the site said with setConsent.
  useEffect(() => {
    if (consent !== undefined) setConsent(consent);
  }, [consent]);
  useEffect(() => start({ siteKey, endpoint, respectPrivacySignals }), [siteKey, endpoint, respectPrivacySignals]);
  return null;
}
