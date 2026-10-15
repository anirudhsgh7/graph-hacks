"""A scripted OpenAI-compatible endpoint for testing the agent loop offline.

Each test sets SCRIPT to a list of replies; the server returns them in order and
records every request body in REQUESTS so tests can assert what the agent sent.
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


def tool_call(call_id: str, name: str, args: dict) -> dict:
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def reply_tools(*calls: dict) -> dict:
    return {"role": "assistant", "content": None, "tool_calls": list(calls)}


def reply_text(text: str) -> dict:
    return {"role": "assistant", "content": text}


@app.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    REQUESTS.append(body)
    if not SCRIPT:
        return JSONResponse({"error": "script exhausted"}, status_code=500)
    item = SCRIPT.pop(0)
    if "status" in item:
        return JSONResponse({"error": "scripted failure"}, status_code=item["status"])
    return {"choices": [{"index": 0, "message": item, "finish_reason": "stop"}]}


def serve(port: int) -> uvicorn.Server:
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    return server
