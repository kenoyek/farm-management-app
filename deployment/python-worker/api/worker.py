"""Vercel Python function. Bearer-authenticated, bounded, fixed worker commands."""
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import hmac
import json
import os
import subprocess
import sys
import threading

ROOT = Path(__file__).resolve().parents[1]
MIB = 1024 * 1024
JOBS = {
    "optimize": ("optimize.py", 256 * 1024, 256 * 1024, 20, "application/json"),
    "inspect": ("inspect_upload.py", 2 * MIB, 4 * MIB, 15, "application/json"),
    "export": ("export_recipe.py", 2 * MIB, 2 * MIB, 15, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
}
CAPACITY = threading.BoundedSemaphore(2)


class handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # Never log authorization, workbook content or credentials.

    def reply(self, status, body, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def error_reply(self, status, message):
        self.reply(status, json.dumps({"error": message}).encode())

    def do_GET(self):
        self.error_reply(405, "Use authenticated POST requests.")

    def do_POST(self):
        expected = os.environ.get("FARM_WORKER_SECRET", "")
        if len(expected) < 32:
            self.error_reply(503, "Worker authentication is not configured."); return
        provided = self.headers.get("Authorization", "")
        if len(provided) > 1024 or not hmac.compare_digest(provided.encode(), ("Bearer " + expected).encode()):
            self.error_reply(401, "Worker authentication required."); return
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query, keep_blank_values=True)
        if parsed.path != "/api/worker" or set(query) != {"operation"} or len(query["operation"]) != 1 or query["operation"][0] not in JOBS:
            self.error_reply(400, "Unknown worker operation."); return
        operation = query["operation"][0]
        script, input_limit, output_limit, timeout, content_type = JOBS[operation]
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0 or length > input_limit:
            self.error_reply(413, "Worker request exceeds limits."); return
        if not CAPACITY.acquire(blocking=False):
            self.error_reply(429, "Worker is busy."); return
        try:
            body = self.rfile.read(length)
            if len(body) != length:
                self.error_reply(400, "Incomplete worker request."); return
            env = {**os.environ, "PYTHONPATH": os.pathsep.join(sys.path), "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1", "OPENPYXL_DEFUSEDXML": "True", "OPENPYXL_LXML": "False"}
            result = subprocess.run([sys.executable, str(ROOT / "workers" / script)], input=body, capture_output=True, timeout=timeout, cwd=ROOT, env=env)
            if len(result.stdout) > output_limit:
                self.error_reply(422, "Worker output exceeds limits."); return
            if result.returncode:
                if operation == "inspect":
                    try:
                        error = json.loads(result.stdout)
                        if isinstance(error, dict) and isinstance(error.get("error"), str) and len(error["error"]) <= 400:
                            self.reply(422, json.dumps({"error": error["error"]}).encode()); return
                    except (ValueError, UnicodeError):
                        pass
                self.error_reply(503, "Worker failed or exceeded its resource limits."); return
            self.reply(200, result.stdout, content_type)
        except (OSError, subprocess.TimeoutExpired):
            self.error_reply(503, "Worker is unavailable or timed out.")
        finally:
            CAPACITY.release()
