"""
Heuristic event parser — last resort before LLM fallback.

Extraction order for each field:
  Title   : h1 → og:title → twitter:title → first <h2> in article
  Date    : <time datetime> → common class patterns → label-proximity scan
  Location: itemprop=location → class patterns → label-proximity scan
  Price   : itemprop=price → class patterns → free/$ text scan
  Image   : og:image → first prominent <img>
  Desc    : trafilatura main-text → og:description
  Ticket  : Eventbrite/Ticketmaster links → button containing "ticket"
"""
from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

from app.models.event import RawEventData
from app.utils.datetime_utils import extract_date_from_text, extract_time_from_text
from app.utils.text_utils import (
    normalize_text,
    extract_price_text,
    extract_snippet,
    clean_whitespace,
)
from app.parsers.image_extractor import extract_image
from app.utils.url_utils import canonicalize_url

# ── Selector shortlists ───────────────────────────────────────────────────────

_DATE_CLASSES = re.compile(
    r"date|datetime|when|start.?time|event.?time|schedule|time.?slot",
    re.I,
)
_LOCATION_CLASSES = re.compile(
    r"venue|location|where|address|place|map",
    re.I,
)
_PRICE_CLASSES = re.compile(
    r"price|ticket.?price|admission|cost|fee|fare",
    re.I,
)
_TICKET_DOMAINS = re.compile(
    r"eventbrite|ticketmaster|tix\.com|ticketweb|etix|brownpapertickets|"
    r"universe\.com|humanitix|seetickets",
    re.I,
)

# Matches bare duration strings like "136 min." or "2 hrs" that get mis-extracted
# from "Running Time:" labels via the date label-proximity scan.
_DURATION_PATTERN = re.compile(
    r"^\d+\s*(?:min|mins|minute|minutes|hr|hrs|hour|hours)\.?\s*$",
    re.I,
)

# Labels that appear near dates
_DATE_LABELS = re.compile(
    r"\b(date|when|start|begins?|time|schedule|doors?\s+open)\s*:?\s*$",
    re.I,
)
_LOCATION_LABELS = re.compile(
    r"\b(venue|location|where|address|place|held\s+at)\s*:?\s*$",
    re.I,
)
_PRICE_LABELS = re.compile(
    r"\b(price|admission|tickets?|cost|fee)\s*:?\s*$",
    re.I,
)


def _meta(soup: BeautifulSoup, *names: str) -> Optional[str]:
    """Get content of first matching <meta> by name or property."""
    for name in names:
        el = soup.find("meta", {"property": name}) or soup.find("meta", {"name": name})
        if el and el.get("content"):
            return normalize_text(str(el["content"]))
    return None


def _has_class_match(el: Tag, pattern: re.Pattern) -> bool:
    classes = el.get("class") or []
    if isinstance(classes, str):
        classes = [classes]
    return any(pattern.search(c) for c in classes) or pattern.search(str(el.get("id", "")))


def _text_near_label(soup: BeautifulSoup, label_re: re.Pattern) -> Optional[str]:
    """
    Find a label element matching label_re, then return sibling/child text.
    Scans: <dt>, <th>, <label>, <strong>, <b>, <span> elements.
    """
    candidates = soup.find_all(["dt", "th", "label", "strong", "b", "span", "p"])
    for el in candidates:
        txt = el.get_text(strip=True)
        if label_re.search(txt):
            # Try next sibling first
            sib = el.find_next_sibling()
            if sib:
                val = normalize_text(sib.get_text(separator=" "))
                if val and len(val) < 200:
                    return val
            # Try parent's remaining text
            parent = el.parent
            if parent:
                all_text = parent.get_text(separator=" ")
                after = all_text[all_text.find(txt) + len(txt):]
                after = clean_whitespace(after)
                if after and len(after) < 200:
                    return after
    return None


