# KickflipEvents — Backend API Reference

**Base URL (Railway):** `https://<your-railway-app>.railway.app`
**Frontend env var:** `VITE_API_URL=https://<your-railway-app>.railway.app`

All request/response bodies are `application/json`.
Protected endpoints require an `Authorization: Bearer <CRON_SECRET>` header.

---

## Table of Contents

1. [Health](#1-health)
2. [Authentication](#2-authentication)
3. [AI Event Search](#3-ai-event-search)
4. [Saved Events](#4-saved-events)
5. [Crawl](#5-crawl)
6. [Seed](#6-seed)
7. [Error Responses](#7-error-responses)
8. [Environment Variables](#8-environment-variables)

---

## 1. Health

### `GET /health`

Liveness check used by Railway health checks and monitoring.

**Response `200`**
```json
{
  "status": "ok",
  "timestamp": "2026-03-03T18:00:00.000Z"
}
```

---

## 2. Authentication

### `POST /api/auth/google`

Verifies a Google OAuth ID token and returns the normalised user profile.
Called by the frontend immediately after the Google Sign-In button resolves.

**Request body**
```json
{
  "token": "<google_id_token_string>"
}
```

| Field   | Type   | Required | Description                        |
|---------|--------|----------|------------------------------------|
| `token` | string | ✅        | Google credential from GSI callback |

**Response `200`**
```json
{
  "user": {
    "id":     "108923456789012345678",
    "name":   "Amrita Mahapatra",
    "email":  "amrita@example.com",
    "avatar": "https://lh3.googleusercontent.com/..."
  }
}
```

**Response `401`** — token invalid or expired
**Response `400`** — `token` field missing

---

## 3. AI Event Search

### `POST /api/chat`

Main query endpoint. Implements a 4-layer pipeline:

1. **Cache hit** → return instantly (0 tokens)
2. **Voyage AI embedding** → pgvector similarity search
3. **≥3 matches** → Claude formats & ranks results
4. **<3 matches** → Claude `web_search` live discovery → store → return

**Request body**
```json
{
  "query": "jazz brunch this Sunday Capitol Hill"
}
```

| Field   | Type   | Required | Description                          |
|---------|--------|----------|--------------------------------------|
| `query` | string | ✅        | Natural-language event search string |

**Response `200`**
```json
{
  "text": "Two jazz brunches hitting Capitol Hill this Sunday.",
  "events": [
    {
      "id":              "evt-abc123",
      "title":           "Sunday Jazz Brunch @ Café Racer",
      "date":            "Sunday Mar 8",
      "startDate":       "2026-03-08",
      "startTime":       "11:00",
      "location":        "Capitol Hill, Seattle",
      "locationName":    "Café Racer",
      "city":            "Capitol Hill",
      "address":         "5828 Roosevelt Way NE, Seattle, WA",
      "description":     "Live jazz quartet, bottomless mimosas.",
      "vibeDescription": "Chill Sunday morning jazz vibes.",
      "category":        "music",
      "vibeTags":        ["jazz", "brunch", "live-music"],
      "price":           "From $25",
      "link":            "https://caferacerseattle.com/events",
      "imageUrl":        "https://...",
      "organizer":       "Café Racer",
      "origin":          "crawl"
    }
  ],
  "source": "cache"
}
```

| Response field | Description                                       |
|----------------|---------------------------------------------------|
| `text`         | ≤12-word vibe summary from Claude                 |
| `events`       | Array of `KickflipEvent` objects (0–12 items)     |
| `source`       | `"cache"` or omitted (live result)                |

**Response `400`** — `query` field missing
**Response `500`** — AI / Supabase error

---

## 4. Saved Events

Users can bookmark events. State is persisted per `(user_id, event_id)` pair.
The event snapshot (`event_payload`) is stored at save time so the profile page
never needs a second fetch. Past events are automatically excluded from `GET`.

---

### `POST /api/saved-events`

Save (bookmark) an event for a user.

**Request body**
```json
{
  "user_id":       "108923456789012345678",
  "event_id":      "evt-abc123",
  "event_payload": { ...full KickflipEvent object... }
}
```

| Field           | Type   | Required | Description                             |
|-----------------|--------|----------|-----------------------------------------|
| `user_id`       | string | ✅        | Google OAuth `sub` from `kickflip_user` localStorage |
| `event_id`      | string | ✅        | Event ID to save                        |
| `event_payload` | object | ✅        | Full `KickflipEvent` snapshot           |

**Response `201`**
```json
{
  "success":  true,
  "event_id": "evt-abc123"
}
```

**Response `400`** — missing required fields
**Response `500`** — Supabase write error

---

### `DELETE /api/saved-events/:eventId`

Remove a saved event (un-bookmark).

**URL param:** `:eventId` — the event ID to unsave

**Request body**
```json
{
  "user_id": "108923456789012345678"
}
```

| Field     | Type   | Required | Description              |
|-----------|--------|----------|--------------------------|
| `user_id` | string | ✅        | Google OAuth `sub`       |

**Response `200`**
```json
{
  "success":  true,
  "event_id": "evt-abc123"
}
```

**Response `400`** — `user_id` missing
**Response `500`** — Supabase delete error

---

### `GET /api/saved-events?user_id=<id>`

Fetch all saved events for a user. **Automatically filters out past events**
(where `startDate` or parsed `date` is before today).

**Query param:** `user_id` — Google OAuth `sub`

**Response `200`**
```json
{
  "saved_events": [
    {
      "event_id": "evt-abc123",
      "saved_at": "2026-03-01T14:22:00.000Z",
      "event": {
        "id":          "evt-abc123",
        "title":       "Sunday Jazz Brunch @ Café Racer",
        "startDate":   "2026-03-08",
        "category":    "music",
        "price":       "From $25",
        "location":    "Capitol Hill, Seattle",
        "imageUrl":    "https://...",
        "vibeTags":    ["jazz", "brunch"]
      }
    }
  ],
  "total": 1
}
```

| Response field         | Description                                          |
|------------------------|------------------------------------------------------|
| `saved_events`         | Array of saved event rows (future events only)       |
| `saved_events[].event` | Full `KickflipEvent` object snapshot at time of save |
| `saved_events[].saved_at` | ISO timestamp when user saved this event         |
| `total`                | Count of returned (active) saved events              |

**Response `400`** — `user_id` query param missing
**Response `500`** — Supabase fetch error

---

## 5. Crawl

### `POST /api/crawl`

Triggers a batch event crawl across Seattle event sites (Eventbrite, Resident
Advisor, Do206, etc.). Stores new events into `kickflip_events` with Voyage AI
embeddings. Window: today → +7 days.

**Auth required:** `Authorization: Bearer <CRON_SECRET>`

**Request body** — empty `{}`

**Response `200`**
```json
{
  "status":          "Crawl complete",
  "timestamp":       "2026-03-03T03:00:00.000Z",
  "eventsFound":     42,
  "eventsCreated":   17,
  "eventsUpdated":   8,
  "eventsFailed":    2,
  "durationMs":      34210
}
```

**Response `401`** — missing or wrong `Authorization` header
**Response `500`** — crawl failed

---

## 6. Seed

### `POST /api/seed`

One-time operation: embeds all existing `kickflip_events` rows that have no
`embedding` yet. Run once after initial data import.

**Auth required:** `Authorization: Bearer <CRON_SECRET>`

**Request body** — empty `{}`

**Response `200`** *(seed starts asynchronously)*
```json
{
  "status":    "Seed started",
  "timestamp": "2026-03-03T03:00:00.000Z"
}
```

**Response `401`** — missing or wrong `Authorization` header

---

## 7. Error Responses

All error responses follow this shape:

```json
{
  "error": "Human-readable error description"
}
```

| HTTP Status | Meaning                                    |
|-------------|--------------------------------------------|
| `400`       | Bad request — missing or invalid payload   |
| `401`       | Unauthorized — invalid or missing token    |
| `500`       | Internal server error — see Railway logs   |

---

## 8. Environment Variables

### Railway (backend)

| Variable                  | Required | Description                                      |
|---------------------------|----------|--------------------------------------------------|
| `ANTHROPIC_API_KEY`       | ✅        | Anthropic API key (`sk-ant-...`)                 |
| `SUPABASE_URL`            | ✅        | Supabase project URL                             |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅      | Supabase service role key (bypasses RLS)         |
| `VOYAGE_API_KEY`          | ✅        | Voyage AI key for `voyage-large-2` embeddings    |
| `GOOGLE_CLIENT_ID`        | ✅        | Google OAuth 2.0 client ID                       |
| `CRON_SECRET`             | ✅        | Shared secret for `/api/crawl` and `/api/seed`   |
| `PORT`                    | ⬜        | Server port (default `3001`)                     |

### Vercel (frontend)

| Variable                  | Required | Description                                      |
|---------------------------|----------|--------------------------------------------------|
| `VITE_API_URL`            | ✅        | Railway backend URL (no trailing slash)          |
| `VITE_SUPABASE_URL`       | ✅        | Supabase project URL                             |
| `VITE_SUPABASE_ANON_KEY`  | ✅        | Supabase anon key (safe for browser)             |
| `VITE_GOOGLE_CLIENT_ID`   | ✅        | Google OAuth 2.0 client ID                       |

---

## Data Model — `KickflipEvent`

Full event object shape used across all endpoints:

```typescript
interface KickflipEvent {
  id:              string;
  title:           string;
  category:        'music'|'food'|'art'|'outdoor'|'party'|'wellness'|'fashion'|'sports'|'comedy'|'other';
  date:            string;   // legacy display string e.g. "Saturday Mar 8"
  startDate?:      string;   // YYYY-MM-DD (preferred for date logic)
  startTime?:      string;   // HH:MM
  location:        string;   // display string
  locationName?:   string;   // venue name
  city?:           string;   // short city name for card display
  address?:        string;   // full street address
  description:     string;
  vibeDescription?: string;
  vibeTags:        string[];
  price?:          string;   // e.g. "Free", "From $15", "$25–$45"
  link:            string;   // ticket / event page URL
  imageUrl?:       string;
  organizer?:      string;
  origin?:         'user'|'crawl';
  status?:         'active'|'draft'|'completed';
}
```
