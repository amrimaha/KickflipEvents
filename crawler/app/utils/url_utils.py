"""
URL canonicalization, filtering, and robots.txt helpers.
"""
from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import (
    ParseResult,
    parse_qs,
    unquote,
    urlencode,
    urljoin,
    urlparse,
    urlunparse,
)

import httpx

# Tracking / noise query params to strip
_STRIP_PARAMS: frozenset[str] = frozenset(
    {
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
        "utm_id", "utm_referrer",
        "fbclid", "gclid", "gclsrc", "dclid", "msclkid",
        "mc_cid", "mc_eid",
        "ref", "referrer", "source", "origin",
        "_ga", "_gl",
        "igshid",
    }
)

# Patterns for URLs that are almost certainly not event detail pages
_DENY_EXTENSIONS: re.Pattern = re.compile(
    r"\.(css|js|json|xml|pdf|zip|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|mp4|mp3|avi|mov)$",
    re.IGNORECASE,
)


def canonicalize_url(url: str, base: Optional[str] = None) -> str:
    """
    - Resolve relative URLs against base if given.
    - Strip fragment (#…).
    - Strip tracking query params.
    - Lowercase scheme + host.
    - Remove trailing slash from path (except bare root).
    """
    if base:
        url = urljoin(base, url)

    try:
        p: ParseResult = urlparse(url)
    except Exception:
        return url

    # Lowercase scheme and host
    scheme = p.scheme.lower()
    netloc = p.netloc.lower()

    # Strip tracking params
    qs = parse_qs(p.query, keep_blank_values=False)
    clean_qs = {k: v for k, v in qs.items() if k.lower() not in _STRIP_PARAMS}
    new_query = urlencode(clean_qs, doseq=True)

    # Normalise path: remove trailing slash (unless root)
    path = p.path
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")

    return urlunparse((scheme, netloc, path, p.params, new_query, ""))


