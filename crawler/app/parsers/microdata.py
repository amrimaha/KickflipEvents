"""
Microdata / itemprop extractor.

Looks for itemscope + itemtype=schema.org/Event and extracts properties.
"""
from __future__ import annotations

from typing import Optional

from bs4 import BeautifulSoup, Tag

from app.models.event import RawEventData
from app.parsers.image_extractor import extract_image
from app.utils.text_utils import normalize_text, extract_price_text

_SCHEMA_EVENT_TYPES = {
    "http://schema.org/event",
    "https://schema.org/event",
    "http://schema.org/musicEvent",
    "https://schema.org/musicEvent",
    "http://schema.org/sportsevent",
    "https://schema.org/sportsevent",
    "http://schema.org/theaterevent",
    "https://schema.org/theaterevent",
    "http://schema.org/educationevent",
    "https://schema.org/educationevent",
}


def _prop(el: Tag, name: str) -> Optional[str]:
    """Find first itemprop=name within el, return its value."""
    child = el.find(itemprop=name)
    if child is None:
        return None
    # Prefer datetime attribute, then content, then text
    val = child.get("datetime") or child.get("content") or child.get_text(strip=True)
    return normalize_text(str(val)) if val else None


def _prop_link(el: Tag, name: str) -> Optional[str]:
    """Return href of first itemprop=name anchor."""
    child = el.find(itemprop=name)
    if child and child.get("href"):
        return str(child["href"])
    return None


def _extract_location(el: Tag) -> tuple[Optional[str], Optional[str], Optional[str], Optional[str]]:
    loc_el = el.find(itemprop="location")
    if not loc_el or not isinstance(loc_el, Tag):
        return None, None, None, None

    venue_name = _prop(loc_el, "name")

    addr_el = loc_el.find(itemprop="address")
    if addr_el and isinstance(addr_el, Tag):
        street = _prop(addr_el, "streetAddress")
        city = _prop(addr_el, "addressLocality")
        state = _prop(addr_el, "addressRegion")
        postal = _prop(addr_el, "postalCode")
        parts = [p for p in [street, city, state, postal] if p]
        return venue_name, ", ".join(parts) or None, city, state

    # Fallback: raw address text
    addr_text = normalize_text(loc_el.get_text(separator=" "))
    return venue_name, addr_text or None, None, None


def extract_from_html(html: str, page_url: str) -> list[RawEventData]:
    """Extract all schema.org/Event microdata blocks from HTML."""
    soup = BeautifulSoup(html, "lxml")
    results: list[RawEventData] = []

    for el in soup.find_all(itemscope=True):
        itemtype = str(el.get("itemtype", "")).lower()
        if not any(t in itemtype for t in _SCHEMA_EVENT_TYPES):
            continue

        raw = RawEventData()
        raw.title = _prop(el, "name")
        raw.start_datetime_raw = _prop(el, "startDate")
        raw.end_datetime_raw = _prop(el, "endDate")

        desc = _prop(el, "description")
        raw.description = normalize_text(desc or "")
        raw.description_full = raw.description

        raw.image_url = _prop(el, "image")
        if not raw.image_url:
            raw.image_url, raw.image_source = extract_image(soup, page_url)
        raw.event_url = _prop_link(el, "url") or _prop(el, "url")

        venue_name, address, city, state = _extract_location(el)
        raw.venue_name = venue_name
        raw.address = address
        raw.city = city
        raw.state = state

        # Price from offers
        offers_el = el.find(itemprop="offers")
        if offers_el and isinstance(offers_el, Tag):
            price_val = _prop(offers_el, "price")
            currency = _prop(offers_el, "priceCurrency") or ""
            if price_val:
                try:
                    p = float(price_val)
                    raw.price_text = "Free" if p == 0 else f"${p:.2f}"
                except ValueError:
                    raw.price_text = extract_price_text(price_val) or price_val
            ticket_link = _prop_link(offers_el, "url")
            raw.ticket_url = ticket_link

        # Organizer
        org_el = el.find(itemprop="organizer")
        if org_el and isinstance(org_el, Tag):
            raw.organizer = normalize_text(org_el.get_text(separator=" "))

        raw.evidence_snippets = ["microdata schema.org/Event"]

        if raw.title or raw.start_datetime_raw:
            results.append(raw)

    return results
