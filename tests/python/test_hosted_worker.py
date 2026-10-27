"""Exercise the hosted HTTP entry point with real isolated worker subprocesses."""
import importlib.util
import io
import json
import shutil
import threading
import http.client
from http.server import ThreadingHTTPServer
from pathlib import Path
import pytest
from openpyxl import load_workbook

SECRET = "test-only-hosted-worker-secret-00000000000000"

@pytest.fixture
def service(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("hosted_worker", "deployment/python-worker/api/worker.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    worker_dir = tmp_path / "workers"; worker_dir.mkdir()
    for name in ["optimize.py", "inspect_upload.py", "export_recipe.py"]:
        shutil.copyfile(Path("scripts") / name, worker_dir / name)
    module.ROOT = tmp_path
    monkeypatch.setenv("FARM_WORKER_SECRET", SECRET)
    server = ThreadingHTTPServer(("127.0.0.1", 0), module.handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    yield server.server_address[1]
    server.shutdown(); server.server_close(); thread.join()

def request(port, operation, body=b"", secret=SECRET, length=None, method="POST"):
    client = http.client.HTTPConnection("127.0.0.1", port, timeout=25)
    headers = {"Authorization": "Bearer " + secret, "Content-Length": str(len(body) if length is None else length)}
    client.request(method, "/api/worker?operation=" + operation, body=body, headers=headers)
    response = client.getresponse(); data = response.read(); status = response.status
    client.close(); return status, data

def test_hosted_solver_runs_real_highs_and_keeps_full_constraints(service):
    payload = {"cost": [100, 300], "bounds": [[0, 1], [0, 1]], "constraints": [{"values": [10, 50], "min": 20}]}
    status, data = request(service, "optimize", json.dumps(payload).encode())
    assert status == 200
    result = json.loads(data)
    assert result["status"] == "optimal" and result["objective"] == pytest.approx(150)
    assert result["fractions"][0] == pytest.approx(0.75)

def test_hosted_inspection_retains_the_original_workbook_protocol(service):
    status, data = request(service, "inspect", Path("data/source/Feed Formula Calculator.xlsx").read_bytes())
    assert status == 200
    assert "Nutritional Intake" in [s["name"] for s in json.loads(data)["sheets"]]
    status, data = request(service, "inspect", b"bad workbook")
    assert status == 422 and "workbook" in json.loads(data)["error"].lower()

def test_hosted_export_preserves_formula_like_names_as_text(service):
    payload = {"sheets": [{"name": "Mixing sheet", "headerRows": [1], "rows": [["Name", "kg"], ["=SUM(1,1)", 75]]}]}
    status, data = request(service, "export", json.dumps(payload).encode())
    assert status == 200
    workbook = load_workbook(io.BytesIO(data), data_only=False)
    assert workbook.active["A2"].data_type == "s"
    assert workbook.active["B2"].value == 75

def test_hosted_endpoint_rejects_unauthorized_unknown_and_oversized_work(service, monkeypatch):
    assert request(service, "optimize", secret="wrong")[0] == 401
    assert request(service, "arbitrary-script")[0] == 400
    assert request(service, "optimize", length=256 * 1024 + 1)[0] == 413
    assert request(service, "optimize", method="GET")[0] == 405
    monkeypatch.delenv("FARM_WORKER_SECRET")
    assert request(service, "optimize")[0] == 503
