"""Exercise build.sh before app compilation; no SDK build or simulator runs."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

IOS = Path(__file__).resolve().parent
PIN = '7b3031fb7c9b93b0dee65f48a227bcf15d2bda38'


class RuntimePatch(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dsh-runtime-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ios = self.root/'nsh-app/ios'
        self.ios.mkdir(parents=True)
        for name in ('build.sh', 'nsh-window-tap.patch', 'runtime_sdk.py'):
            shutil.copyfile(IOS/name, self.ios/name)
        (self.ios/'Frameworks/Dshtailcat.xcframework').mkdir(parents=True)
        self.nsh = self.root/'nsh'
        self.framework = self.nsh/'dist/nsh/embed/ios/NativeShell.xcframework'
        self.framework.mkdir(parents=True)
        (self.framework/'binary').write_text('OLD')
        binaries = self.root/'bin'
        binaries.mkdir()
        self.events = self.root/'events'
        stub = '''#!PYTHON
import json,os,pathlib,sys
name=pathlib.Path(sys.argv[0]).name;args=sys.argv[1:]
with open(os.environ['TEST_EVENTS'],'a') as f:f.write(json.dumps([name]+args)+'\\n')
if name=='git':
 if args[2:]==['rev-parse','HEAD']:print(os.environ['TEST_HEAD'])
 elif args[2:5]==['apply','--reverse','--check']:
  assert pathlib.Path(args[-1]).name=='nsh-window-tap.patch'
  sys.exit(0 if os.environ['TEST_PATCHED']=='1' else 1)
 else:sys.exit(91)
elif name=='cargo':
 assert args==['xtask','ios-embed','--no-catalyst','--no-dev']
 target=pathlib.Path(os.environ['NSH_SOURCE'])/'dist/nsh/embed/ios/NativeShell.xcframework'
 assert not target.exists(),'old framework must be removed before rebuild'
 if os.environ.get('TEST_COMPILE_FAIL'):sys.exit(55)
 if not os.environ.get('TEST_NO_OUTPUT'):
  target.mkdir(parents=True);(target/'binary').write_text('PATCHED')
elif name=='nsh':
 if args==['--version']:print('synthetic-nsh')
 else:sys.exit(44) # Stop before application compilation, after framework copying.
'''.replace('PYTHON', sys.executable)
        for name in ('git','cargo','xcodegen'):
            p=binaries/name;p.write_text(stub);p.chmod(0o755)
        p=self.nsh/'target/release/nsh';p.parent.mkdir(parents=True);p.write_text(stub);p.chmod(0o755)
        self.env = {k:v for k,v in os.environ.items() if not k.startswith(('DSH_', 'NSH_', 'TEST_', 'APPLE_', 'IOS_', 'ASC_', 'GITHUB_')) and k not in ('ARCHIVE','DEVICE')}
        self.env.update(PATH=str(binaries)+':'+str(Path(sys.executable).parent)+':/usr/bin:/bin',NSH_SOURCE=str(self.nsh),
                        TEST_EVENTS=str(self.events),TEST_HEAD=PIN,TEST_PATCHED='1')

    def run_build(self, **changes):
        return subprocess.run(['bash',str(self.ios/'build.sh')],env={**self.env,**changes},
                              capture_output=True,text=True,timeout=10)

    def commands(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()] if self.events.exists() else []

    def assert_not_copied(self):
        self.assertFalse((self.ios/'Frameworks/NativeShell.xcframework').exists())

    def test_unpatched_source_is_rejected_before_compilation(self):
        result=self.run_build(TEST_PATCHED='0')
        self.assertEqual(result.returncode,2,result.stderr)
        self.assertFalse(any(e[0] in ('cargo','nsh') for e in self.commands()))
        self.assert_not_copied()

    def test_wrong_source_revision_is_rejected(self):
        result=self.run_build(TEST_HEAD='a'*40)
        self.assertEqual(result.returncode,2,result.stderr)
        self.assertFalse(any(e[0] in ('cargo','nsh') for e in self.commands()))
        self.assert_not_copied()

    def test_patched_source_rebuilds_and_copies_fresh_framework(self):
        result=self.run_build()
        self.assertEqual(result.returncode,44,result.stderr)
        self.assertEqual((self.ios/'Frameworks/NativeShell.xcframework/binary').read_text(),'PATCHED')
        names=[e[0] for e in self.commands()]
        self.assertLess(names.index('cargo'),names.index('nsh'))

    def test_compile_failure_never_copies_old_framework(self):
        result=self.run_build(TEST_COMPILE_FAIL='1')
        self.assertEqual(result.returncode,55,result.stderr)
        self.assert_not_copied()

    def test_success_without_framework_is_rejected(self):
        result=self.run_build(TEST_NO_OUTPUT='1')
        self.assertEqual(result.returncode,2,result.stderr)
        self.assert_not_copied()

    def test_missing_prepared_receipt_never_falls_back_to_compile(self):
        result=self.run_build(DSH_NSH_RECEIPT=str(self.root/'missing.json'))
        self.assertEqual(result.returncode,2,result.stderr)
        self.assertFalse(any(e[0]=='cargo' for e in self.commands()))
        self.assert_not_copied()

    def test_invalid_receipt_never_accepts_existing_framework(self):
        receipt=self.root/'receipt.json';receipt.write_text('{}')
        result=self.run_build(DSH_NSH_RECEIPT=str(receipt))
        self.assertEqual(result.returncode,2,result.stderr)
        self.assertFalse(any(e[0]=='cargo' for e in self.commands()))
        self.assert_not_copied()

    def test_compilation_refuses_signing_material(self):
        result=self.run_build(IOS_DISTRIBUTION_P12_BASE64='synthetic-not-a-key')
        self.assertEqual(result.returncode,2,result.stderr)
        self.assertFalse(any(e[0]=='cargo' for e in self.commands()))
        self.assert_not_copied()

    def prepare_sdk(self):
        self.env.update(GITHUB_ACTIONS='true',GITHUB_RUN_ID='123',GITHUB_RUN_ATTEMPT='1',GITHUB_SHA='a'*40)
        self.receipt=self.root/'sdk.json'
        result=subprocess.run([sys.executable,str(self.ios/'runtime_sdk.py'),'prepare',str(self.receipt)],
                              env=self.env,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.env['DSH_NSH_RECEIPT']=str(self.receipt)

    def test_prepared_sdk_is_consumed_without_compiling_under_signing(self):
        self.prepare_sdk()
        before=len([e for e in self.commands() if e[0]=='cargo'])
        result=self.run_build(IOS_DISTRIBUTION_P12_BASE64='synthetic-not-a-key')
        self.assertEqual(result.returncode,44,result.stderr)
        self.assertEqual(len([e for e in self.commands() if e[0]=='cargo']),before)
        self.assertEqual((self.ios/'Frameworks/NativeShell.xcframework/binary').read_text(),'PATCHED')

    def test_wrong_framework_is_rejected_without_rebuild(self):
        self.prepare_sdk()
        (self.framework/'binary').write_text('OLD')
        result=self.run_build()
        self.assertEqual(result.returncode,2,result.stderr)
        self.assertEqual(len([e for e in self.commands() if e[0]=='cargo']),1)
        self.assert_not_copied()

    def test_receipt_from_another_run_is_rejected(self):
        self.prepare_sdk()
        result=self.run_build(GITHUB_RUN_ID='124')
        self.assertEqual(result.returncode,2,result.stderr)
        self.assert_not_copied()

    def test_changed_patch_is_rejected(self):
        self.prepare_sdk()
        p=self.ios/'nsh-window-tap.patch';p.write_bytes(p.read_bytes()+b'\n')
        result=self.run_build()
        self.assertEqual(result.returncode,2,result.stderr)
        self.assert_not_copied()

    def test_added_framework_file_is_rejected(self):
        self.prepare_sdk()
        (self.framework/'extra').write_text('unexpected')
        result=self.run_build()
        self.assertEqual(result.returncode,2,result.stderr)
        self.assert_not_copied()


if __name__=='__main__':
    unittest.main(verbosity=2)
