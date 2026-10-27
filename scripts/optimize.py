"""Bounded HiGHS worker. Hard constraints are never removed or relaxed."""
import json
import math
import os
import resource
import sys

resource.setrlimit(resource.RLIMIT_CPU, (10, 11))
resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['OMP_NUM_THREADS'] = '1'
import scipy
from scipy.optimize import linprog


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def solve(payload):
    if not isinstance(payload, dict) or set(payload) != {'cost', 'constraints', 'bounds'}:
        raise ValueError('Invalid optimizer request')
    costs, bounds, constraints = payload['cost'], payload['bounds'], payload['constraints']
    if not isinstance(costs, list) or not 1 <= len(costs) <= 100 or any(not number(c) or c <= 0 for c in costs):
        raise ValueError('Invalid costs')
    if not isinstance(bounds, list) or len(bounds) != len(costs):
        raise ValueError('Invalid bounds')
    for bound in bounds:
        if not isinstance(bound, list) or len(bound) != 2 or any(not number(v) for v in bound) or not 0 <= bound[0] <= bound[1] <= 1:
            raise ValueError('Invalid bounds')
    if not isinstance(constraints, list) or len(constraints) > 11:
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
    result = linprog(costs, A_ub=rows or None, b_ub=rhs or None,
                     A_eq=[[1] * len(costs)], b_eq=[1], bounds=bounds,
                     method='highs', options={'time_limit': 8})
    status = {0: 'optimal', 1: 'limit', 2: 'infeasible', 3: 'unbounded', 4: 'solver-error'}.get(result.status, 'solver-error')
    return {'status': status, 'fractions': result.x.tolist() if result.success else None,
            'objective': float(result.fun) if result.success else None,
            'message': str(result.message), 'solver': f'scipy-{scipy.__version__}/HiGHS'}


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
