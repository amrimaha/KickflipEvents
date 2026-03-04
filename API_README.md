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
5. [Events (CRUD)](#5-events-crud)
6. [User Profile](#6-user-profile)
7. [Crawl](#7-crawl)
8. [Seed](#8-seed)
9. [Admin](#9-admin)
10. [Error Responses](#10-error-responses)
11. [Environment Variables](#11-environment-variables)
12. [Data Models](#12-data-models)

---

## 1. Health

### `GET /health`

Liveness check used by Railway and monitoring.

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
Creates or updates the user row in the `users` table.

**Request body**
```json
{
  "token": "<google_id_token_string>"
}
```

| Field   | Type   | Required | Description                         |
|---------|--------|----------|-------------------------------------|
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

Main event discovery endpoint. Implements a 4-layer pipeline:

1. **Cache hit** → return instantly (0 tokens)
2. **Voyage AI embedding** → pgvector similarity search (threshold 0.72)
3. **≥3 matches** → Claude formats & ranks results (~2k tokens)
4. **Broad match (0.5)** → Claude formats low-confidence results
5. **<2 matches** → Claude `web_search` live discovery → store → return

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
| `source`       | `"cache"` (omitted on live results)               |

**Response `400`** — `query` field missing
**Response `500`** — AI / Supabase error

---

## 4. Saved Events

Users can bookmark events. State is persisted per `(user_id, event_id)` pair.
The full event snapshot (`event_payload`) is stored at save time so the profile
page never needs a second fetch. Past events are automatically excluded from `GET`.

---

### `POST /api/saved-events`

Save (bookmark) an event for a user.

**Request body**
```json
{
  "user_id":       "108923456789012345678",
  "event_id":      "evt-abc123",
  "event_payload": { "...full KickflipEvent object..." }
}
```

| Field           | Type   | Required | Description                                             |
|-----------------|--------|----------|---------------------------------------------------------|
| `user_id`       | string | ✅        | Google OAuth `sub` (from `kickflip_user` localStorage)  |
| `event_id`      | string | ✅        | Event ID to save                                        |
| `event_payload` | object | ✅        | Full `KickflipEvent` snapshot                           |

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

| Response field            | Description                                          |
|---------------------------|------------------------------------------------------|
| `saved_events`            | Array of saved event rows (future events only)       |
| `saved_events[].event`    | Full `KickflipEvent` snapshot at time of save        |
| `saved_events[].saved_at` | ISO timestamp when user saved this event             |
| `total`                   | Count of returned (active) saved events              |

**Response `400`** — `user_id` query param missing
**Response `500`** — Supabase fetch error

---

## 5. Events (CRUD)

User-created events ("drops"). These are native Kickflip events with full
booking support, creator ownership, and media uploads.

---

### `POST /api/events`

Create a new event draft or publish immediately.

**Request body**
```json
{
  "creator_id":       "108923456789012345678",
  "title":            "Rooftop Rave Cap Hill",
  "category":         "party",
  "description":      "Secret rooftop with lo-fi house, neon art, cyberpunk dress code.",
  "vibe_description": "Cyberpunk neon lo-fi vibes on the hill.",
  "start_date":       "2026-03-15",
  "start_time":       "22:00",
  "end_date":         "2026-03-16",
  "end_time":         "03:00",
  "location_name":    "The Vault Cap Hill",
  "address":          "1234 Broadway E, Seattle, WA 98122",
  "price":            "20",
  "is_free":          false,
  "capacity":         200,
  "vibe_tags":        ["neon", "house-music", "rooftop"],
  "status":           "active",
  "theme_color":      "#a78bfa",
  "vibemoji":         { "baseId": "bolt", "primaryColor": "#a78bfa", "hat": "backwards" },
  "media":            [{ "type": "image", "url": "https://...", "storage_path": "events/..." }]
}
```

| Field              | Type     | Required | Description                                        |
|--------------------|----------|----------|----------------------------------------------------|
| `creator_id`       | string   | ✅        | Google OAuth `sub` of the event creator            |
| `title`            | string   | ✅        | Display name of the event                          |
| `category`         | string   | ✅        | One of the 10 event categories                     |
| `description`      | string   | ✅        | Full event description                             |
| `vibe_description` | string   | ⬜        | Short card headline (≤120 chars)                   |
| `start_date`       | string   | ✅        | YYYY-MM-DD                                         |
| `start_time`       | string   | ⬜        | HH:MM (24h)                                        |
| `end_date`         | string   | ⬜        | YYYY-MM-DD                                         |
| `end_time`         | string   | ⬜        | HH:MM (24h)                                        |
| `location_name`    | string   | ✅        | Venue name                                         |
| `address`          | string   | ✅        | Full street address                                |
| `price`            | string   | ⬜        | Ticket price in USD (omit for free)                |
| `is_free`          | boolean  | ⬜        | Defaults to `false`                                |
| `capacity`         | integer  | ⬜        | Max attendees                                      |
| `vibe_tags`        | string[] | ⬜        | Hashtag-style tags                                 |
| `status`           | string   | ⬜        | `"active"` or `"draft"` (default `"draft"`)        |
| `theme_color`      | string   | ⬜        | Hex color for card branding                        |
| `vibemoji`         | object   | ⬜        | `VibemojiConfig` for event avatar                  |
| `media`            | array    | ⬜        | Array of media objects (images/videos)             |

**Response `201`**
```json
{
  "success":  true,
  "event_id": "usr-abc123def456",
  "event":    { "...full KickflipEvent object..." }
}
```

**Response `400`** — missing required fields
**Response `401`** — creator_id not authenticated
**Response `500`** — Supabase write error

---

### `GET /api/events/:eventId`

Fetch a single event by ID.

**Response `200`**
```json
{
  "event": { "...full KickflipEvent object..." }
}
```

**Response `404`** — event not found

---

### `PATCH /api/events/:eventId`

Update an existing event. Only the creator or a super-admin can update.

**Request body** — any subset of `POST /api/events` fields plus:

| Field          | Type   | Required | Description                            |
|----------------|--------|----------|----------------------------------------|
| `requester_id` | string | ✅        | Must match `creator_id` or be admin    |

**Response `200`**
```json
{
  "success":  true,
  "event_id": "usr-abc123def456"
}
```

**Response `403`** — not the creator or admin
**Response `404`** — event not found

---

### `DELETE /api/events/:eventId`

Delete an event. Only the creator or a super-admin can delete.

**Request body**
```json
{ "requester_id": "108923456789012345678" }
```

**Response `200`**
```json
{ "success": true }
```

**Response `403`** — not the creator or admin
**Response `404`** — event not found

---

### `GET /api/events?creator_id=<id>&status=<status>`

List events by creator. Used by the Creator Dashboard.

**Query params:**

| Param        | Required | Description                                       |
|--------------|----------|---------------------------------------------------|
| `creator_id` | ✅        | Google OAuth `sub` of the creator                 |
| `status`     | ⬜        | Filter by `active`, `draft`, or `completed`       |

**Response `200`**
```json
{
  "events": [ { "...KickflipEvent..." } ],
  "total":  3
}
```

---

## 6. User Profile

### `GET /api/users/:userId`

Fetch a user's public profile.

**Response `200`**
```json
{
  "user": {
    "id":            "108923456789012345678",
    "name":          "Amrita Mahapatra",
    "email":         "amrita@example.com",
    "avatar":        "https://lh3.googleusercontent.com/...",
    "profile_photo": "https://...",
    "cover_url":     "https://...",
    "cover_type":    "image",
    "created_at":    "2026-01-15T10:00:00.000Z"
  }
}
```

**Response `404`** — user not found

---

### `PATCH /api/users/:userId`

Update a user's profile. Users can only update their own profile.

**Request body**
```json
{
  "requester_id":  "108923456789012345678",
  "name":          "Amrita M.",
  "profile_photo": "data:image/jpeg;base64,...",
  "cover_url":     "https://...",
  "cover_type":    "image",
  "phone":         "+1-206-555-0123",
  "notification_prefs": {
    "eventUpdates":         true,
    "bookingConfirmations": true,
    "reminders":            true,
    "productAnnouncements": false
  }
}
```

| Field                | Type   | Required | Description                               |
|----------------------|--------|----------|-------------------------------------------|
| `requester_id`       | string | ✅        | Must match `:userId`                      |
| `name`               | string | ⬜        | Display name                              |
| `profile_photo`      | string | ⬜        | Base64 JPEG or Supabase Storage URL       |
| `cover_url`          | string | ⬜        | Cover image/video URL                     |
| `cover_type`         | string | ⬜        | `"image"` or `"video"`                    |
| `phone`              | string | ⬜        | Phone number                              |
| `notification_prefs` | object | ⬜        | Notification settings                     |

**Response `200`**
```json
{ "success": true }
```

**Response `403`** — requester_id doesn't match userId

---

### `PATCH /api/users/:userId/onboarding`

Save onboarding preferences after the welcome flow completes.

**Request body**
```json
{
  "vibes":     ["Live music 🎶", "Food & drink 🍜"],
  "location":  "Capitol Hill",
  "timing":    ["Weekends"],
  "completed": true
}
```

**Response `200`**
```json
{ "success": true }
```

---

## 7. Crawl

### `POST /api/crawl`

Triggers a batch event crawl across Seattle event sites (Eventbrite, Resident
Advisor, Do206, etc.). Stores new events into `kickflip_events` with Voyage AI
embeddings. Window: today → +7 days.

**Auth required:** `Authorization: Bearer <CRON_SECRET>`

**Request body** — empty `{}`

**Response `200`**
```json
{
  "status":        "Crawl complete",
  "timestamp":     "2026-03-03T03:00:00.000Z",
  "eventsFound":   42,
  "eventsCreated": 17,
  "eventsUpdated": 8,
  "eventsFailed":  2,
  "durationMs":    34210
}
```

**Response `401`** — missing or wrong `Authorization` header
**Response `500`** — crawl failed

---

## 8. Seed

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

## 9. Admin

Admin endpoints require the caller's `is_super_admin` flag to be `true` in the
`users` table. Pass `admin_id` in the request body for UI callers; machine
callers use `Authorization: Bearer <CRON_SECRET>`.

---

### `GET /api/admin/users`

List all users with pagination and filtering.

**Query params:**

| Param    | Required | Description                        |
|----------|----------|------------------------------------|
| `page`   | ⬜        | Page number (default `1`)          |
| `limit`  | ⬜        | Results per page (default `50`)    |
| `search` | ⬜        | Filter by name or email            |
| `banned` | ⬜        | `true` to show only banned users   |

**Response `200`**
```json
{
  "users": [
    {
      "id":          "108923456789012345678",
      "name":        "Amrita Mahapatra",
      "email":       "amrita@example.com",
      "is_banned":   false,
      "created_at":  "2026-01-15T10:00:00.000Z",
      "event_count": 4,
      "save_count":  12
    }
  ],
  "total": 142,
  "page":  1
}
```

---

### `POST /api/admin/users/:userId/ban`

Ban or unban a user. Banned users cannot create events or make bookings.

**Request body**
```json
{
  "admin_id": "108923456789012345678",
  "banned":   true,
  "reason":   "Spam / duplicate listings"
}
```

**Response `200`**
```json
{ "success": true, "user_id": "108923456789012345678", "banned": true }
```

---

### `GET /api/admin/events`

List all events with creator info. Supports filtering by status and origin.

**Query params:**

| Param      | Required | Description                               |
|------------|----------|-------------------------------------------|
| `page`     | ⬜        | Page number (default `1`)                 |
| `limit`    | ⬜        | Results per page (default `50`)           |
| `status`   | ⬜        | `active`, `draft`, `completed`            |
| `origin`   | ⬜        | `user` or `crawl`                         |
| `category` | ⬜        | One of the 10 event categories            |

**Response `200`**
```json
{
  "events": [
    {
      "id":         "evt-abc123",
      "title":      "Rooftop Rave Cap Hill",
      "category":   "party",
      "status":     "active",
      "origin":     "user",
      "creator_id": "108923456789012345678",
      "created_at": "2026-03-01T10:00:00.000Z",
      "start_date": "2026-03-15"
    }
  ],
  "total": 87,
  "page":  1
}
```

---

### `DELETE /api/admin/events/:eventId`

Hard-delete an event from the database.

**Request body**
```json
{ "admin_id": "108923456789012345678", "reason": "Violates community guidelines" }
```

**Response `200`**
```json
{ "success": true }
```

---

### `GET /api/admin/crawl-jobs`

List recent crawl job records with status and stats.

**Response `200`**
```json
{
  "jobs": [
    {
      "id":             "uuid",
      "target_url":     "https://do206.com/events",
      "status":         "completed",
      "events_found":   18,
      "events_created": 7,
      "started_at":     "2026-03-03T03:00:00.000Z",
      "finished_at":    "2026-03-03T03:00:34.000Z"
    }
  ]
}
```

---

### `GET /api/admin/logs`

Audit trail of all admin actions.

**Query params:** `page`, `limit`, `admin_email`, `action`

**Response `200`**
```json
{
  "logs": [
    {
      "id":          "uuid",
      "admin_email": "admin@kickflip.app",
      "action":      "ban_user",
      "target_id":   "108923456789012345678",
      "metadata":    { "reason": "Spam" },
      "created_at":  "2026-03-02T11:30:00.000Z"
    }
  ]
}
```

---

## 10. Error Responses

All error responses follow this shape:

```json
{ "error": "Human-readable error description" }
```

| HTTP Status | Meaning                                    |
|-------------|--------------------------------------------|
| `400`       | Bad request — missing or invalid payload   |
| `401`       | Unauthorized — invalid or missing token    |
| `403`       | Forbidden — authenticated but not allowed  |
| `404`       | Not found                                  |
| `500`       | Internal server error — see Railway logs   |

---

## 11. Environment Variables

### Railway (backend)

| Variable                    | Required | Description                                        |
|-----------------------------|----------|----------------------------------------------------|
| `ANTHROPIC_API_KEY`         | ✅        | Anthropic API key (`sk-ant-...`)                   |
| `SUPABASE_URL`              | ✅        | Supabase project URL                               |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅        | Supabase service role key (bypasses RLS)           |
| `VOYAGE_API_KEY`            | ✅        | Voyage AI key for `voyage-large-2` embeddings      |
| `GOOGLE_CLIENT_ID`          | ✅        | Google OAuth 2.0 client ID                         |
| `CRON_SECRET`               | ✅        | Shared secret for `/api/crawl`, `/api/seed`, admin |
| `PORT`                      | ⬜        | Server port (default `3001`)                       |

### Vercel (frontend)

| Variable                 | Required | Description                              |
|--------------------------|----------|------------------------------------------|
| `VITE_API_URL`           | ✅        | Railway backend URL (no trailing slash)  |
| `VITE_SUPABASE_URL`      | ✅        | Supabase project URL                     |
| `VITE_SUPABASE_ANON_KEY` | ✅        | Supabase anon key (safe for browser)     |
| `VITE_GOOGLE_CLIENT_ID`  | ✅        | Google OAuth 2.0 client ID               |

---

## 12. Data Models

### `KickflipEvent`

```typescript
interface KickflipEvent {
  id:               string;
  title:            string;
  category:         'music'|'food'|'art'|'outdoor'|'party'|'wellness'|'fashion'|'sports'|'comedy'|'other';
  date:             string;    // legacy display string e.g. "Saturday Mar 8"
  startDate?:       string;    // YYYY-MM-DD (preferred)
  startTime?:       string;    // HH:MM (24h)
  endDate?:         string;    // YYYY-MM-DD
  endTime?:         string;    // HH:MM (24h)
  location:         string;    // display string
  locationName?:    string;    // venue name
  city?:            string;    // short city name for card display
  address?:         string;    // full street address
  description:      string;
  vibeDescription?: string;    // short card headline
  vibeTags:         string[];
  price?:           string;    // e.g. "Free", "From $15", "$25–$45"
  link:             string;    // ticket / event page URL
  imageUrl?:        string;
  media?:           MediaItem[];
  organizer?:       string;    // provider / host name
  overview?:        string;    // long-form description
  capacity?:        number;
  themeColor?:      string;    // hex
  vibemoji?:        VibemojiConfig;
  creatorId?:       string;    // Google OAuth sub (user-created events)
  crawlSource?:     string;    // source site label e.g. "Eventbrite"
  origin?:          'user' | 'crawl';
  status?:          'active' | 'draft' | 'completed';
}
```

### `MediaItem`

```typescript
interface MediaItem {
  type:          'image' | 'video';
  url:           string;        // public URL
  storage_path?: string;        // Supabase Storage path (user-created events)
}
```

### `VibemojiConfig`

```typescript
interface VibemojiConfig {
  baseId:       'duck' | 'bolt' | 'ghost' | 'pizza' | 'arcade';
  primaryColor: string;   // hex
  skinTone?:    string;   // hex
  hat?:         'none'|'beanie'|'bucket'|'cap'|'backwards'|'crown'|'halo';
  outfit?:      'none'|'tee'|'hoodie'|'jacket'|'flannel';
  pants?:       'none'|'jeans'|'shorts'|'cargo'|'skirt';
  shoes?:       'none'|'skate'|'boots'|'high-tops'|'neon';
  expression?:  'neutral'|'happy'|'hype'|'chill'|'wink';
  glasses?:     'none'|'sunnies'|'retro'|'nerd'|'star';
  jewelry?:     'none'|'chain'|'studs'|'hoops';
}
```

### `User`

```typescript
interface User {
  id:                  string;   // Google OAuth sub
  name:                string;
  email:               string;
  avatar?:             string;   // Google profile picture
  profile_photo?:      string;   // custom uploaded photo (base64 or Storage URL)
  cover_url?:          string;
  cover_type?:         'image' | 'video';
  phone?:              string;
  stripe_account?:     string;   // Stripe Connect account ID
  stripe_connected?:   boolean;
  is_banned?:          boolean;
  notification_prefs?: NotificationPrefs;
  onboarding_prefs?:   OnboardingPreferences;
  created_at:          string;
}
```

### `NotificationPrefs`

```typescript
interface NotificationPrefs {
  eventUpdates:         boolean;
  bookingConfirmations: boolean;
  reminders:            boolean;
  productAnnouncements: boolean;
}
```

### `OnboardingPreferences`

```typescript
interface OnboardingPreferences {
  vibes:     string[];   // up to 3 vibe chips e.g. ["Live music 🎶"]
  location:  string;    // neighbourhood or "Current Location"
  timing:    string[];  // e.g. ["Weekends", "Anytime"]
  completed: boolean;
}
```

### `EventBooking`

```typescript
interface EventBooking {
  id:                     string;   // UUID
  event_id:               string;
  user_id:                string;
  quantity:               number;
  total_price_cents?:     number;   // null for free events
  stripe_payment_intent?: string;
  status:                 'pending' | 'confirmed' | 'cancelled' | 'refunded';
  booked_at:              string;
}
```

### `CrawlJob`

```typescript
interface CrawlJob {
  id:             string;   // UUID
  target_url?:    string;
  status:         'queued' | 'running' | 'completed' | 'failed';
  events_found:   number;
  events_created: number;
  logs?:          string[];
  started_at:     string;
  finished_at?:   string;
  error_message?: string;
}
```
