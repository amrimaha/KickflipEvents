"""
Pluggable LLM client.

Supports three providers via env-var configuration:
  LLM_PROVIDER=gemini      (default) — google-generativeai SDK
  LLM_PROVIDER=openai               — openai SDK
  LLM_PROVIDER=anthropic            — anthropic SDK

Each provider SDK is imported lazily so only the one you use needs to be
installed.  Providers are selected purely by the LLM_PROVIDER env var — no
code change needed to switch.

Usage:
    client = LLMClient(provider="gemini", model="gemini-2.0-flash", api_key="...")
    text = await client.complete(system="...", user="...", max_tokens=512)
"""
from __future__ import annotations

from typing import AsyncIterator, Optional

from app.utils.logger import BoundLogger

log = BoundLogger("kickflip.llm_client")


class LLMClient:
    def __init__(self, provider: str, model: str, api_key: str) -> None:
        self.provider = provider.lower().strip()
        self.model = model
        self.api_key = api_key

    async def complete(
        self,
        system: str,
        user: str,
        max_tokens: int = 512,
    ) -> Optional[str]:
        """
        Send a system + user message and return the text response.
        Returns None on any error.
        """
        try:
            if self.provider == "gemini":
                return await self._call_gemini(system, user, max_tokens)
            elif self.provider == "openai":
                return await self._call_openai(system, user, max_tokens)
            elif self.provider in ("anthropic", "claude"):
                return await self._call_anthropic(system, user, max_tokens)
            else:
                log.error(f"Unknown LLM provider: {self.provider!r}")
                return None
        except Exception as exc:
            log.warning(f"LLM ({self.provider}) call failed: {exc}")
            return None

    # ── Gemini ────────────────────────────────────────────────────────────────

    async def _call_gemini(self, system: str, user: str, max_tokens: int) -> Optional[str]:
        try:
            from google import genai
            from google.genai import types
        except ImportError:
            raise ImportError(
                "google-genai is required for LLM_PROVIDER=gemini. "
                "Run: pip install google-genai"
            )

        client = genai.Client(api_key=self.api_key)
        response = await client.aio.models.generate_content(
            model=self.model,
            contents=user,
            config=types.GenerateContentConfig(
                system_instruction=system,
                max_output_tokens=max_tokens,
                temperature=0.0,      # deterministic extraction
            ),
        )
        return response.text

    # ── OpenAI ────────────────────────────────────────────────────────────────

    async def _call_openai(self, system: str, user: str, max_tokens: int) -> Optional[str]:
        try:
            from openai import AsyncOpenAI
        except ImportError:
            raise ImportError(
                "openai is required for LLM_PROVIDER=openai. "
                "Run: pip install openai"
            )

        client = AsyncOpenAI(api_key=self.api_key)
        resp = await client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            max_tokens=max_tokens,
            temperature=0.0,
        )
        return resp.choices[0].message.content

    # ── Anthropic ─────────────────────────────────────────────────────────────

    async def _call_anthropic(self, system: str, user: str, max_tokens: int) -> Optional[str]:
        try:
            import anthropic
        except ImportError:
            raise ImportError(
                "anthropic is required for LLM_PROVIDER=anthropic. "
                "Run: pip install anthropic"
            )

        client = anthropic.AsyncAnthropic(api_key=self.api_key)
        msg = await client.messages.create(
            model=self.model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return msg.content[0].text

    # ── Streaming ─────────────────────────────────────────────────────────────

    async def stream(
        self,
        system: str,
        messages: list[dict],
        max_tokens: int = 1024,
    ) -> AsyncIterator[str]:
        """
        Stream response tokens as an async generator.
        *messages* is a list of {"role": "user"|"assistant", "content": "..."} dicts.
        Raises on provider errors (caller should handle).
        """
        if self.provider in ("anthropic", "claude"):
            async for token in self._stream_anthropic(system, messages, max_tokens):
                yield token
        elif self.provider == "openai":
            async for token in self._stream_openai(system, messages, max_tokens):
                yield token
        elif self.provider == "gemini":
            async for token in self._stream_gemini(system, messages, max_tokens):
                yield token
        else:
            raise ValueError(f"Unknown LLM provider for streaming: {self.provider!r}")

    async def _stream_anthropic(
        self, system: str, messages: list[dict], max_tokens: int
    ) -> AsyncIterator[str]:
        try:
            import anthropic
        except ImportError:
            raise ImportError("anthropic is required for streaming. Run: pip install anthropic")

        client = anthropic.AsyncAnthropic(api_key=self.api_key)
        async with client.messages.stream(
            model=self.model,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
        ) as stream:
            async for text in stream.text_stream:
                yield text

    async def _stream_openai(
        self, system: str, messages: list[dict], max_tokens: int
    ) -> AsyncIterator[str]:
        try:
            from openai import AsyncOpenAI
        except ImportError:
            raise ImportError("openai is required for streaming. Run: pip install openai")

        client = AsyncOpenAI(api_key=self.api_key)
        full_messages = [{"role": "system", "content": system}] + messages
        stream = await client.chat.completions.create(
            model=self.model,
            messages=full_messages,
            max_tokens=max_tokens,
            stream=True,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta

    async def _stream_gemini(
        self, system: str, messages: list[dict], max_tokens: int
    ) -> AsyncIterator[str]:
        try:
            from google import genai
            from google.genai import types
        except ImportError:
            raise ImportError("google-genai is required for streaming. Run: pip install google-genai")

        client = genai.Client(api_key=self.api_key)
        # Convert messages list to Gemini contents format
        contents = [
            {"role": "user" if m["role"] == "user" else "model", "parts": [{"text": m["content"]}]}
            for m in messages
        ]
        async for chunk in await client.aio.models.generate_content_stream(
            model=self.model,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system,
                max_output_tokens=max_tokens,
            ),
        ):
            if chunk.text:
                yield chunk.text
