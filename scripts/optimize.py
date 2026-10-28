"""Bounded HiGHS worker. The original solve retains every hard constraint."""
import json
import math
import os
import resource
import sys
import time

resource.setrlimit(resource.RLIMIT_CPU, (10, 11))
resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['OMP_NUM_THREADS'] = '1'
import scipy
from scipy.optimize import linprog


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


# Diagnostic submodels never supply an allocation to the original result.
# Mass balance and 0..1 variable bounds stay fixed throughout the search.
MAX_CHECKS = 48
TOLERANCE = 1e-7


def feasible_witness(values, rows, rhs):
    return (values is not None and all(math.isfinite(float(v)) for v in values)
            and abs(sum(values) - 1) <= TOLERANCE
            and all(-TOLERANCE <= v <= 1 + TOLERANCE for v in values)
            and all(sum(a * x for a, x in zip(row, values)) <= limit + TOLERANCE
                    for row, limit in zip(rows, rhs)))


def explain_conflict(costs, bounds, constraints, deadline):
    candidates = []
    for index, (lo, hi) in enumerate(bounds):
        for side, value in [('min', lo), ('max', hi)]:
            if side == 'min' and value == 0 or side == 'max' and value == 1:
                continue
            row = [0.] * len(costs)
            row[index] = -1. if side == 'min' else 1.
            candidates.append(({'kind': 'bound', 'index': index, 'side': side},
                               row, -value if side == 'min' else value))
    for index, constraint in enumerate(constraints):
        for side in ['min', 'max']:
            if side not in constraint:
                continue
            value, values = constraint[side], constraint['values']
            # These limits are implied by nonnegative fractions summing to 1.
            # They remain in the original solve; only diagnostic candidates omit them.
            if side == 'min' and value <= min(values) or side == 'max' and value >= max(values):
                continue
            candidates.append(({'kind': 'row', 'index': index, 'side': side},
                               [-v for v in values] if side == 'min' else values,
                               -value if side == 'min' else value))
    active, witnesses, checks = list(range(len(candidates))), {}, 0

    def reply(status, termination):
        return {'version': 1, 'status': status, 'termination': termination,
                'members': [candidates[i][0] for i in active] if status != 'unavailable' else [],
                'checks': checks, 'maxChecks': MAX_CHECKS, 'candidateCount': len(candidates),
                'tolerance': TOLERANCE}

    def trial(indices):
        nonlocal checks
        remaining = deadline - time.monotonic()
        if checks >= MAX_CHECKS:
            return None, 'check-budget'
        if remaining <= 0.002:
            return None, 'time-budget'
        checks += 1
        rows, rhs = [candidates[i][1] for i in indices], [candidates[i][2] for i in indices]
        result = linprog([0.] * len(costs), A_ub=rows or None, b_ub=rhs or None,
                         A_eq=[[1.] * len(costs)], b_eq=[1.], bounds=[(0., 1.)] * len(costs),
                         method='highs', options={'time_limit': min(0.5, remaining)})
        if result.status == 2:
            return ('infeasible', None), None
        if result.status == 0 and feasible_witness(result.x, rows, rhs):
            return ('feasible', result.x), None
        return None, 'time-budget' if result.status == 1 else 'numerical-uncertainty'

    confirmed, reason = trial(active)
    if confirmed is None or confirmed[0] != 'infeasible':
        return reply('unavailable', reason or 'numerical-uncertainty')
    for index in list(active):
        subset = [i for i in active if i != index]
        outcome, reason = trial(subset)
        if outcome is None:
            return reply('partial', reason)
        if outcome[0] == 'infeasible':
            active = subset
        else:
            witnesses[index] = outcome[1]
    # Earlier removal witnesses also satisfy every subsequently reduced subset.
    for index in active:
        subset = [i for i in active if i != index]
        if not feasible_witness(witnesses.get(index), [candidates[i][1] for i in subset],
                                [candidates[i][2] for i in subset]):
            return reply('partial', 'numerical-uncertainty')
    return reply('irreducible', 'complete')


def solve(payload):
    if (not isinstance(payload, dict) or set(payload) - {'cost', 'constraints', 'bounds', 'explain'}
            or not {'cost', 'constraints', 'bounds'} <= set(payload)
            or 'explain' in payload and type(payload['explain']) is not bool):
        raise ValueError('Invalid optimizer request')
    explain = payload.get('explain', False)
    costs, bounds, constraints = payload['cost'], payload['bounds'], payload['constraints']
    if not isinstance(costs, list) or not 1 <= len(costs) <= 100 or any(not number(c) or c <= 0 for c in costs):
        raise ValueError('Invalid costs')
    if not isinstance(bounds, list) or len(bounds) != len(costs):
        raise ValueError('Invalid bounds')
    for bound in bounds:
        if (not isinstance(bound, list) or len(bound) != 2 or any(not number(v) or not 0 <= v <= 1 for v in bound)
                or not explain and bound[0] > bound[1]):
            raise ValueError('Invalid bounds')
    if not isinstance(constraints, list) or len(constraints) > 31:
        raise ValueError('Invalid nutrient constraints')
    rows, rhs = [], []
    for c in constraints:
        if not isinstance(c, dict) or set(c) - {'values', 'min', 'max'} or 'values' not in c or not {'min', 'max'} & set(c):
            raise ValueError('Invalid nutrient constraint')
        if not isinstance(c['values'], list) or len(c['values']) != len(costs) or any(not number(v) or v < 0 for v in c['values']):
            raise ValueError('Invalid nutrient values')
        if any(not number(c[k]) or c[k] < 0 for k in ('min', 'max') if k in c) or c.get('min', 0) > c.get('max', math.inf):
            raise ValueError('Invalid nutrient range')
        if 'max' in c:
            rows.append(c['values']); rhs.append(c['max'])
        if 'min' in c:
            rows.append([-v for v in c['values']]); rhs.append(-c['min'])
    started = time.monotonic()
    original_bounds = bounds
    if any(lo > hi for lo, hi in bounds):
        # Equivalent inequalities expose contradictory effective bounds to HiGHS.
        for index, (lo, hi) in enumerate(bounds):
            unit = [0.] * len(costs); unit[index] = 1.
            rows.extend([unit, [-v for v in unit]]); rhs.extend([hi, -lo])
        original_bounds = [(0., 1.)] * len(costs)
    result = linprog(costs, A_ub=rows or None, b_ub=rhs or None,
                     A_eq=[[1] * len(costs)], b_eq=[1], bounds=original_bounds,
                     method='highs', options={'time_limit': 8})
    status = {0: 'optimal', 1: 'limit', 2: 'infeasible', 3: 'unbounded', 4: 'solver-error'}.get(result.status, 'solver-error')
    response = {'status': status, 'fractions': result.x.tolist() if result.success else None,
                'objective': float(result.fun) if result.success else None,
                'message': str(result.message), 'solver': f'scipy-{scipy.__version__}/HiGHS'}
    if explain:
        response['conflict'] = explain_conflict(costs, bounds, constraints, started + 8) if status == 'infeasible' else None
    return response


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(256 * 1024 + 1)
        if len(raw) > 256 * 1024:
            raise ValueError('Request too large')
        payload = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite input')))
        print(json.dumps(solve(payload), allow_nan=False))
    except Exception:
        print('Optimization input or service failed.', file=sys.stderr)
        sys.exit(1)
