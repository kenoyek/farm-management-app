import io,json,subprocess,sys,zipfile
from pathlib import Path
import openpyxl
import pytest

def worker(data):
    return subprocess.run([sys.executable,'scripts/inspect_upload.py'],input=data,capture_output=True,timeout=12)

def workbook(formula=False, external=False):
    w=openpyxl.Workbook();s=w.active;s.title='Ingredients';s.append(['Ingredient','Protein']);s.append(['Soybean', '=1+1' if formula else 45])
    if external:s['A2'].hyperlink='https://example.invalid/'
    buf=io.BytesIO();w.save(buf);return buf.getvalue()

def amended(data, entries):
    out=io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as original,zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as target:
        for name in original.namelist():
            if name not in entries:target.writestr(name,original.read(name))
        for name,value in entries.items():target.writestr(name,value)
    return out.getvalue()

def test_inspects_original_workbook_with_missing_dimensions_and_preserves_formulas():
    run=worker(Path('data/source/Feed Formula Calculator.xlsx').read_bytes());assert run.returncode==0
    sheets=json.loads(run.stdout)['sheets'];assert len(sheets)==5
    starter=next(s for s in sheets if s['name']=='Broiler Starter')
    assert next(c for c in starter['cells'] if c['cell']=='D6')['value']=='=SUM(D8:D41)'

def test_never_evaluates_formula_cells():
    run=worker(workbook(formula=True));assert run.returncode==0
    cell=next(c for c in json.loads(run.stdout)['sheets'][0]['cells'] if c['cell']=='B2')
    assert cell['kind']=='formula' and cell['value']=='=1+1'

@pytest.mark.parametrize('data', [b'not an xlsx',workbook(external=True),amended(workbook(),{'../outside':'payload'}),amended(workbook(),{'xl/vbaProject.bin':'payload'}),amended(workbook(),{'padding1':'x'*11000000,'padding2':'x'*11000000}),amended(workbook(),{'_rels/.rels':'<!DOCTYPE r [<!ENTITY x "expanded">]><r>&x;</r>'})])
def test_rejects_corrupt_external_macro_unsafe_oversized_and_entity_archives(data):
    run=worker(data);assert run.returncode!=0;assert json.loads(run.stdout)['error']

def test_rejects_oversized_cell_coordinates_before_loading():
    w=openpyxl.Workbook();w.active['XFD1048576']='too far';buf=io.BytesIO();w.save(buf)
    run=worker(buf.getvalue());assert run.returncode!=0;assert 'limit' in json.loads(run.stdout)['error'].lower()
