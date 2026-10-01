// Partnership client seam — the browser half of the sponsor-week feature
// (party/partnership.js is the server half). Kept separate from
// src/nimiq.js (general wallet identity/claim integration) the same way
// src/alias.js sits next to it as a feature-specific consumer.
//
// Two things live here, and only these two: the configured payment
// recipient, and the read path for the active week's sponsor banner.
//
// This file used to also own a client-side quote ($5/week -> NIM via
// CoinGecko) and a payPartnership() wrapper. Both are gone: pricing is
// locked server-side by party/partnership.js's reserve() (so the client can
// never report its own amount) and src/main.js calls nimiq.js's
// sendNimPayment directly with the quote the server handed back. Nothing
// imported either function.
import { partnershipBannerUrl } from './net.js';

// Never hardcoded: a real NIM address, but still configured through Vite's
// build-time env (see .env.example) rather than written into source, so the
// production address is a deployment concern, not a code change. Empty in
// any environment that hasn't set it (local dev without a .env entry) —
// callers must treat that as "not configured", not silently pay a blank
// recipient.
export const PARTNERSHIP_PAYMENT_ADDRESS = import.meta.env.VITE_PARTNERSHIP_PAYMENT_ADDRESS || '';

// ---------------------------------------------------------------------
// Active sponsor banner — the read side of the booking flow above.
//
// party/partnership.js's uploadBanner() stores a paid week's banner in R2
// and its onRequest serves it back at `?banner=<weekId>`; until now nothing
// ever asked for it, so a sponsor could pay, book and upload and still never
// see their banner anywhere (src/game.js's goal panel and src/ticket.js both
// drew the built-in Nimiq art unconditionally). This is the missing half.

const DAY_MS = 24 * 60 * 60 * 1000;

// Monday 00:00:00 UTC of the ISO week containing `timestampMs`, as that
// Monday's own ISO date — must produce the exact same string as
// party/partnership.js's mondayUtcMs/weekIdFor, which is what the stored
// banner is keyed by. Duplicated rather than shared for the same reason
// that file duplicates it from party/leagueSeason.js: party/ is a separate
// Cloudflare Worker bundle from the browser build. Keep in sync by hand.
export function currentPartnershipWeekId(timestampMs = Date.now()) {
  const d = new Date(timestampMs);
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const daysSinceMonday = (d.getUTCDay() + 6) % 7; // getUTCDay: 0=Sun..6=Sat
  return new Date(utcMidnight - daysSinceMonday * DAY_MS).toISOString().slice(0, 10);
}

// Resolves to a decoded <img> for this week's sponsor banner, or null when
// there is no sponsor this week (the endpoint 404s) or the request fails for
// any reason. Callers treat null as "use the built-in Nimiq banner", so the
// no-sponsor path is byte-for-byte the behavior that shipped before this.
//
// The 404 IS the "no sponsor" signal — deliberately no extra JSON round-trip
// against fetchPartnershipWeeks() just to find out whether to then load the
// image. One request either way.
//
// crossOrigin: the banner is served from the Worker's origin, not the game's,
// and src/ticket.js draws it into a canvas it then exports as a shareable
// PNG — without this the canvas would be tainted and that export would throw.
// party/partnership.js's banner route sends Access-Control-Allow-Origin: *,
// so the anonymous request is served normally.
//
// Cached per page load: both consumers (the goal panel, which is rebuilt on
// every scored point, and the end-of-match ticket) share this one promise.
let sponsorBannerPromise = null;
export function loadSponsorBanner() {
  if (sponsorBannerPromise) return sponsorBannerPromise;
  sponsorBannerPromise = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img.naturalWidth > 0 ? img : null);
    img.onerror = () => resolve(null); // 404 (no sponsor this week), offline, CORS — all "no banner"
    img.src = partnershipBannerUrl(currentPartnershipWeekId());
  });
  return sponsorBannerPromise;
}
