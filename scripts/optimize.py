"""HiGHS LP worker. Receives validated JSON on stdin; never executes formula strings."""
import json,sys
import scipy
from scipy.optimize import linprog
p=json.load(sys.stdin)
rows=[];bounds=[]
for c in p['constraints']:
 if 'max' in c:rows.append(c['values']);bounds.append(c['max'])
 if 'min' in c:rows.append([-x for x in c['values']]);bounds.append(-c['min'])
r=linprog(p['cost'],A_ub=rows or None,b_ub=bounds or None,A_eq=[[1]*len(p['cost'])],b_eq=[1],bounds=p['bounds'],method='highs')
status={0:'optimal',1:'limit',2:'infeasible',3:'unbounded',4:'solver-error'}.get(r.status,'solver-error')
print(json.dumps({'status':status,'fractions':r.x.tolist() if r.success else None,'message':r.message,'solver':f'scipy-{scipy.__version__}/HiGHS'}))
