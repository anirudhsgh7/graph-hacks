"""Minimal OpenAI-compatible chat client (Groq by default; any compatible endpoint works).

Kept to one function on purpose: no SDK, no framework, nothing hidden between our
agent loop and the HTTP call. Switch providers with LLM_BASE_URL / LLM_MODEL.
"""
from __future__ import annotations

from typing import Any

import httpx

from app.config import settings


class LLMError(Exception):
    code = "LLM_UNAVAILABLE"


class LLMRateLimited(LLMError):
    code = "LLM_RATE_LIMITED"


def chat(messages: list[dict], tools: list[dict] | None = None, tool_choice: str = "auto",
         timeout_s: float | None = None) -> dict:
    """One chat-completion call. Returns the assistant message dict."""
    if not settings.llm_api_key:
        raise LLMError("no LLM_API_KEY configured")
    body: dict[str, Any] = {"model": settings.llm_model, "messages": messages, "temperature": 0.1}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = tool_choice
    try:
        resp = httpx.post(
            f"{settings.llm_base_url.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {settings.llm_api_key}"},
            json=body, timeout=timeout_s or settings.llm_timeout_s,
        )
    except httpx.HTTPError as exc:
        raise LLMError(f"LLM request failed: {exc.__class__.__name__}") from exc
    if resp.status_code == 429:
        raise LLMRateLimited("LLM provider rate limit reached")
    if resp.status_code >= 400:
        raise LLMError(f"LLM provider returned HTTP {resp.status_code}: {resp.text[:300]}")
    try:
        return resp.json()["choices"][0]["message"]
    except (KeyError, IndexError, ValueError) as exc:
        raise LLMError("LLM provider returned an unexpected response") from exc
