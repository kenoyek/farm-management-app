"""Exercise the Python worker's stdin boundary separately from the TypeScript API."""
import json
import subprocess
import sys
import pytest

@pytest.mark.parametrize('payload', [[], {'cost': [float('nan')], 'constraints': [], 'bounds': [[0, 1]]}])
def test_malformed_or_nonfinite_input_never_returns_an_optimum(payload):
    run = subprocess.run([sys.executable, 'scripts/optimize.py'], input=json.dumps(payload), text=True, capture_output=True, timeout=20)
    assert run.returncode != 0
    assert not run.stdout.strip()

def test_worker_reports_solver_version_and_real_status():
    payload = {'cost': [1], 'constraints': [{'values': [10], 'min': 20}], 'bounds': [[0, 1]]}
    run = subprocess.run([sys.executable, 'scripts/optimize.py'], input=json.dumps(payload), text=True, capture_output=True, timeout=20, check=True)
    result = json.loads(run.stdout)
    assert result['status'] == 'infeasible'
    assert result['fractions'] is None
    assert 'HiGHS' in result['solver']
