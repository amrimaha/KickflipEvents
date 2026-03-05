/**
 * Clickstream tracking — fire-and-forget POST to /api/events/click.
 *
 * Uses fetch with keepalive:true so the request survives page navigation.
 * Errors are logged as warnings in dev; silently dropped in production.
 * Never throws or blocks the UI.
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
  if (!apiBase) return; // no-op when backend URL is not configured

  const isDev = (import.meta as any).env?.DEV === true;

  const body = JSON.stringify({
    ...payload,
    anon_id: getAnonId(),
    user_id: payload.user_id ?? null,
  });

  // keepalive:true ensures the request completes even if the user navigates away.
  // We do NOT use sendBeacon because sendBeacon with application/json triggers a
  // CORS preflight that it cannot wait for, causing silent drops in browsers.
  fetch(`${apiBase}/api/events/click`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).then(res => {
    if (isDev && !res.ok) {
      console.warn(`[trackClick] ${payload.action} → HTTP ${res.status} for event ${payload.event_id}`);
    }
  }).catch(err => {
    // Network error — analytics must never affect the product UX
    if (isDev) console.warn('[trackClick] network error:', err);
  });
}
