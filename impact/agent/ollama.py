"""Local model client. Refuses any non-loopback endpoint, so code never leaves the machine."""
from __future__ import annotations

import ipaddress
import json
import urllib.request
from urllib.parse import urlparse

DEFAULT_MODEL = "qwen3.5:9b"


def require_loopback(url: str) -> None:
    host = urlparse(url).hostname or ""
    try:
        ok = host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        ok = False
    if not ok:
        raise ValueError(f"LLM endpoint must be loopback, got: {url}")


class OllamaClient:
    def __init__(self, model: str = DEFAULT_MODEL, url: str = "http://127.0.0.1:11434",
                 num_ctx: int = 16384, timeout_s: int = 300):
        require_loopback(url)
        self.model, self.url, self.num_ctx, self.timeout_s = model, url, num_ctx, timeout_s

    def complete(self, prompt: str, temperature: float = 0.0) -> str:
        body = {"model": self.model, "prompt": prompt, "stream": False, "think": False, "keep_alive": "30m",
                "options": {"temperature": temperature, "num_ctx": self.num_ctx, "num_predict": 1500}}
        req = urllib.request.Request(f"{self.url}/api/generate", json.dumps(body).encode(),
                                     {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
            return json.load(resp).get("response", "")
