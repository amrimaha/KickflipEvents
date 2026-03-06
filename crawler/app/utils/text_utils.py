"""
Text cleaning and extraction utilities.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Optional


# ── Basic cleaning ────────────────────────────────────────────────────────────

def clean_whitespace(text: str) -> str:
    """Collapse runs of whitespace (including \xa0) to single spaces, strip."""
    text = text.replace("\xa0", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def clean_html_entities(text: str) -> str:
    """Remove stray HTML entities that slipped through the parser."""
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&#?\w+;", "", text)
    return text


def normalize_text(text: str) -> str:
    """Unicode NFC + clean whitespace + strip HTML entities."""
    if not text:
        return ""
    text = unicodedata.normalize("NFC", text)
    text = clean_html_entities(text)
    return clean_whitespace(text)


def truncate(text: str, max_len: int, suffix: str = "…") -> str:
    """Truncate to max_len characters, appending suffix if cut."""
    if not text or len(text) <= max_len:
        return text
    return text[: max_len - len(suffix)] + suffix


# ── Price extraction ──────────────────────────────────────────────────────────

_FREE_RE = re.compile(r"\bfree\b", re.I)
_PRICE_RE = re.compile(
    r"(\$\s*\d+(?:\.\d{2})?(?:\s*[-–]\s*\$?\s*\d+(?:\.\d{2})?)?)"
    r"|(\bfree\b)"
    r"|(\bdonation\b)"
    r"|(\bpay[\s-]?what[\s-]?you[\s-]?can\b)"
    r"|(tickets?\s+from\s+\$\s*\d+)",
    re.I,
)


def extract_price_text(text: str) -> Optional[str]:
    """Return the first price-like snippet found in text, or None."""
    if not text:
        return None
    m = _PRICE_RE.search(text)
    if m:
        return clean_whitespace(m.group(0))
    return None


def is_free_event(text: str) -> bool:
    return bool(_FREE_RE.search(text or ""))


# ── Tag keyword matching ──────────────────────────────────────────────────────

# Taxonomy: tag → list of keywords (lowercased)
TAG_TAXONOMY: dict[str, list[str]] = {
    "music":      ["concert", "live music", "band", "dj", "festival", "gig", "show",
                   "jazz", "hip-hop", "hip hop", "rock", "pop", "classical", "opera",
                   "blues", "country", "folk", "rave", "edm", "acoustic"],
    "tech":       ["tech", "technology", "startup", "software", "coding", "hackathon",
                   "developer", "engineering", "ai", "machine learning", "data science",
                   "cloud", "cybersecurity", "blockchain", "robotics", "demo day"],
    "arts":       ["art", "exhibition", "gallery", "museum", "theater", "theatre",
                   "dance", "ballet", "opera", "photography", "sculpture",
                   "painting", "poetry", "literature", "film", "cinema", "screening"],
    "food":       ["food", "drink", "restaurant", "tasting", "culinary", "beer",
                   "wine", "cocktail", "spirits", "chef", "dining", "brunch",
                   "market", "farmers market", "brew", "distillery"],
    "sports":     ["sports", "fitness", "run", "race", "marathon", "triathlon",
                   "game", "match", "tournament", "athletic", "yoga", "crossfit",
                   "cycling", "swim", "basketball", "soccer", "baseball", "football"],
    "business":   ["business", "networking", "professional", "conference", "summit",
                   "career", "entrepreneur", "investor", "pitch", "leadership",
                   "marketing", "finance", "hr", "management"],
    "education":  ["workshop", "seminar", "class", "course", "training", "lecture",
                   "learn", "education", "skill", "certification", "bootcamp",
                   "tutorial", "webinar", "panel", "discussion"],
    "community":  ["community", "volunteer", "charity", "fundraiser", "nonprofit",
                   "social", "neighborhood", "civic", "cleanup", "donation"],
    "health":     ["health", "wellness", "mental health", "meditation", "mindfulness",
                   "nutrition", "therapy", "self-care", "healing", "yoga",
                   "pilates", "fitness", "exercise"],
    "family":     ["family", "kids", "children", "child", "parent", "toddler",
                   "baby", "youth", "teen", "all ages", "all-ages"],
    "outdoor":    ["outdoor", "nature", "hike", "hiking", "park", "garden",
                   "trail", "camping", "kayak", "paddleboard", "climbing", "adventure"],
    "lgbtq":      ["lgbtq", "lgbt", "pride", "queer", "trans", "nonbinary"],
    "holiday":    ["holiday", "christmas", "halloween", "thanksgiving",
                   "new year", "fourth of july", "valentines", "easter",
                   "hanukkah", "diwali", "lunar new year"],
    "comedy":     ["comedy", "stand-up", "standup", "improv", "open mic",
                   "roast", "sketch", "funny"],
    "gaming":     ["game", "gaming", "esports", "video game", "board game",
                   "tabletop", "rpg", "lan party"],
    "fashion":    ["fashion", "style", "clothing", "runway", "model",
                   "designer", "boutique"],
    "virtual":    ["virtual", "online", "webinar", "zoom", "remote", "livestream",
                   "live stream", "streaming"],
    "free":       ["free admission", "free event", "no cost", "complimentary",
                   "free to attend"],
}


def extract_tags(text: str, max_tags: int = 8) -> list[str]:
    """
    Match text against TAG_TAXONOMY and return relevant tags.
    Tags are ordered by keyword hit count.
    """
    lower = text.lower()
    scores: dict[str, int] = {}
    for tag, keywords in TAG_TAXONOMY.items():
        count = sum(1 for kw in keywords if kw in lower)
        if count:
            scores[tag] = count
    sorted_tags = sorted(scores, key=lambda t: scores[t], reverse=True)
    return sorted_tags[:max_tags]


# ── Snippet extraction ────────────────────────────────────────────────────────

def extract_snippet(text: str, keyword: str, window: int = 80) -> Optional[str]:
    """Return text surrounding *keyword* for evidence snippets."""
    if not text or not keyword:
        return None
    idx = text.lower().find(keyword.lower())
    if idx == -1:
        return None
    start = max(0, idx - window)
    end = min(len(text), idx + len(keyword) + window)
    snippet = text[start:end].strip()
    return clean_whitespace(snippet)