def is_likely_event_url(url: str, allow_patterns: list[str], deny_patterns: list[str]) -> bool:
    """
    Return True if *url* passes allow/deny pattern lists.
    - deny_patterns are checked first (any match → reject).
    - allow_patterns: if non-empty, url must match at least one.
    - Always reject non-HTTP(S) URLs and obvious static assets.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return False
    if _DENY_EXTENSIONS.search(parsed.path):
        return False

    for dp in deny_patterns:
        if re.search(dp, url):
            return False

    if allow_patterns:
        return any(re.search(ap, url) for ap in allow_patterns)

    return True


def same_domain(url1: str, url2: str) -> bool:
    return urlparse(url1).netloc.lower() == urlparse(url2).netloc.lower()


def extract_domain(url: str) -> str:
    return urlparse(url).netloc.lower()


# ── robots.txt ───────────────────────────────────────────────────────────────

@dataclass
class RobotsResult:
    """Result of a robots.txt check for a specific URL."""
    allowed: bool
    # "ok"          – robots.txt fetched and parsed; rule applied
    # "missing"     – robots.txt returned 4xx (not 401/403); allow-all per spec
    # "disallow_all"– robots.txt returned 401 or 403; block-all per spec
    # "timeout"     – fetch timed out; fail-open (allowed=True)
    # "error"       – other fetch error; fail-open (allowed=True)
    status: str
    crawl_delay: Optional[float] = None     # seconds from Crawl-delay directive
    matched_rule: Optional[str] = None      # e.g. "Disallow: /events/"
    error: Optional[str] = None
    fetch_status: Optional[int] = None      # HTTP status code from robots.txt fetch


@dataclass
class _ParsedRobots:
    """Cached per-origin robots.txt parse results."""
    status: str   # same values as RobotsResult.status
    # list of {"agents": [str], "rules": [(allow:bool, path:str)], "delay": float|None}
    groups: list = field(default_factory=list)
    error: Optional[str] = None
    fetch_status: Optional[int] = None      # HTTP status code from robots.txt fetch


# Cache: origin (scheme://host) → _ParsedRobots
_robots_cache: dict[str, _ParsedRobots] = {}
# Lock: avoid concurrent fetches for the same origin
_robots_fetch_locks: dict[str, asyncio.Lock] = {}


def _parse_robots_content(content: str) -> list[dict]:
    """
    Parse robots.txt content into a list of agent groups.
    Each group: {"agents": [str], "rules": [(allow:bool, path:str)], "delay": float|None}

    Handles:
    - Directives before the first User-agent: line are ignored
    - Multiple User-agent: lines for one rule block
    - Blank lines delimit groups
    - Disallow: (empty) = allow all (per RFC 9309)
    - Allow: takes precedence over Disallow at same path length
    - Crawl-delay: extracted per group
    """
    groups: list[dict] = []
    current: Optional[dict] = None
    in_rules = False  # True once we've seen at least one rule/directive after User-agent

    for raw_line in content.splitlines():
        # Strip inline comments
        if "#" in raw_line:
            raw_line = raw_line[: raw_line.index("#")]
        line = raw_line.strip()

        if not line:
            # Blank line: finalise current group if it has rules
            if current is not None and in_rules:
                groups.append(current)
                current = None
                in_rules = False
            continue

        if ":" not in line:
            continue

        key, _, value = line.partition(":")
        key = key.strip().lower()
        value = value.strip()

        if key == "user-agent":
            agent = value.lower()
            if in_rules:
                # Starting a new group after rules
                groups.append(current)
                current = None
                in_rules = False
            if current is None:
                current = {"agents": [], "rules": [], "delay": None}
            current["agents"].append(agent)

        elif current is not None:
            in_rules = True
            if key == "disallow":
                current["rules"].append((False, value))
            elif key == "allow":
                current["rules"].append((True, value))
            elif key == "crawl-delay":
                try:
                    current["delay"] = float(value)
                except ValueError:
                    pass
            # Sitemap and other directives are ignored for rule evaluation

    if current is not None and in_rules:
        groups.append(current)

    return groups


def _evaluate_rules(
    groups: list[dict],
    ua_token: str,
    url_path: str,
) -> tuple[bool, Optional[float], Optional[str]]:
    """
    Find the best matching group for ua_token and evaluate url_path.
    Returns (allowed, crawl_delay, matched_rule).

    ua_token: lowercase first word of the user-agent (e.g. "mozilla").
    Match priority: specific UA > wildcard (*).
    Rule priority: longest matching path wins; Allow beats Disallow at equal length.
    """
    specific: Optional[dict] = None
    wildcard: Optional[dict] = None

    for g in groups:
        for agent in g["agents"]:
            if agent == "*":
                wildcard = g
            elif ua_token and (ua_token in agent or agent in ua_token):
                if specific is None:
                    specific = g

    best = specific or wildcard
    if best is None:
        return True, None, None  # No applicable rules → allow

    crawl_delay = best["delay"]
    rules = best["rules"]

    # Check for "Disallow: " (empty path) = allow all → short-circuit immediately
    for allow, path in rules:
        if not allow and path == "":
            return True, crawl_delay, None

    # Find longest matching rule; Allow beats Disallow at equal length
    best_match_len = -1
    best_match_allow = True
    best_match_rule: Optional[str] = None

    for allow, path in rules:
        if not path:
            continue  # Empty Disallow already handled above; empty Allow is no-op
        rule_path = unquote(path)
        if url_path.startswith(rule_path):
            plen = len(rule_path)
            if plen > best_match_len or (plen == best_match_len and allow and not best_match_allow):
                best_match_len = plen
                best_match_allow = allow
                best_match_rule = f"{'Allow' if allow else 'Disallow'}: {path}"

    if best_match_len >= 0:
        return best_match_allow, crawl_delay, best_match_rule

    return True, crawl_delay, None  # No path matched → allow


async def _fetch_and_parse_robots(
    origin: str,
    user_agent: str,
    timeout: float,
) -> _ParsedRobots:
    """Fetch robots.txt for an origin and return parsed data."""
    robots_url = f"{origin}/robots.txt"

    try:
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            headers={"User-Agent": user_agent},
        ) as client:
            r = await client.get(robots_url)

        status_code = r.status_code

        if status_code in (401, 403):
            # Spec: treat authentication / access-denied as disallow-all
            return _ParsedRobots(status="disallow_all", fetch_status=status_code)

        if status_code == 200:
            groups = _parse_robots_content(r.text)
            return _ParsedRobots(status="ok", groups=groups, fetch_status=status_code)

        # 404, 410, and other 4xx/5xx → treat as missing → allow-all
        return _ParsedRobots(status="missing", fetch_status=status_code)

    except httpx.TimeoutException as exc:
        return _ParsedRobots(status="timeout", error=str(exc))
    except Exception as exc:
        return _ParsedRobots(status="error", error=str(exc))


async def check_robots(
    url: str,
    user_agent: str,
    fetch_timeout: float = 8.0,
) -> RobotsResult:
    """
    Check whether *user_agent* is allowed to fetch *url* per robots.txt.

    Fetches robots.txt using the same *user_agent* as the crawler (so the site
    evaluates the same identity we present on real requests).  Results are cached
    per origin for the lifetime of the process.

    Behaviour by robots.txt fetch result:
      200 OK            → parse and evaluate rules
      401 / 403         → disallow_all (RFC 9309: treat as if Disallow: / for *)
      4xx other / 5xx   → missing → allow (RFC 9309: no restrictions)
      Timeout           → fail-open (allow), log status="timeout"
      Other error       → fail-open (allow), log status="error"
    """
    parsed = urlparse(url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    url_path = unquote(parsed.path) or "/"

    # Ensure one fetch lock per origin
    if origin not in _robots_fetch_locks:
        _robots_fetch_locks[origin] = asyncio.Lock()

    async with _robots_fetch_locks[origin]:
        if origin not in _robots_cache:
            _robots_cache[origin] = await _fetch_and_parse_robots(
                origin, user_agent, fetch_timeout
            )

    cached = _robots_cache[origin]

    # Non-OK statuses short-circuit rule evaluation
    if cached.status == "disallow_all":
        return RobotsResult(
            allowed=False,
            status="disallow_all",
            fetch_status=cached.fetch_status,
        )
    if cached.status in ("missing", "timeout", "error"):
        return RobotsResult(
            allowed=True,
            status=cached.status,
            error=cached.error,
            fetch_status=cached.fetch_status,
        )

    # status == "ok" → evaluate rules
    # Extract ua_token: first lowercase word before '/' in user_agent
    ua_token = user_agent.lower().split("/")[0].strip()

    allowed, crawl_delay, matched_rule = _evaluate_rules(
        cached.groups, ua_token, url_path
    )
    return RobotsResult(
        allowed=allowed,
        status="ok",
        crawl_delay=crawl_delay,
        matched_rule=matched_rule,
        fetch_status=cached.fetch_status,
    )


# Crawl-delay throttle: domain → (delay_seconds, last_fetch_time)
_crawl_delay_state: dict[str, tuple[float, float]] = {}


async def apply_crawl_delay(domain: str, crawl_delay: float) -> None:
    """Sleep the remaining crawl-delay for *domain* if needed."""
    import time
    now = time.monotonic()
    if domain in _crawl_delay_state:
        _, last_t = _crawl_delay_state[domain]
        elapsed = now - last_t
        if elapsed < crawl_delay:
            await asyncio.sleep(crawl_delay - elapsed)
    _crawl_delay_state[domain] = (crawl_delay, time.monotonic())
