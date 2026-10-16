"""A scripted OpenAI-compatible endpoint for testing the agent loop offline.

Each test sets SCRIPT to a list of replies; the server returns them in order and
records every request body in REQUESTS so tests can assert what the agent sent.
A second provider lives under /alt/v1 with its own SCRIPT_ALT / REQUESTS_ALT.
A scripted item may be {"status": 429, "headers": {...}, "text": "..."} to fail.
"""
from __future__ import annotations

import json
import threading
import time

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI()
SCRIPT: list[dict] = []
REQUESTS: list[dict] = []
SCRIPT_ALT: list[dict] = []
REQUESTS_ALT: list[dict] = []


def tool_call(call_id: str, name: str, args: dict) -> dict:
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def reply_tools(*calls: dict) -> dict:
    return {"role": "assistant", "content": None, "tool_calls": list(calls)}


def reply_text(text: str) -> dict:
    return {"role": "assistant", "content": text}


def _answer(script: list[dict], log: list[dict], body: dict):
    log.append(body)
    if not script:
        return JSONResponse({"error": "script exhausted"}, status_code=500)
    item = script.pop(0)
    if "status" in item:
        return JSONResponse({"error": item.get("text", "scripted failure")}, status_code=item["status"],
                            headers=item.get("headers"))
    return {"choices": [{"index": 0, "message": item, "finish_reason": "stop"}]}


@app.post("/v1/chat/completions")
async def completions(request: Request):
    return _answer(SCRIPT, REQUESTS, await request.json())


@app.post("/alt/v1/chat/completions")
async def completions_alt(request: Request):
    return _answer(SCRIPT_ALT, REQUESTS_ALT, await request.json())


def serve(port: int) -> uvicorn.Server:
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    return server
