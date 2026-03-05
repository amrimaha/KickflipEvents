/**
 * Clickstream tracking — fire-and-forget POST to /api/events/click.
 *
 * Never throws or awaits in a way that blocks the UI.
 * Silently no-ops if VITE_API_URL is not set (local dev without backend).
 */

import { getAnonId } from '../utils/anonId';

export type ClickAction =
  | 'view_detail'      // card clicked → detail modal opened
  | 'cta_click'        // primary CTA button pressed (Book Now / Get Tickets / etc.)
  | 'save'             // event saved (bookmark on)
  | 'unsave'           // event unsaved (bookmark off)
  | 'share'            // share button pressed
  | 'checkout_start';  // CheckoutModal opened (native events only)

export interface ClickPayload {
  event_id:    string;
  action:      ClickAction;
  user_id?:    string | null;
  session_id?: string | null;
  /** Where on the page the card was: 'browse' | 'search' | 'saved' */
  source?:     string;
  /** Variable metadata: cta_label, referrer, etc. */
  extras?:     Record<string, unknown>;
}

export function trackClick(payload: ClickPayload): void {
  const apiBase = (import.meta as any).env?.VITE_API_URL;
  if (!apiBase) return; // no-op in local dev without backend

  const body = JSON.stringify({
    ...payload,
    anon_id: getAnonId(),
    user_id: payload.user_id ?? null,
  });

  // Use sendBeacon when available (guaranteed delivery even on page unload).
  // Fall back to fetch (fire-and-forget).
  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: 'application/json' });
    navigator.sendBeacon(`${apiBase}/api/events/click`, blob);
  } else {
    fetch(`${apiBase}/api/events/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      // silently ignore — click tracking must never affect product UX
    });
  }
}
