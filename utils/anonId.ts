/**
 * Anonymous user identity for clickstream tracking.
 *
 * Generates a UUID on first page load and persists it in localStorage.
 * This ID is always set — it bridges anonymous → authenticated journeys.
 * When a user signs in, their pre-login clicks become linkable via shared anon_id.
 */

const STORAGE_KEY = 'kf_anon_id';

export function getAnonId(): string {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}
