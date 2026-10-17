"""Check the model's prose against the graph before anyone reads it.

Findings are already gated on evidence ids (loop._validated_findings). The summary is
free text, so it gets a claim check instead: every account id it names and every dollar
amount it states must appear in what the tools returned (or in the case context the
model was given). One unsupported claim and the summary is replaced by the
deterministic one built from the same evidence - the model never gets the last word on
a fact the graph did not produce.
"""
from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any

ACCOUNT = re.compile(r"\b([ACHMX]\d{1,3})\b")
ACCOUNT_ID = re.compile(r"^[ACHMX]\d{1,3}$")
# $30,100  $30100.50  $30.1K  $1.2 million
MONEY = re.compile(r"\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|m|thousand|million)?\b", re.IGNORECASE)
_SCALE = {"k": 1e3, "thousand": 1e3, "m": 1e6, "million": 1e6}


def _walk(obj: Any) -> Iterable[Any]:
    if isinstance(obj, dict):
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, (list, tuple, set)):
        for v in obj:
            yield from _walk(v)
    else:
        yield obj


def graph_facts(evidence: Iterable[Any]) -> tuple[set[str], list[float]]:
    """Account ids and numbers that the tools actually returned."""
    accounts: set[str] = set()
    numbers: list[float] = []
    for e in evidence:
        d = e.to_dict() if hasattr(e, "to_dict") else e
        for v in _walk([d.get("node_ids"), d.get("result_excerpt")]):
            if isinstance(v, bool):
                continue
            if isinstance(v, (int, float)):
                numbers.append(float(v))
            elif isinstance(v, str):
                if ACCOUNT_ID.match(v):
                    accounts.add(v)
                else:
                    accounts.update(ACCOUNT.findall(v))
    return accounts, numbers


def _amounts(text: str) -> list[tuple[str, float, float]]:
    """(as written, value, tolerance) for every dollar amount; tolerance follows the
    precision the sentence used ("$30.1K" is anything from 30,050 to 30,150)."""
    out = []
    for m in MONEY.finditer(text):
        digits, unit = m.group(1).replace(",", ""), (m.group(2) or "").lower()
        scale = _SCALE.get(unit, 1.0)
        decimals = len(digits.split(".")[1]) if "." in digits else 0
        tol = max(0.51, 0.5 * (10 ** -decimals) * scale)
        out.append((m.group(0).strip(), float(digits) * scale, tol))
    return out


def check(text: str, evidence: Iterable[Any], context_accounts: Iterable[str] = ()) -> list[str]:
    """Claims in `text` that the evidence does not support (empty list = all supported)."""
    accounts, numbers = graph_facts(list(evidence))
    accounts |= set(context_accounts)
    problems = []
    for acc in dict.fromkeys(ACCOUNT.findall(text)):
        if acc not in accounts:
            problems.append(f"{acc} does not appear in any graph result")
    for written, value, tol in _amounts(text):
        if not any(abs(n - value) <= tol for n in numbers):
            problems.append(f"{written} does not match any amount the graph returned")
    return problems
