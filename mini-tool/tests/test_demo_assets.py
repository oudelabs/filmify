"""Public analytic-resource tests using only temporary synthetic data."""
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
from numeric_lut_png import decode_rgb8


class DemoAssets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('demo_generator', ROOT/'scripts/generate-demo-assets.py')
        cls.generator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.generator)

    def test_identity_has_independent_exact_axes_at_every_node(self):
        w, h, pixels = decode_rgb8(self.generator.make_lut('identity'))
        self.assertEqual((w, h), (512, 512))
        for b in range(64):
            for g in range(64):
                for r in range(64):
                    i=(((b//8)*64+g)*512+(b % 8)*64+r)*3
                    self.assertEqual(pixels[i:i+3], bytes((v*255+31)//63 for v in (r,g,b)))

    def test_all_demo_nodes_match_separate_analytic_oracle(self):
        for kind, _, _ in self.generator.DEMOS:
            _, _, pixels = decode_rgb8(self.generator.make_lut(kind))
            for b, g, r in [(0,0,0),(63,63,63),(7,11,53),(45,2,19),(31,32,33),(0,63,0)]:
                rr,gg,bb=r/63,g/63,b/63
                values=[rr,gg,bb]
                if kind=='warm': values=[rr+.08*rr*(1-rr),gg,bb-.08*bb*(1-bb)]
                if kind=='cool': values=[rr-.08*rr*(1-rr),gg,bb+.08*bb*(1-bb)]
                if kind=='soft': values=[.06+.88*v for v in values]
                if kind=='vivid':
                    y=.2126*rr+.7152*gg+.0722*bb
                    values=[max(0,min(1,y+1.15*(v-y))) for v in values]
                    values=[v+.3*v*(1-v)*(2*v-1) for v in values]
                if kind=='mono': values=[.2126*rr+.7152*gg+.0722*bb]*3
                expected=bytes(int(max(0,min(1,v))*255+.5) for v in values)
                i=(((b//8)*64+g)*512+(b % 8)*64+r)*3
                self.assertEqual(pixels[i:i+3],expected,(kind,r,g,b))

    def test_monochrome_neutral_and_all_six_looks_distinct(self):
        hashes=set()
        for kind,_,_ in self.generator.DEMOS:
            data=self.generator.make_lut(kind)
            hashes.add(hashlib.sha256(data).hexdigest())
            if kind=='mono':
                _,_,pixels=decode_rgb8(data)
                self.assertTrue(all(pixels[i]==pixels[i+1]==pixels[i+2] for i in range(0,len(pixels),3)))
        self.assertEqual(len(hashes),6)

    def test_rebuild_is_deterministic_without_assets_or_parent_project(self):
        with tempfile.TemporaryDirectory(prefix='filmify-demo-test-') as temp:
            clone=Path(temp)
            (clone/'scripts').mkdir()
            for name in ['generate-demo-assets.py','import-lut.py','numeric_lut_png.py']:
                shutil.copy2(ROOT/'scripts'/name,clone/'scripts'/name)
            def run(script,*args,ok=True):
                p=subprocess.run([sys.executable,'scripts/'+script,*args],cwd=clone,capture_output=True,text=True)
                self.assertEqual(p.returncode==0,ok,p.stdout+p.stderr)
                return p
            run('generate-demo-assets.py')
            def generated():
                return {p.relative_to(clone).as_posix():p.read_bytes() for p in (clone/'minitool').rglob('*') if p.is_file()}
            first=generated();run('generate-demo-assets.py');self.assertEqual(generated(),first)
            # A local import is explicit, local, validated and off by default.
            fixture=clone/'identity.png';fixture.write_bytes(self.generator.make_lut('identity'))
            run('import-lut.py',str(fixture),'--id','user-test','--name','Local test')
            run('generate-demo-assets.py')
            m=clone/'minitool/assets/demo/manifest.json'
            self.assertEqual(len(json.loads(m.read_text())['styles']),6)
            run('generate-demo-assets.py','--include-local')
            self.assertEqual(len(json.loads(m.read_text())['styles']),7)
            local=clone/'local-luts/user-test.png';original=local.read_bytes()
            for flags in [[],['--replace']]:
                run('import-lut.py',str(fixture),'--id','../escape','--name','Bad',*flags,ok=False)
            run('import-lut.py',str(fixture),'--id','user-test','--name','Duplicate',ok=False)
            warm=clone/'warm.png';warm.write_bytes(self.generator.make_lut('warm'))
            run('import-lut.py',str(warm),'--id','user-color','--name','Not gray','--black-and-white',ok=False)
            broken=clone/'bad.png';broken.write_bytes(b'not a PNG')
            run('import-lut.py',str(broken),'--id','user-bad','--name','Bad',ok=False)
            corrupt=bytearray(fixture.read_bytes());corrupt[-5]^=1;broken.write_bytes(corrupt)
            run('import-lut.py',str(broken),'--id','user-crc','--name','CRC',ok=False)
            self.assertEqual(local.read_bytes(),original)
            local.write_bytes(self.generator.make_lut('cool'))
            run('generate-demo-assets.py','--include-local',ok=False)
            run('generate-demo-assets.py')
            self.assertEqual(generated()['minitool/style-config.js'],first['minitool/style-config.js'])


if __name__=='__main__':
    unittest.main()
