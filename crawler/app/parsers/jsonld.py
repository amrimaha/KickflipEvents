"""
JSON-LD / schema.org Event extractor.

Uses the `extruct` library for reliable extraction from rendered HTML.
Falls back to manual <script type="application/ld+json"> scanning.

Returns a list of RawEventData (there may be multiple events per page).
"""
from __future__ import annotations

import json
from typing import Any, Optional

from bs4 import BeautifulSoup
from w3lib.html import get_base_url

from app.models.event import RawEventData
from app.parsers.image_extractor import extract_image
from app.utils.logger import BoundLogger
from app.utils.text_utils import normalize_text, extract_price_text

log = BoundLogger("kickflip.parser.jsonld")

# schema.org Event types we recognise
_EVENT_TYPES = {
    "Event", "SportsEvent", "MusicEvent", "TheaterEvent", "ComedyEvent",
    "DanceEvent", "EducationEvent", "ExhibitionEvent", "Festival",
    "FoodEvent", "LiteraryEvent", "SaleEvent", "ScreeningEvent",
    "SocialEvent", "BusinessEvent", "ChildrensEvent", "PublicEvent",
}


def _normalise_type(raw_type: Any) -> str:
    """Extract the bare type name from a @type value (string or list)."""
    if isinstance(raw_type, list):
        raw_type = raw_type[0] if raw_type else ""
    if isinstance(raw_type, str):
        # Handle both 'Event' and 'http://schema.org/Event'
        return raw_type.rsplit("/", 1)[-1]
    return ""


def _str(val: Any) -> Optional[str]:
    if val is None:
        return None
    if isinstance(val, str):
        s = val.strip()
        return s or None
    if isinstance(val, dict):
        return _str(val.get("name") or val.get("@value"))
    if isinstance(val, list):
        return _str(val[0]) if val else None
    return str(val).strip() or None


def _extract_location(loc: Any) -> tuple[Optional[str], Optional[str], Optional[str], Optional[str]]:
    """Return (venue_name, address_str, city, state)."""
    if loc is None:
        return None, None, None, None

    if isinstance(loc, list):
        loc = loc[0]

    if isinstance(loc, str):
        return None, loc, None, None

    if not isinstance(loc, dict):
        return None, None, None, None

    venue_name = _str(loc.get("name"))
    address = loc.get("address", {})

    if isinstance(address, str):
        return venue_name, address, None, None

    if isinstance(address, dict):
        parts = [
            address.get("streetAddress"),
            address.get("addressLocality"),
            address.get("addressRegion"),
            address.get("postalCode"),
        ]
        addr_str = ", ".join(p for p in parts if p)
        city = _str(address.get("addressLocality"))
        state = _str(address.get("addressRegion"))
        return venue_name, addr_str or None, city, state

    return venue_name, None, None, None


def _extract_price(offers: Any) -> Optional[str]:
    if offers is None:
        return None
    if isinstance(offers, list):
        offers = offers[0]
    if isinstance(offers, dict):
        price = offers.get("price")
        currency = offers.get("priceCurrency", "")
        category = _str(offers.get("category"))
        if category and "free" in category.lower():
            return "Free"
        if price is not None:
            try:
                p = float(price)
                if p == 0:
                    return "Free"
                symbol = "$" if currency in ("USD", "") else currency
                return f"{symbol}{p:.2f}"
            except (ValueError, TypeError):
                return _str(price)
    if isinstance(offers, str):
        return extract_price_text(offers)
    return None


def _extract_ticket_url(offers: Any) -> Optional[str]:
    if isinstance(offers, list):
        offers = offers[0]
    if isinstance(offers, dict):
        return _str(offers.get("url"))
    return None


def _extract_organizer(org: Any) -> Optional[str]:
    if isinstance(org, list):
        org = org[0]
    if isinstance(org, dict):
        return _str(org.get("name"))
    return _str(org)


def _extract_performers(performers: Any) -> list[str]:
    if performers is None:
        return []
    if not isinstance(performers, list):
        performers = [performers]
    result = []
    for p in performers:
        name = _str(p.get("name") if isinstance(p, dict) else p)
        if name:
            result.append(name)
    return result


