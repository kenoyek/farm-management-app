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

@pytest.mark.parametrize('payload', [
    {'cost': [True], 'constraints': [], 'bounds': [[0, 1]]},
    {'cost': [1], 'constraints': [], 'bounds': [[-1, 1]]},
    {'cost': [1], 'constraints': [], 'bounds': [[0.8, 0.2]]},
    {'cost': [1], 'constraints': [{'values': [10, 20], 'min': 5}], 'bounds': [[0, 1]]},
    {'cost': [1], 'constraints': [{'values': [10], 'min': 20, 'max': 10}], 'bounds': [[0, 1]]},
    {'cost': [1] * 101, 'constraints': [], 'bounds': [[0, 1]] * 101},
    {'cost': [1], 'constraints': [], 'bounds': [[0, 1]], 'relax': True},
])
def test_strict_worker_dimensions_bounds_and_numbers(payload):
    run = subprocess.run([sys.executable, 'scripts/optimize.py'], input=json.dumps(payload), text=True, capture_output=True, timeout=20)
    assert run.returncode != 0
    assert not run.stdout

def test_worker_handles_one_hundred_candidates_with_a_real_objective():
    payload = {'cost': list(range(1, 101)), 'constraints': [{'values': [20] * 100, 'min': 20}], 'bounds': [[0, 1]] * 100}
    run = subprocess.run([sys.executable, 'scripts/optimize.py'], input=json.dumps(payload), text=True, capture_output=True, timeout=20, check=True)
    result = json.loads(run.stdout)
    assert result['status'] == 'optimal'
    assert result['objective'] == pytest.approx(1)
    assert result['fractions'][0] == pytest.approx(1)

def test_worker_enforces_eleven_nutrient_rows_and_rejects_an_unbounded_registry():
    constraints = [{'values': [20, 20], 'min': 10}] * 10 + [{'values': [2, 10], 'min': 4}]
    payload = {'cost': [100, 300], 'bounds': [[0, 1], [0, 1]], 'constraints': constraints}
    run = subprocess.run([sys.executable, 'scripts/optimize.py'], input=json.dumps(payload), text=True, capture_output=True, timeout=20, check=True)
    result = json.loads(run.stdout)
    assert result['status'] == 'optimal' and result['objective'] == pytest.approx(150)
    payload['constraints'].append({'values': [0, 0], 'max': 0})
    run = subprocess.run([sys.executable, 'scripts/optimize.py'], input=json.dumps(payload), text=True, capture_output=True, timeout=20)
    assert run.returncode != 0 and not run.stdout
