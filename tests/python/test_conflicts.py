"""Independent feasibility verification of genuinely solved conflict subsets."""
import json
import subprocess
import sys
import pytest
from scipy.optimize import linprog


def run(payload):
    result = subprocess.run([sys.executable, 'scripts/optimize.py'], input=json.dumps(payload), text=True, capture_output=True, timeout=20, check=True)
    return json.loads(result.stdout)


def subset_model(payload, members):
    rows, rhs = [], []
    for m in members:
        sign = -1 if m['side'] == 'min' else 1
        if m['kind'] == 'bound':
            row = [0.] * len(payload['cost']); row[m['index']] = 1.
            value = payload['bounds'][m['index']][0 if m['side'] == 'min' else 1]
        else:
            c = payload['constraints'][m['index']]; row, value = c['values'], c[m['side']]
        rows.append([sign * v for v in row]); rhs.append(sign * value)
    return linprog([0.] * len(payload['cost']), A_ub=rows or None, b_ub=rhs or None,
                   A_eq=[[1.] * len(payload['cost'])], b_eq=[1.], bounds=[(0., 1.)] * len(payload['cost']), method='highs')


@pytest.mark.parametrize('payload', [
    {'cost': [100, 300], 'bounds': [[0, 1], [0, .1]], 'constraints': [{'values': [10, 50], 'min': 20}]},
    {'cost': [100, 300], 'bounds': [[0, 1], [0, 1]], 'constraints': [{'values': [1000, 3000], 'min': 2500}, {'values': [30, 10], 'min': 25}]},
    {'cost': [100, 300], 'bounds': [[0, 1], [0, 1]], 'constraints': [{'values': [100, 0], 'max': 40}, {'values': [0, 100], 'max': 40}]},
    {'cost': [100, 300], 'bounds': [[.6, .1], [0, 1]], 'constraints': [{'values': [10, 50], 'min': 20}]},
    {'cost': [100, 300], 'bounds': [[.6, 1], [.6, 1]], 'constraints': []},
])
def test_verified_subsets_are_infeasible_and_every_single_removal_is_feasible(payload):
    original = json.loads(json.dumps(payload))
    result = run({**payload, 'explain': True})
    assert result['status'] == 'infeasible' and result['fractions'] is None and result['objective'] is None
    c = result['conflict']
    assert c['status'] == 'irreducible' and c['termination'] == 'complete'
    assert 1 <= c['checks'] <= 48 and c['tolerance'] == 1e-7
    members = c['members']
    assert members and subset_model(payload, members).status == 2
    for index in range(len(members)):
        assert subset_model(payload, members[:index] + members[index + 1:]).success
    assert payload == original


def test_redundant_constraints_are_excluded_and_no_removed_row_solution_escapes():
    payload = {'cost': [100, 300], 'bounds': [[0, 1], [0, .1]],
               'constraints': [{'values': [10, 50], 'min': 20}, {'values': [3000, 3000], 'min': 2000}, {'values': [1, 1], 'min': 0}]}
    result = run({**payload, 'explain': True})
    assert result['conflict']['members'] == [{'kind': 'bound', 'index': 1, 'side': 'max'}, {'kind': 'row', 'index': 0, 'side': 'min'}]
    assert not any(key in result['conflict'] for key in ['fractions', 'solution', 'objective'])


def test_budget_exhaustion_retains_a_proven_conflict_without_claiming_irreducibility():
    payload = {'cost': [100] * 100, 'bounds': [[0, .005]] * 100, 'constraints': [], 'explain': True}
    result = run(payload)
    c = result['conflict']
    assert result['status'] == 'infeasible' and result['fractions'] is None
    assert c['status'] == 'partial' and c['termination'] == 'check-budget' and c['checks'] == 48
    assert len(c['members']) == 100 and subset_model(payload, c['members']).status == 2


def test_original_optimum_and_legacy_response_shape_are_unchanged():
    payload = {'cost': [100, 300], 'bounds': [[0, 1], [0, 1]], 'constraints': [{'values': [10, 50], 'min': 20}]}
    old, explained = run(payload), run({**payload, 'explain': True})
    assert 'conflict' not in old and explained.pop('conflict') is None
    assert explained == old and old['objective'] == pytest.approx(150)


@pytest.mark.parametrize('flag', ['yes', 1, None, {'relax': True}])
def test_diagnostic_flag_requires_a_boolean(flag):
    result = subprocess.run([sys.executable, 'scripts/optimize.py'], input=json.dumps({'cost': [100], 'bounds': [[0, 1]], 'constraints': [], 'explain': flag}), text=True, capture_output=True, timeout=20)
    assert result.returncode != 0 and not result.stdout


def test_expired_diagnostic_budget_does_not_manufacture_a_verified_subset():
    script = """
import json, runpy, time
f = runpy.run_path('scripts/optimize.py')['explain_conflict']
r = f([100, 300], [[0, 1], [0, .1]], [{'values': [10, 50], 'min': 20}], time.monotonic() - 1)
print(json.dumps(r))
"""
    result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, check=True, timeout=20)
    c = json.loads(result.stdout)
    assert c['status'] == 'unavailable' and c['termination'] == 'time-budget' and c['checks'] == 0 and c['members'] == []


def test_numerically_invalid_feasibility_witness_cannot_certify_irreducibility():
    # Simulate a solver reporting success with an invalid primal vector.
    script = """
import json, runpy, time
from types import SimpleNamespace
f = runpy.run_path('scripts/optimize.py')['explain_conflict']
calls = 0
def oracle(*args, **kwargs):
    global calls
    calls += 1
    return SimpleNamespace(status=2, x=None) if calls == 1 else SimpleNamespace(status=0, x=[2., -1.])
f.__globals__['linprog'] = oracle
r = f([100, 300], [[0, 1], [0, .1]], [{'values': [10, 50], 'min': 20}], time.monotonic() + 8)
print(json.dumps(r))
"""
    result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, check=True, timeout=20)
    c = json.loads(result.stdout)
    assert c['status'] == 'partial' and c['termination'] == 'numerical-uncertainty' and c['checks'] == 2
    assert 'fractions' not in c and 'solution' not in c
