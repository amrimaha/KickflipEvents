"""
Priority-ordered image extraction chain.

Given a BeautifulSoup page object, tries each strategy in order and returns
(image_url, image_source) where image_source is a label for which strategy
won.  Both values are None if all strategies fail.

Priority:
  1. og:image / og:image:secure_url     → source = "og"
  2. twitter:image / twitter:image:src  → source = "twitter"
  3. <script type=application/ld+json> image field → source = "jsonld"
  4. First meaningful <img> tag         → source = "img_tag"
  5. Unsplash fallback by category      → source = "unsplash"

Public API:
    image_url, image_source = extract_image(soup, page_url, category)
"""
from __future__ import annotations

import json
import re
from typing import Optional

from bs4 import BeautifulSoup, Tag

from app.utils.url_utils import canonicalize_url

# ── Unsplash fallback map ─────────────────────────────────────────────────────

UNSPLASH_FALLBACKS: dict[str, list[str]] = {
    "Music": [
        "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f",
        "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3",
    ],
    "Arts": [
        "https://images.unsplash.com/photo-1547891654-e66ed7ebb968",
        "https://images.unsplash.com/photo-1578926288207-a90a5366c21d",
    ],
    "Food & Drink": [
        "https://images.unsplash.com/photo-1414235077428-338989a2e8c0",
        "https://images.unsplash.com/photo-1555396273-367ea4eb4db5",
    ],
    "Outdoor": [
        "https://images.unsplash.com/photo-1441974231531-c6227db76b6e",
        "https://images.unsplash.com/photo-1506905925346-21bda4d32df4",
    ],
    "Comedy": [
        "https://images.unsplash.com/photo-1527224538127-2104bb71c51b",
    ],
    "Sports": [
        "https://images.unsplash.com/photo-1461896836934-ffe607ba8211",
    ],
    "Wellness": [
        "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b",
    ],
    "default": [
        "https://images.unsplash.com/photo-1492684223066-81342ee5ff30",
    ],
}

# Normalised category aliases (lowercase → UNSPLASH_FALLBACKS key)
_CATEGORY_ALIASES: dict[str, str] = {
    "music": "Music",
    "arts": "Arts",
    "art": "Arts",
    "food": "Food & Drink",
    "food & drink": "Food & Drink",
    "drink": "Food & Drink",
    "outdoor": "Outdoor",
    "outdoors": "Outdoor",
    "comedy": "Comedy",
    "sports": "Sports",
    "sport": "Sports",
    "wellness": "Wellness",
    "health": "Wellness",
}

# Patterns that indicate a non-content image to skip
_SKIP_SRC_RE = re.compile(
    r"logo|icon|avatar|spinner|placeholder|pixel|tracking|spacer|badge|banner-"
    r"|button|arrow|social|share|close|menu|search|cart|rating|star",
    re.I,
)


def _meta_content(soup: BeautifulSoup, *props: str) -> Optional[str]:
    """Return content of the first matching <meta property=...> or <meta name=...>."""
    for prop in props:
        el = soup.find("meta", {"property": prop}) or soup.find("meta", {"name": prop})
        if el and isinstance(el, Tag) and el.get("content"):
            val = str(el["content"]).strip()
            if val:
                return val
    return None


def _jsonld_image(soup: BeautifulSoup) -> Optional[str]:
    """Extract the first image field from any schema.org Event JSON-LD block."""
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            payload = json.loads(script.string or "")
        except (json.JSONDecodeError, TypeError):
            continue

        items = payload if isinstance(payload, list) else [payload]
        for item in items:
            # Handle @graph wrapper
            if "@graph" in item and isinstance(item["@graph"], list):
                items.extend(item["@graph"])
                continue

            img = item.get("image")
            if not img:
                continue
            # Normalise: list → first element
            if isinstance(img, list) and img:
                img = img[0]
            if isinstance(img, str) and img:
                return img
            if isinstance(img, dict):
                url = img.get("url") or img.get("@id") or img.get("contentUrl")
                if url and isinstance(url, str):
                    return url

    return None


def _img_tag_image(soup: BeautifulSoup, base_url: str) -> Optional[str]:
    """
    Find the first meaningful <img> tag.
    Filters out icons, logos, tracking pixels, and base64 data URIs.
    """
    for img in soup.find_all("img"):
        if not isinstance(img, Tag):
            continue

        src = (
            img.get("src")
            or img.get("data-src")
            or img.get("data-lazy-src")
            or img.get("data-original")
        )
        if not src or not isinstance(src, str):
            continue

        src = src.strip()

        # Skip base64 data URIs and empty strings
        if src.startswith("data:") or not src:
            continue

        # Skip known non-content images by src content
        if _SKIP_SRC_RE.search(src):
            continue

        # Dimension check — skip tiny images
        try:
            w = int(img.get("width") or 0)
            h = int(img.get("height") or 0)
        except (ValueError, TypeError):
            w = h = 0

        if (w and w < 50) or (h and h < 50):
            continue

        # Accept if no size attributes (unknown) OR sufficiently large
        if (w == 0 and h == 0) or w > 200 or h > 200:
            return canonicalize_url(src, base=base_url)

    return None


def _unsplash_fallback(url: str, category: str) -> str:
    """
    Return a consistent Unsplash image for the given category.
    Uses hash(url) % len(options) so the same event always gets the same image.
    """
    key = _CATEGORY_ALIASES.get(category.lower(), None)
    options = UNSPLASH_FALLBACKS.get(key or "", UNSPLASH_FALLBACKS["default"])
    if not options:
        options = UNSPLASH_FALLBACKS["default"]
    return options[hash(url) % len(options)]


def extract_image(
    soup: BeautifulSoup,
    url: str,
    category: str = "default",
) -> tuple[Optional[str], Optional[str]]:
    """
    Run the priority-ordered image extraction chain.

    Returns (image_url, image_source) where image_source is one of:
        "og" | "twitter" | "jsonld" | "img_tag" | "unsplash"
    Both values are None only when the Unsplash fallback is also disabled,
    which never happens — the fallback always returns a URL.
    In practice this always returns a (url, source) pair.
    """
    # Priority 1: OG image
    og = _meta_content(soup, "og:image:secure_url", "og:image")
    if og:
        return canonicalize_url(og, base=url), "og"

    # Priority 2: Twitter card
    twitter = _meta_content(soup, "twitter:image", "twitter:image:src")
    if twitter:
        return canonicalize_url(twitter, base=url), "twitter"

    # Priority 3: JSON-LD image field
    jsonld_img = _jsonld_image(soup)
    if jsonld_img:
        return canonicalize_url(jsonld_img, base=url), "jsonld"

    # Priority 4: First meaningful <img> tag
    img_tag = _img_tag_image(soup, url)
    if img_tag:
        return img_tag, "img_tag"

    # Priority 5: Unsplash fallback
    return _unsplash_fallback(url, category), "unsplash"
