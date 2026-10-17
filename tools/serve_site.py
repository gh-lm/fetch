#!/usr/bin/env python3
"""Serves site/ for a local look, with the extensionless page addresses that
Cloudflare Pages gives (/privacy for privacy.html).  Port 8321."""
import http.server
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def translate_path(self, path):
        real = super().translate_path(path)
        if not os.path.exists(real) and os.path.exists(real + ".html"):
            return real + ".html"
        return real


http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8321), Handler).serve_forever()