def _parse_jsonld_event(item: dict) -> Optional[RawEventData]:
    """Convert a single schema.org Event dict → RawEventData."""
    t = _normalise_type(item.get("@type", ""))
    if t not in _EVENT_TYPES:
        return None

    raw = RawEventData()

    raw.title = _str(item.get("name"))
    raw.start_datetime_raw = _str(item.get("startDate"))
    raw.end_datetime_raw = _str(item.get("endDate"))
    raw.description = normalize_text(_str(item.get("description")) or "")
    raw.description_full = raw.description
    raw.image_url = _str(
        item.get("image") if isinstance(item.get("image"), str)
        else (item.get("image") or {}).get("url") if isinstance(item.get("image"), dict)
        else None
    )

    # Handle image as list
    img = item.get("image")
    if isinstance(img, list) and img:
        img = img[0]
    if isinstance(img, dict):
        raw.image_url = _str(img.get("url") or img.get("@id"))
    elif isinstance(img, str):
        raw.image_url = img or None

    venue_name, address, city, state = _extract_location(item.get("location"))
    raw.venue_name = venue_name
    raw.address = address
    raw.city = city
    raw.state = state

    raw.price_text = _extract_price(item.get("offers"))
    raw.ticket_url = _extract_ticket_url(item.get("offers"))

    # Canonical event URL
    raw.event_url = _str(item.get("url"))

    raw.organizer = _extract_organizer(item.get("organizer"))
    raw.performers = _extract_performers(item.get("performer"))

    # Event format / virtual
    ev_attendance = _str(item.get("eventAttendanceMode") or "")
    if ev_attendance:
        if "Online" in ev_attendance:
            raw.event_format = "virtual"
        elif "Mixed" in ev_attendance:
            raw.event_format = "hybrid"
        else:
            raw.event_format = "in-person"

    raw.categories_raw = (
        item.get("keywords", "").split(",") if isinstance(item.get("keywords"), str)
        else item.get("keywords", []) if isinstance(item.get("keywords"), list)
        else []
    )

    raw.evidence_snippets = [f"JSON-LD type={t}"]

    return raw


def _fill_missing_images(results: list[RawEventData], soup: BeautifulSoup, page_url: str) -> None:
    """For any result that has no image_url, run the image extraction chain."""
    for raw in results:
        if not raw.image_url:
            raw.image_url, raw.image_source = extract_image(soup, page_url)


def extract_from_html(html: str, page_url: str) -> list[RawEventData]:
    """
    Primary: use extruct for robust extraction.
    Fallback: manual <script type=application/ld+json> scan.
    After extraction, fills missing image_url via the image extraction chain.
    """
    results: list[RawEventData] = []

    # ── extruct ───────────────────────────────────────────────────────────────
    try:
        import extruct
        base_url = get_base_url(html, page_url)
        data = extruct.extract(
            html,
            base_url=base_url,
            syntaxes=["json-ld"],
            uniform=True,
        )
        for item in data.get("json-ld", []):
            # Handle @graph
            if "@graph" in item:
                for subitem in item["@graph"]:
                    r = _parse_jsonld_event(subitem)
                    if r:
                        results.append(r)
            else:
                r = _parse_jsonld_event(item)
                if r:
                    results.append(r)
    except Exception as exc:
        log.warning(f"extruct failed, falling back to manual scan: {exc}")

    # Build soup once — used by both the manual fallback and image fill
    soup = BeautifulSoup(html, "lxml")

    if results:
        _fill_missing_images(results, soup, page_url)
        return results

    # ── Manual fallback ───────────────────────────────────────────────────────
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            payload = json.loads(script.string or "")
            items = payload if isinstance(payload, list) else [payload]
            for item in items:
                if "@graph" in item:
                    for subitem in item["@graph"]:
                        r = _parse_jsonld_event(subitem)
                        if r:
                            results.append(r)
                else:
                    r = _parse_jsonld_event(item)
                    if r:
                        results.append(r)
        except (json.JSONDecodeError, TypeError):
            pass

    _fill_missing_images(results, soup, page_url)
    return results
