"""Base types shared by static + dynamic crawlers."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class FetchResult:
    url: str
    html: str
    status_code: int
    final_url: str          # after redirects
    is_dynamic: bool = False
    error: Optional[str] = None
    elapsed_ms: int = 0

    @property
    def ok(self) -> bool:
        return self.error is None and 200 <= self.status_code < 400


# Signals that strongly suggest a page is a SPA / needs JS rendering
SPA_SIGNALS = [
    "window.__NEXT_DATA__",
    "window.__nuxt__",
    "__REACT_DEVTOOLS",
    "app-root",
    "ng-version",
    'data-reactroot',
    "Vue.config",
    "svelte",
    # Specific patterns: very little visible text but heavy JS
]


def looks_like_spa(html: str) -> bool:
    """Quick heuristic: does the static HTML look like an unrendered SPA?"""
    for signal in SPA_SIGNALS:
        if signal in html:
            return True
    # If the body is mostly empty but the page is large (lots of JS), flag it
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "lxml")
    body = soup.body
    if body:
        text = body.get_text(strip=True)
        if len(text) < 200 and len(html) > 5_000:
            return True
    return False