def _extract_title(soup: BeautifulSoup) -> Optional[str]:
    # 1. OG title
    og = _meta(soup, "og:title", "twitter:title")
    if og and len(og) < 200:
        return og

    # 2. <h1> inside main content area
    for container in ["main", "article", "[role='main']", ".event", ".event-detail"]:
        area = soup.select_one(container)
        if area:
            h1 = area.find("h1")
            if h1:
                t = normalize_text(h1.get_text(separator=" "))
                if t and len(t) < 300:
                    return t

    # 3. Any <h1>
    h1 = soup.find("h1")
    if h1:
        t = normalize_text(h1.get_text(separator=" "))
        if t and len(t) < 300:
            return t

    # 4. <title> (strip site suffix)
    title_tag = soup.find("title")
    if title_tag:
        t = normalize_text(title_tag.get_text())
        # Strip common "| Site Name" suffixes
        t = re.split(r"\s*[\|–—]\s*", t)[0].strip()
        if t:
            return t

    return None


def _extract_dates(soup: BeautifulSoup) -> tuple[Optional[str], Optional[str]]:
    start_raw: Optional[str] = None
    end_raw: Optional[str] = None

    # 1. <time datetime="...">  — most reliable
    time_els = soup.find_all("time", attrs={"datetime": True})
    datetimes = []
    for t in time_els:
        dt_val = t.get("datetime", "")
        if dt_val:
            datetimes.append(dt_val)
    if datetimes:
        start_raw = datetimes[0]
        if len(datetimes) > 1:
            end_raw = datetimes[1]
        return start_raw, end_raw

    # 2. Elements with date-related classes/IDs
    for el in soup.find_all(True):
        if not isinstance(el, Tag):
            continue
        if _has_class_match(el, _DATE_CLASSES):
            # Prefer datetime attr, then data-date, then text
            val = (
                el.get("datetime")
                or el.get("data-date")
                or el.get("data-datetime")
                or el.get("content")
                or normalize_text(el.get_text(separator=" "))
            )
            if val and isinstance(val, str):
                candidate = extract_date_from_text(str(val)) or str(val)
                if candidate and len(candidate) < 100:
                    if start_raw is None:
                        start_raw = candidate
                    elif end_raw is None:
                        end_raw = candidate
                    break

    if start_raw:
        return start_raw, end_raw

    # 3. Meta tags
    for meta_name in ("event:start_time", "startDate", "event-date"):
        val = _meta(soup, meta_name)
        if val:
            start_raw = val
            break

    # 4. Label proximity scan
    if not start_raw:
        val = _text_near_label(soup, _DATE_LABELS)
        if val:
            start_raw = extract_date_from_text(val) or val

    # Reject bare duration strings (e.g. "136 min." from "Running Time:" label match)
    if start_raw and _DURATION_PATTERN.match(start_raw.strip()):
        start_raw = None

    return start_raw, end_raw


def _extract_location(soup: BeautifulSoup) -> tuple[Optional[str], Optional[str]]:
    venue: Optional[str] = None
    address: Optional[str] = None

    # 1. itemprop
    for prop in ("location", "address"):
        el = soup.find(itemprop=prop)
        if el and isinstance(el, Tag):
            text = normalize_text(el.get_text(separator=", "))
            if text:
                if prop == "location":
                    venue = text
                else:
                    address = text

    if venue:
        return venue, address

    # 2. Class match
    for el in soup.find_all(True):
        if not isinstance(el, Tag):
            continue
        if _has_class_match(el, _LOCATION_CLASSES):
            text = normalize_text(el.get_text(separator=", "))
            if text and 5 < len(text) < 300:
                venue = text
                break

    # 2b. Anchor links whose href path contains a venue segment
    # Catches patterns like /cinema-venues/siff-cinema-uptown or /venues/paramount
    if not venue:
        for a in soup.find_all("a", href=True):
            href = str(a.get("href", ""))
            if re.search(r"/(?:cinema-)?venues?/", href):
                text = normalize_text(a.get_text(separator=" "))
                if text and 3 < len(text) < 100:
                    venue = text
                    break

    # 3. Label proximity
    if not venue:
        val = _text_near_label(soup, _LOCATION_LABELS)
        if val:
            venue = val

    return venue, address


