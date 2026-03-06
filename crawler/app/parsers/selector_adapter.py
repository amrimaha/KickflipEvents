"""
Site profile / selector adapter.

Loads YAML files from the site_profiles/ directory and uses CSS selectors
to extract event data in a deterministic, per-site way.

Profile file names must match the source `name` field (slugified).
Example: sources.yaml name="Seattle ACM" → site_profiles/seattle_acm.yaml
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Optional

import yaml
from bs4 import BeautifulSoup, Tag

from app.models.event import RawEventData
from app.parsers.image_extractor import extract_image
from app.utils.logger import BoundLogger
from app.utils.text_utils import normalize_text, extract_price_text
from app.utils.url_utils import canonicalize_url

log = BoundLogger("kickflip.parser.selector")

_profile_cache: dict[str, Optional[dict]] = {}


def _slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def load_profile(source_name: str, profiles_dir: str = "site_profiles") -> Optional[dict]:
    """Load site profile YAML for *source_name*. Returns None if not found."""
    slug = _slugify(source_name)
    cache_key = f"{profiles_dir}/{slug}"
    if cache_key in _profile_cache:
        return _profile_cache[cache_key]

    base = Path(profiles_dir)
    for ext in (".yaml", ".yml"):
        path = base / (slug + ext)
        if path.exists():
            try:
                with path.open("r", encoding="utf-8") as fh:
                    profile = yaml.safe_load(fh)
                _profile_cache[cache_key] = profile
                log.info(f"Loaded site profile: {path}", source_name=source_name)
                return profile
            except Exception as exc:
                log.warning(f"Failed to load profile {path}: {exc}", source_name=source_name)

    _profile_cache[cache_key] = None
    return None


def _sel(soup: BeautifulSoup | Tag, selector: Optional[str], attr: Optional[str] = None) -> Optional[str]:
    """Run a CSS selector on soup, return text or attribute value."""
    if not selector:
        return None
    try:
        el = soup.select_one(selector)
        if el is None:
            return None
        if attr:
            val = el.get(attr)
            return str(val).strip() if val else None
        return normalize_text(el.get_text(separator=" "))
    except Exception:
        return None


def _sel_attr(soup: BeautifulSoup | Tag, selector: Optional[str], attr: str) -> Optional[str]:
    return _sel(soup, selector, attr=attr)


def extract_event_urls(html: str, page_url: str, profile: dict) -> list[str]:
    """
    Use listing.event_link_selector from the profile to discover event URLs.
    Returns a list of absolute, canonicalized URLs.
    """
    listing = profile.get("listing", {})
    selector = listing.get("event_link_selector")
    link_attr = listing.get("event_link_attr", "href")

    if not selector:
        return []

    soup = BeautifulSoup(html, "lxml")
    urls: list[str] = []
    for el in soup.select(selector):
        href = el.get(link_attr) or el.get("href")
        if href:
            urls.append(canonicalize_url(str(href), base=page_url))

    return list(dict.fromkeys(urls))  # deduplicate, preserve order


def extract_event(html: str, page_url: str, profile: dict) -> Optional[RawEventData]:
    """
    Use the profile's event selectors to extract a single event from a detail page.
    """
    ev = profile.get("event", {})
    if not ev:
        return None

    soup = BeautifulSoup(html, "lxml")
    raw = RawEventData()

    raw.title = _sel(soup, ev.get("title_selector"))

    # Date/time
    date_sel = ev.get("start_date_selector")
    date_attr = ev.get("start_date_attr")
    if date_sel and date_attr:
        raw.start_datetime_raw = _sel_attr(soup, date_sel, date_attr) or _sel(soup, date_sel)
    else:
        raw.start_datetime_raw = _sel(soup, date_sel)

    time_sel = ev.get("start_time_selector")
    if time_sel and raw.start_datetime_raw:
        t = _sel(soup, time_sel)
        if t:
            raw.start_datetime_raw = f"{raw.start_datetime_raw} {t}"

    # End date/time
    end_date_sel = ev.get("end_date_selector")
    if end_date_sel:
        raw.end_datetime_raw = _sel(soup, end_date_sel)

    # Location
    raw.venue_name = _sel(soup, ev.get("venue_selector"))
    raw.address = _sel(soup, ev.get("address_selector"))
    raw.city = _sel(soup, ev.get("city_selector"))
    raw.state = _sel(soup, ev.get("state_selector"))

    # Price
    price_raw = _sel(soup, ev.get("price_selector"))
    raw.price_text = extract_price_text(price_raw or "") or price_raw

    # Ticket link
    raw.ticket_url = _sel_attr(soup, ev.get("ticket_link_selector"), "href")

    # Image
    img_sel = ev.get("image_selector")
    img_attr = ev.get("image_attr", "src")
    raw.image_url = _sel_attr(soup, img_sel, img_attr) if img_sel else None
    if not raw.image_url:
        raw.image_url, raw.image_source = extract_image(soup, page_url)

    # Description
    raw.description = _sel(soup, ev.get("description_selector"))

    raw.event_url = page_url
    raw.evidence_snippets = [f"site_profile:{profile.get('name', 'unknown')}"]

    return raw if raw.title or raw.start_datetime_raw else None
