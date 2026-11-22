"""Execute workflow gates/tool preparation offline, with no GitHub or Apple calls."""
import os
import hashlib
import json
import sys
import zipfile
from pathlib import Path
import subprocess
import tempfile
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]


class Workflow(unittest.TestCase):
    def setUp(self):
        self.workflow = yaml.safe_load((ROOT/'.github/workflows/testflight.yml').read_text())

    def test_dispatch_gate_executes_and_rejects_wrong_workflow_sha(self):
        step = self.workflow['jobs']['gate']['steps'][-1]
        env = {**os.environ, 'GITHUB_REPOSITORY':'jt-wang/dsh-anywhere',
               'GITHUB_EVENT_NAME':'workflow_dispatch', 'GITHUB_REF':'refs/heads/main',
               'GITHUB_SHA':'a'*40, 'GITHUB_WORKFLOW_SHA':'a'*40,
               'GITHUB_WORKFLOW_REF':'jt-wang/dsh-anywhere/.github/workflows/testflight.yml@refs/heads/main',
               'DSH_DEFAULT_BRANCH':'main', 'DSH_SOURCE_SHA':'a'*40,
               'DSH_VERSION':'0.1.4', 'DSH_BUILD':'6', 'DSH_UPLOAD':'false'}
        def run(changes):
            return subprocess.run(['bash','-eo','pipefail','-c',step['run']],cwd=ROOT,
                                  env={**env,**changes},capture_output=True).returncode
        self.assertEqual(run({}),0)
        self.assertEqual(run({'GITHUB_WORKFLOW_SHA':'b'*40}),2)
        self.assertEqual(run({'GITHUB_EVENT_NAME':'push'}),2)
        self.assertEqual(run({'GITHUB_REF':'refs/pull/1/merge'}),2)
        self.assertEqual(run({'DSH_STATUS_ONLY':'true'}),0)
        self.assertEqual(run({'DSH_STATUS_ONLY':'true','DSH_UPLOAD':'true'}),2)

    def test_status_only_has_no_build_or_signing_credentials(self):
        archive = self.workflow['jobs']['archive']
        self.assertIn('inputs.status_only != true', archive['if'])
        job = self.workflow['jobs']['status']
        self.assertIn("needs.gate.result == 'success'", job['if'])
        self.assertIn('inputs.status_only == true && inputs.upload == false', job['if'])
        self.assertEqual(job['environment'], 'apple-release')
        step = next(s for s in job['steps'] if 'ASC_KEY_ID' in s.get('env', {}))
        self.assertEqual(set(step['env']), {'ASC_KEY_ID','ASC_ISSUER_ID','ASC_PRIVATE_KEY_P8','WAIT_SECONDS'})
        self.assertIn('asc_status.py', step['run'])
        self.assertNotIn('testflight_ci.py archive', step['run'])

    def test_submit_beta_has_no_build_credentials_and_never_builds(self):
        self.assertIn('inputs.submit_beta != true', self.workflow['jobs']['archive']['if'])
        self.assertIs(self.workflow['on']['workflow_dispatch']['inputs']['submit_beta']['default'],False)
        job = self.workflow['jobs']['submit']
        self.assertIn('inputs.submit_beta == true && inputs.upload == false && inputs.status_only == false', job['if'])
        self.assertIn('inputs.source_sha == github.sha', job['if'])
        self.assertEqual(job['environment'], 'apple-release')
        step = next(s for s in job['steps'] if 'ASC_KEY_ID' in s.get('env', {}))
        self.assertEqual(set(step['env']), {'ASC_KEY_ID','ASC_ISSUER_ID','ASC_PRIVATE_KEY_P8',
                                            'DSH_PUBLIC_LINK','DSH_WHAT_TO_TEST'})
        self.assertIn('asc_submit_beta.py', step['run'])
        self.assertNotIn('testflight_ci.py archive', step['run'])

    def test_pinned_xcodegen_download_checksum_and_success(self):
        step = next(s for s in self.workflow['jobs']['archive']['steps'] if s.get('id') == 'xcodegen')
        self.assertEqual(step.get('env', {}).get('XCODEGEN_VERSION'), '2.45.4')
        with tempfile.TemporaryDirectory() as temp:
            d = Path(temp)
            fixture = d / 'fixture.zip'
            with zipfile.ZipFile(fixture, 'w') as z:
                info = zipfile.ZipInfo('xcodegen/bin/xcodegen')
                info.create_system = 3
                info.external_attr = 0o100755 << 16
                z.writestr(info, '#!/bin/bash\necho synthetic-xcodegen-2.45.4\n')
            curl = d / 'curl'
            curl.write_text('#!' + sys.executable + '\nimport os,sys,shutil\n'
                            'if os.environ.get("TEST_DOWNLOAD_FAIL"): sys.exit(42)\n'
                            'assert sys.argv[-1] == "https://github.com/yonaskolb/XcodeGen/releases/download/2.45.4/xcodegen.zip"\n'
                            'shutil.copyfile(os.environ["TEST_ZIP"],sys.argv[sys.argv.index("-o")+1])\n')
            curl.chmod(0o755)
            env = {**os.environ, **step['env'], 'PATH': temp + ':/usr/bin:/bin',
                   'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_TEMP': temp,
                   'GITHUB_PATH': str(d/'paths'), 'TEST_ZIP': str(fixture)}
            def run(extra):
                return subprocess.run(['bash','-eo','pipefail','-c',step['run']],
                                      env={**env, **extra},capture_output=True)
            self.assertEqual(run({'TEST_DOWNLOAD_FAIL':'1'}).returncode,42)
            mismatch = run({})
            self.assertNotEqual(mismatch.returncode,0)
            self.assertFalse((d/'paths').exists())
            self.assertFalse((d/'xcodegen').exists())
            success = run({'XCODEGEN_SHA256':hashlib.sha256(fixture.read_bytes()).hexdigest()})
            self.assertEqual(success.returncode,0,success.stderr)
            self.assertIn(b'synthetic-xcodegen-2.45.4',success.stdout)
            executable = Path((d/'paths').read_text().strip())/'xcodegen'
            self.assertTrue(os.access(executable,os.X_OK))

    def test_runtime_patch_is_applied_before_sdk_build(self):
        step = next(s for s in self.workflow['jobs']['archive']['steps'] if 'Build the pinned' in s.get('name',''))
        for failure in (False, True):
            with self.subTest(patch_failure=failure), tempfile.TemporaryDirectory() as temp:
                d=Path(temp);bins=d/'bin';bins.mkdir();events=d/'events'
                stub = """#!PYTHON
import os,sys,json,pathlib
name=pathlib.Path(sys.argv[0]).name;args=sys.argv[1:]
with open(os.environ['TEST_EVENTS'],'a') as f:f.write(json.dumps([name]+args)+'\\n')
if name=='git':
 if args[0]=='init':pathlib.Path(args[-1]).mkdir()
 else:
  assert args[0]=='-C';target=pathlib.Path(args[1]);args=args[2:]
  if args[0]=='rev-parse':print(os.environ['NSH_COMMIT'])
  if args[0]=='apply':
   assert pathlib.Path(args[-1]).is_file()
   if os.environ.get('TEST_PATCH_FAIL'):sys.exit(67)
   if '--check' not in args:(target/'patched').write_text('yes')
elif name=='cargo':
 if not (pathlib.Path.cwd()/'patched').exists():sys.exit(68)
 assert not any(os.environ.get(k) for k in ('APPLE_TEAM_ID','IOS_DISTRIBUTION_P12_BASE64','IOS_DISTRIBUTION_P12_PASSWORD','IOS_PROVISION_PROFILE_BASE64','ASC_KEY_ID','ASC_ISSUER_ID','ASC_PRIVATE_KEY_P8'))
 if args[0]=='build':
  p=pathlib.Path('target/release/nsh');p.parent.mkdir(parents=True);p.write_text('synthetic-cli')
 if args[0]=='xtask':
  p=pathlib.Path('dist/nsh/embed/ios/NativeShell.xcframework');p.mkdir(parents=True);(p/'binary').write_text('synthetic-sdk')
""".replace('PYTHON',sys.executable)
                for name in ('git','cargo','rustup','xcodegen','xcodebuild'):
                    p=bins/name;p.write_text(stub);p.chmod(0o755)
                env={**os.environ,'PATH':str(bins)+':'+str(Path(sys.executable).parent)+':/usr/bin:/bin','RUNNER_TEMP':temp,
                     'GITHUB_WORKSPACE':str(ROOT),'GITHUB_ENV':str(d/'environment'),'DEVELOPER_DIR':temp,'TEST_EVENTS':str(events),
                     'NSH_COMMIT':self.workflow['env']['NSH_COMMIT']}
                if failure:env['TEST_PATCH_FAIL']='1'
                result=subprocess.run(['bash','-eo','pipefail','-c',step['run']],env=env,capture_output=True,timeout=10)
                self.assertEqual(result.returncode,67 if failure else 0,result.stderr)
                commands=[json.loads(line) for line in events.read_text().splitlines()]
                cargo=[i for i,e in enumerate(commands) if e[0]=='cargo']
                if failure:self.assertFalse(cargo)
                else:
                    applied=[i for i,e in enumerate(commands) if e[0]=='git' and 'apply' in e and '--check' not in e]
                    self.assertEqual([Path(commands[i][-1]).name for i in applied],['nsh-window-tap.patch','nsh-number-pad.patch'])
                    self.assertTrue(cargo)
                    self.assertLess(max(applied),min(cargo))
                    self.assertTrue((d/'dsh-runtime.json').is_file())
                    self.assertEqual(sum(e[:2]==['cargo','xtask'] for e in commands),1)
                    receipt=json.loads((d/'dsh-runtime.json').read_text())
                    self.assertIn('binary',receipt['files'])

    def test_no_push_upload_and_no_secret_in_dependency_steps(self):
        self.assertEqual(set(self.workflow['on']),{'workflow_dispatch'})
        self.assertIs(self.workflow['on']['workflow_dispatch']['inputs']['upload']['default'],False)
        steps=self.workflow['jobs']['archive']['steps']
        for step in steps:
            if step.get('id')=='archive':
                self.assertFalse(any(k.startswith('ASC_') for k in step['env']))
            if 'Build the pinned' in step.get('name','') or 'Build Tailcat' in step.get('name',''):
                self.assertNotIn('env',step)
        paths=steps[-1]['with']['path'].splitlines()
        self.assertEqual(paths,['${{ runner.temp }}/dsh-testflight/export/DSH.ipa',
                                '${{ runner.temp }}/dsh-testflight/summary.json'])


if __name__=='__main__':
    unittest.main(verbosity=2)