def _extract_price(soup: BeautifulSoup) -> Optional[str]:
    # 1. itemprop=price
    el = soup.find(itemprop="price")
    if el and isinstance(el, Tag):
        val = el.get("content") or el.get_text(strip=True)
        if val:
            try:
                p = float(str(val))
                return "Free" if p == 0 else f"${p:.2f}"
            except ValueError:
                return extract_price_text(str(val)) or normalize_text(str(val))

    # 2. Class match
    for el in soup.find_all(True):
        if not isinstance(el, Tag):
            continue
        if _has_class_match(el, _PRICE_CLASSES):
            text = el.get_text(strip=True)
            if text:
                return extract_price_text(text) or normalize_text(text)

    # 3. Label proximity
    val = _text_near_label(soup, _PRICE_LABELS)
    if val:
        return extract_price_text(val) or val

    # 4. Scan all text for price patterns
    body_text = soup.get_text(separator=" ")
    return extract_price_text(body_text)


def _extract_image(soup: BeautifulSoup, base_url: str, category: str = "default") -> tuple[Optional[str], Optional[str]]:
    """Delegate to the centralised image extraction chain. Returns (url, source)."""
    return extract_image(soup, base_url, category)


def _extract_description(soup: BeautifulSoup) -> Optional[str]:
    # 1. trafilatura (best for main content)
    try:
        import trafilatura
        body = str(soup)
        text = trafilatura.extract(body, include_comments=False, include_tables=False)
        if text and len(text) > 50:
            return clean_whitespace(text[:2000])
    except Exception:
        pass

    # 2. OG / meta description
    og_desc = _meta(soup, "og:description", "description", "twitter:description")
    if og_desc and len(og_desc) > 20:
        return og_desc

    # 3. First <p> inside main content area
    for container_sel in ["main", "article", ".event-description", ".description"]:
        container = soup.select_one(container_sel)
        if container:
            for p in container.find_all("p"):
                text = normalize_text(p.get_text(separator=" "))
                if len(text) > 50:
                    return text

    return None


def _extract_ticket_url(soup: BeautifulSoup, base_url: str) -> Optional[str]:
    # 1. Known ticket domain links
    for a in soup.find_all("a", href=True):
        href = str(a["href"])
        if _TICKET_DOMAINS.search(href):
            return canonicalize_url(href, base=base_url)

    # 2. Buttons / links with "ticket" text
    for el in soup.find_all(["a", "button"], href=True):
        txt = el.get_text(strip=True).lower()
        if re.search(r"buy\s*ticket|get\s*ticket|register|rsvp|book\s*now|purchase", txt):
            href = el.get("href")
            if href:
                return canonicalize_url(str(href), base=base_url)

    return None


def extract_event(html: str, page_url: str) -> RawEventData:
    """
    Run the full heuristic pipeline on a rendered page.
    Always returns a RawEventData (may be mostly empty).
    """
    soup = BeautifulSoup(html, "lxml")
    raw = RawEventData()

    raw.title = _extract_title(soup)
    raw.start_datetime_raw, raw.end_datetime_raw = _extract_dates(soup)
    raw.venue_name, raw.address = _extract_location(soup)
    raw.price_text = _extract_price(soup)
    raw.image_url, raw.image_source = _extract_image(soup, page_url)
    raw.description = _extract_description(soup)
    raw.description_full = raw.description
    raw.ticket_url = _extract_ticket_url(soup, page_url)
    raw.event_url = page_url

    # Confidence evidence snippets
    snippets = []
    if raw.title:
        snippets.append(f"title: {raw.title[:80]}")
    if raw.start_datetime_raw:
        snippets.append(f"date_raw: {raw.start_datetime_raw[:60]}")
    if raw.venue_name:
        snippets.append(f"venue: {raw.venue_name[:80]}")
    raw.evidence_snippets = snippets

    return raw
