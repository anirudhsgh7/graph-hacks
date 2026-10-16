"""Minimal OpenAI-compatible chat client with a provider fallback chain.

No SDK and no framework: plain HTTP so every request the agent makes is visible here.

Providers, in order (both optional; with neither, the rule-based investigator runs):
  primary   LLM_BASE_URL / LLM_API_KEY / LLM_MODEL             (default: Groq)
  fallback  LLM_FALLBACK_BASE_URL / LLM_FALLBACK_API_KEY / LLM_FALLBACK_MODEL
            (default: Gemini's OpenAI-compatible endpoint; GEMINI_API_KEY also works)

A ChatSession is created per investigation and is sticky: once a provider fails
(rate limit with no short retry-after, outage, auth error) the rest of that investigation
uses the next one. Message history is portable between providers because tool-call ids
are normalised here.
"""
from __future__ import annotations

import json
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.config import settings


class LLMError(Exception):
    code = "LLM_UNAVAILABLE"


class LLMRateLimited(LLMError):
    code = "LLM_RATE_LIMITED"

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


@dataclass
class Provider:
    name: str
    base_url: str
    api_key: str
    model: str
    reasoning_effort: str | None = None


def providers() -> list[Provider]:
    out: list[Provider] = []
    if settings.llm_api_key:
        out.append(Provider(_label(settings.llm_base_url), settings.llm_base_url, settings.llm_api_key,
                            settings.llm_model, settings.llm_reasoning_effort))
    if settings.llm_fallback_api_key:
        out.append(Provider(_label(settings.llm_fallback_base_url), settings.llm_fallback_base_url,
                            settings.llm_fallback_api_key, settings.llm_fallback_model,
                            settings.llm_fallback_reasoning_effort))
    return out


def _label(url: str) -> str:
    host = re.sub(r"^https?://", "", url).split("/")[0]
    for known in ("groq", "googleapis", "openai", "anthropic", "openrouter", "localhost", "127.0.0.1"):
        if known in host:
            return {"googleapis": "gemini", "127.0.0.1": "local"}.get(known, known)
    return host


_RETRY_IN = re.compile(r"try again in\s+(?:(\d+)m)?\s*([\d.]+)\s*(ms|s)", re.IGNORECASE)


def _retry_after(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    if raw:
        try:
            return float(raw)
        except ValueError:
            pass
    m = _RETRY_IN.search(resp.text or "")  # Groq: "Please try again in 7.66s" / "1m2.5s" / "450ms"
    if m:
        minutes = float(m.group(1) or 0)
        value = float(m.group(2))
        return minutes * 60 + (value / 1000 if m.group(3).lower() == "ms" else value)
    return None


def _normalise(message: dict) -> dict:
    """Make the assistant message safe to replay to any provider: every tool call gets an
    id and string arguments (some OpenAI-compatible endpoints omit ids or send objects)."""
    calls = []
    for c in message.get("tool_calls") or []:
        fn = c.get("function") or {}
        args = fn.get("arguments")
        if not isinstance(args, str):
            args = json.dumps(args or {})
        calls.append({"id": c.get("id") or f"call_{uuid.uuid4().hex[:12]}", "type": "function",
                      "function": {"name": fn.get("name", ""), "arguments": args or "{}"}})
    out = {"role": "assistant", "content": message.get("content") or ""}
    if calls:
        out["tool_calls"] = calls
    return out


def _post(p: Provider, messages: list[dict], tools: list[dict] | None, timeout_s: float) -> dict:
    body: dict[str, Any] = {"model": p.model, "messages": messages, "temperature": 0.1}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    if p.reasoning_effort:
        body["reasoning_effort"] = p.reasoning_effort
    try:
        resp = httpx.post(f"{p.base_url.rstrip('/')}/chat/completions",
                          headers={"Authorization": f"Bearer {p.api_key}"}, json=body, timeout=timeout_s)
    except httpx.HTTPError as exc:
        raise LLMError(f"{p.name}: request failed ({exc.__class__.__name__})") from exc
    if resp.status_code == 429:
        raise LLMRateLimited(f"{p.name}: rate limit reached", _retry_after(resp))
    if resp.status_code == 400 and p.reasoning_effort and "reasoning" in resp.text.lower():
        p.reasoning_effort = None  # this model does not take the parameter: drop it and retry once
        return _post(p, messages, tools, timeout_s)
    if resp.status_code >= 400:
        raise LLMError(f"{p.name}: HTTP {resp.status_code}: {resp.text[:200]}")
    try:
        return _normalise(resp.json()["choices"][0]["message"])
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise LLMError(f"{p.name}: unexpected response shape") from exc


@dataclass
class ChatSession:
    """One investigation's view of the providers (sticky fallback, bounded waiting)."""
    deadline: float
    notes: list[str] = field(default_factory=list)
    _chain: list[Provider] = field(default_factory=providers)
    _i: int = 0
    requests: int = 0

    @property
    def enabled(self) -> bool:
        return bool(self._chain)

    @property
    def model(self) -> str | None:
        return self._chain[self._i].model if self._i < len(self._chain) else None

    def chat(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        last: LLMError | None = None
        waited = False
        while self._i < len(self._chain):
            p = self._chain[self._i]
            remaining = self.deadline - time.time()
            if remaining <= 1:
                raise LLMError("time budget exhausted while waiting for the model")
            try:
                self.requests += 1
                return _post(p, messages, tools, min(settings.llm_timeout_s, remaining))
            except LLMRateLimited as exc:
                last = exc
                wait = exc.retry_after
                if (not waited and wait is not None and wait <= settings.llm_max_wait_s
                        and wait < self.deadline - time.time() - 2):
                    self.notes.append(f"{p.name} rate-limited; waited {wait:.1f}s as it asked")
                    time.sleep(wait)
                    waited = True
                    continue
            except LLMError as exc:
                last = exc
            # this provider is out for the rest of the investigation
            self._i += 1
            waited = False
            if self._i < len(self._chain):
                nxt = self._chain[self._i]
                self.notes.append(f"{last}; switched to {nxt.name} ({nxt.model})")
        raise last or LLMError("no LLM provider configured")
