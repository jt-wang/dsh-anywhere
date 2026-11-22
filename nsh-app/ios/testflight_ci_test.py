"""Offline command-boundary tests; never build, sign, or contact Apple."""
import os
import base64
import hashlib
import json
import plistlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('testflight_ci.py')


class TestFlight(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='dsh-ci-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.ios = self.root / 'nsh-app/ios'
        self.ios.mkdir(parents=True)
        for name in ('testflight_ci.py', 'build.sh', 'check-testflight.sh', 'nsh-window-tap.patch', 'runtime_sdk.py'):
            shutil.copyfile(SCRIPT.with_name(name), self.ios / name)
        shutil.copyfile(SCRIPT.parent.with_name('nsh-number-pad.patch'), self.ios.parent / 'nsh-number-pad.patch')
        (self.ios / 'build.sh').chmod(0o755)
        (self.ios / 'check-testflight.sh').chmod(0o755)
        self.manifest = self.ios.parent / 'nsh.json'
        self.original = b'{"id":"io.jingtao.dshanywhere","version":"0.1.4","build":5}\n'
        self.manifest.write_bytes(self.original)
        (self.ios / 'Frameworks/Dshtailcat.xcframework').mkdir(parents=True)
        nsh = self.root / 'nsh'
        (nsh / 'dist/nsh/embed/ios/NativeShell.xcframework').mkdir(parents=True)
        (nsh / 'target/release').mkdir(parents=True)
        bins = self.root / 'bin'
        bins.mkdir()
        stub = '''#!PYTHON
import os, sys, json, plistlib, pathlib, zipfile, hashlib
name=pathlib.Path(sys.argv[0]).name; args=sys.argv[1:]
with open(os.environ['TEST_EVENTS'],'a') as f: f.write(json.dumps([name]+args)+'\\n')
if name=='git':
 if args[2:]==['rev-parse','HEAD']: print('33512ba2268774f5a8904e1532aabe37b2f2a65f')
 else: assert args[2:5]==['apply','--reverse','--check'] and pathlib.Path(args[-1]).is_file()
elif name=='cargo':
 assert not any(os.environ.get(k) for k in ('APPLE_TEAM_ID','IOS_DISTRIBUTION_P12_BASE64','IOS_DISTRIBUTION_P12_PASSWORD','IOS_PROVISION_PROFILE_BASE64','ASC_KEY_ID','ASC_ISSUER_ID','ASC_PRIVATE_KEY_P8'))
 assert args==['xtask','ios-embed','--no-catalyst','--no-dev']
 framework=pathlib.Path(os.environ['NSH_SOURCE'])/'dist/nsh/embed/ios/NativeShell.xcframework'
 assert not framework.exists()
 framework.mkdir(parents=True);(framework/'binary').write_text('synthetic-patched-runtime')
elif name=='security':
 if args[:2]==['list-keychains','-d'] and '-s' not in args: print('"/synthetic/original.keychain-db"')
 if args[0]=='cms':
  profile={'UUID':'11111111-2222-3333-4444-555555555555','Name':'Synthetic Distribution','TeamIdentifier':['TEAM123456'], 'ExpirationDate':__import__('datetime').datetime(2099,1,1),'Entitlements':{'application-identifier':'TEAM123456.io.jingtao.dshanywhere','get-task-allow':False},'DeveloperCertificates':[b'synthetic-cert']}
  if os.environ.get('TEST_BAD_PROFILE'): profile['Entitlements']['application-identifier']='TEAM123456.wrong.app'
  sys.stdout.buffer.write(plistlib.dumps(profile))
 if args[0]=='find-identity': print('1) '+hashlib.sha1(b'synthetic-cert').hexdigest().upper()+' "Apple Distribution: Synthetic"')
 if args[0]=='delete-keychain' and os.environ.get('TEST_CLEANUP_FAIL'): sys.exit(29)
elif name=='nsh':
 if '--out' in args: pathlib.Path(args[args.index('--out')+1]).mkdir(parents=True,exist_ok=True)
elif name=='xcodebuild':
 if 'archive' in args:
  if os.environ.get('TEST_RESTORE_FAIL'):
   manifest=pathlib.Path(args[args.index('-project')+1]).parent.parent/'nsh.json';manifest.unlink();manifest.mkdir()
  if os.environ.get('TEST_PROFILE_UNLINK_FAIL'):
   for p in pathlib.Path(os.environ['DSH_CI_PROFILE_DIRECTORY']).glob('*.mobileprovision'): p.unlink();p.mkdir()
  if os.environ.get('TEST_ARCHIVE_FAIL'): sys.exit(55)
  values=dict(x.split('=',1) for x in args if '=' in x)
  pathlib.Path(os.environ['TEST_ARCHIVE_VALUES']).write_text(json.dumps(values))
 if '-exportArchive' in args:
  out=pathlib.Path(args[args.index('-exportPath')+1]);out.mkdir(parents=True,exist_ok=True)
  values=json.loads(pathlib.Path(os.environ['TEST_ARCHIVE_VALUES']).read_text())
  info={'CFBundleIdentifier':'io.jingtao.dshanywhere','CFBundleShortVersionString':values['DSH_VERSION'],'CFBundleVersion':values['DSH_BUILD'],'DTPlatformName':'iphoneos','ITSAppUsesNonExemptEncryption':False,'CFBundleExecutable':'DSH','NSCameraUsageDescription':'Synthetic','NSLocalNetworkUsageDescription':'Synthetic'}
  with zipfile.ZipFile(out/'DSH.ipa','w') as z:
   z.writestr('Payload/DSH.app/Info.plist',plistlib.dumps(info));z.writestr('Payload/DSH.app/DSH','synthetic');z.writestr('Payload/DSH.app/PrivacyInfo.xcprivacy','synthetic')
   for lang in ['en','zh-Hans','zh-Hant','es','fr','ko','ja','ru']: z.writestr('Payload/DSH.app/'+lang+'.lproj/InfoPlist.strings',plistlib.dumps(info))
elif name=='codesign':
 if '--verify' in args:
  assert '--deep' in args and '--strict' in args
  assert pathlib.Path(args[-1]).is_dir() and pathlib.Path(args[-1]).parent.name=='Payload'
  if os.environ.get('TEST_SIGNATURE_FAIL'): sys.exit(58)
  sys.exit(0)
 if '-dvv' in args: print('Authority=Apple Distribution: Synthetic',file=sys.stderr)
 else: sys.stdout.buffer.write(plistlib.dumps({'get-task-allow':False,'beta-reports-active':True}))
elif name=='xcrun':
 if not list(pathlib.Path.cwd().glob('private_keys/AuthKey_*.p8')): sys.exit(57)
 if os.environ.get('TEST_VALIDATE_FAIL') and '--validate-app' in args: sys.exit(54)
 if os.environ.get('TEST_UPLOAD_FAIL') and '--upload-app' in args: sys.exit(56)
'''.replace('PYTHON', sys.executable)
        for name in ('git', 'cargo', 'security', 'xcodegen', 'xcodebuild', 'codesign', 'strings', 'nm', 'xcrun'):
            path = bins / name; path.write_text(stub); path.chmod(0o755)
        binary = nsh / 'target/release/nsh'; binary.write_text(stub); binary.chmod(0o755)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(('ASC_', 'IOS_', 'APPLE_', 'DSH_'))}
        self.env.update(PATH=str(bins)+os.pathsep+os.environ['PATH'],
                        GITHUB_REPOSITORY='jt-wang/dsh-anywhere', GITHUB_REF='refs/heads/main',
                        GITHUB_SHA='a'*40, DSH_DEFAULT_BRANCH='main', DSH_SOURCE_SHA='a'*40,
                        GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_WORKFLOW_SHA='a'*40,
                        GITHUB_WORKFLOW_REF='jt-wang/dsh-anywhere/.github/workflows/testflight.yml@refs/heads/main',
                        DSH_VERSION='0.1.4', DSH_BUILD='6', DSH_UPLOAD='false',
                        APPLE_TEAM_ID='TEAM123456', IOS_DISTRIBUTION_P12_BASE64=base64.b64encode(b'synthetic').decode(),
                        IOS_DISTRIBUTION_P12_PASSWORD='synthetic', IOS_PROVISION_PROFILE_BASE64=base64.b64encode(b'synthetic').decode(),
                        RUNNER_TEMP=str(self.root/'temp'), NSH_SOURCE=str(nsh),
                        DSH_CI_PROFILE_DIRECTORY=str(self.root/'profiles'),
                        TEST_EVENTS=str(self.root/'events'), TEST_ARCHIVE_VALUES=str(self.root/'archive-values.json'))
        (self.root/'temp').mkdir()
        self.env['DSH_NSH_RECEIPT']=str(self.root/'temp/sdk.json')
        clean={k:v for k,v in self.env.items() if not k.startswith(('APPLE_','IOS_','ASC_'))}
        prepared=subprocess.run([sys.executable,str(self.ios/'runtime_sdk.py'),'prepare',self.env['DSH_NSH_RECEIPT']],
                                env=clean,capture_output=True,text=True,timeout=10)
        self.assertEqual(prepared.returncode,0,prepared.stderr)
        (self.root/'events').write_text('')

    def run_ci(self, command, **changes):
        return subprocess.run([sys.executable, str(self.ios/'testflight_ci.py'), command],
                              env={**self.env, **changes}, capture_output=True, text=True, timeout=20)

    def events(self):
        p = self.root/'events'
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []

    def test_missing_configuration_fails_before_commands(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith(('ASC_', 'IOS_', 'APPLE_', 'DSH_'))}
        env.update(GITHUB_REPOSITORY='jt-wang/dsh-anywhere', GITHUB_REF='refs/heads/main',
                   GITHUB_SHA='a' * 40, DSH_DEFAULT_BRANCH='main', DSH_SOURCE_SHA='a' * 40,
                   GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_WORKFLOW_SHA='a'*40,
                   GITHUB_WORKFLOW_REF='jt-wang/dsh-anywhere/.github/workflows/testflight.yml@refs/heads/main',
                   DSH_VERSION='0.1.4', DSH_BUILD='6', DSH_UPLOAD='false')
        result = subprocess.run([sys.executable, str(SCRIPT), 'preflight'], env=env,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('missing configuration: APPLE_TEAM_ID', result.stderr)

    def test_archive_failure_preserves_error_restores_manifest_and_cleans_signing(self):
        result = self.run_ci('archive', TEST_ARCHIVE_FAIL='1', TEST_CLEANUP_FAIL='1')
        self.assertEqual(result.returncode, 55, result.stderr)
        self.assertEqual(self.manifest.read_bytes(), self.original)
        events = self.events()
        self.assertTrue(any(e[:2] == ['security', 'delete-keychain'] for e in events))
        self.assertIn(['security','list-keychains','-d','user','-s','/synthetic/original.keychain-db'], events)
        self.assertFalse(list((self.root/'profiles').glob('*.mobileprovision')))
        self.assertFalse(list((self.root/'temp').glob('dsh-signing-*')))
        self.assertFalse(any(e[0]=='xcrun' for e in events))

    def test_validate_mode_builds_requested_version_without_asc_and_restores_source(self):
        result = self.run_ci('archive')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        values = json.loads((self.root/'archive-values.json').read_text())
        self.assertEqual((values['DSH_VERSION'],values['DSH_BUILD']),('0.1.4','6'))
        self.assertEqual(self.manifest.read_bytes(),self.original)
        summary = json.loads((self.root/'temp/dsh-testflight/summary.json').read_text())
        self.assertFalse(summary['uploaded'])
        self.assertEqual(summary['runtime_receipt_sha256'],hashlib.sha256(Path(self.env['DSH_NSH_RECEIPT']).read_bytes()).hexdigest())
        self.assertFalse(any(e[0]=='cargo' for e in self.events()), 'archive must consume the prepared SDK without compiling')
        self.assertFalse(any(e[0]=='xcrun' for e in self.events()))
        self.assertFalse(list((self.root/'temp').glob('dsh-signing-*')))
        self.assertFalse(list((self.root/'profiles').glob('*.mobileprovision')))

    def test_invalid_signature_fails_before_success_summary(self):
        result = self.run_ci('archive', TEST_SIGNATURE_FAIL='1')
        self.assertEqual(result.returncode,58,result.stdout+result.stderr)
        self.assertFalse((self.root/'temp/dsh-testflight/summary.json').exists())
        self.assertEqual(self.manifest.read_bytes(),self.original)
        self.assertTrue(any(e[:2]==['security','delete-keychain'] for e in self.events()))
        self.assertFalse(list((self.root/'temp').glob('dsh-verify-*')))

    def test_signature_verification_uses_extracted_ipa_app(self):
        result = self.run_ci('archive')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        commands = [e for e in self.events() if e[0]=='codesign' and '--verify' in e]
        self.assertEqual(len(commands),1)
        self.assertEqual(commands[0][1:4],['--verify','--deep','--strict'])
        self.assertTrue(commands[0][-1].endswith('/Payload/DSH.app'))
        self.assertFalse(list((self.root/'temp').glob('dsh-verify-*')))

    def test_archive_requires_prepared_sdk_before_signing(self):
        result=self.run_ci('archive',DSH_NSH_RECEIPT='')
        self.assertEqual(result.returncode,2,result.stdout+result.stderr)
        self.assertFalse(any(e[0] in ('security','cargo') for e in self.events()))

    def prepare_upload(self):
        self.assertEqual(self.run_ci('archive').returncode,0)
        self.env.update(DSH_UPLOAD='true', ASC_KEY_ID='SYNTHETIC1',
                        ASC_ISSUER_ID='11111111-2222-3333-4444-555555555555',
                        ASC_PRIVATE_KEY_P8='synthetic-key-data')

    def test_upload_requires_explicit_true_even_with_key(self):
        self.prepare_upload()
        result=self.run_ci('upload',DSH_UPLOAD='false')
        self.assertEqual(result.returncode,2,result.stderr)
        self.assertIn('upload requires DSH_UPLOAD=true',result.stderr)
        self.assertFalse(any(e[0]=='xcrun' for e in self.events()))

    def test_failed_apple_validation_never_uploads_and_removes_key(self):
        self.prepare_upload()
        result=self.run_ci('upload',TEST_VALIDATE_FAIL='1')
        self.assertEqual(result.returncode,54,result.stderr)
        commands=[e for e in self.events() if e[0]=='xcrun']
        self.assertEqual(len(commands),1)
        self.assertIn('--validate-app',commands[0])
        self.assertFalse(list((self.root/'temp').glob('dsh-asc-*')))

    def test_upload_failure_is_not_success_and_removes_key(self):
        self.prepare_upload()
        result=self.run_ci('upload',TEST_UPLOAD_FAIL='1')
        self.assertEqual(result.returncode,56,result.stderr)
        self.assertFalse(json.loads((self.root/'temp/dsh-testflight/summary.json').read_text())['uploaded'])
        self.assertFalse(list((self.root/'temp').glob('dsh-asc-*')))

    def test_explicit_upload_validates_then_uploads_exact_checked_ipa(self):
        self.prepare_upload()
        result=self.run_ci('upload')
        self.assertEqual(result.returncode,0,result.stderr)
        commands=[e for e in self.events() if e[0]=='xcrun']
        self.assertEqual([e[2] for e in commands],['--validate-app','--upload-app'])
        summary=json.loads((self.root/'temp/dsh-testflight/summary.json').read_text())
        self.assertTrue(summary['uploaded'])
        self.assertFalse(list((self.root/'temp').glob('dsh-asc-*')))

    def test_profile_for_another_app_is_rejected_before_build(self):
        result=self.run_ci('archive',TEST_BAD_PROFILE='1')
        self.assertEqual(result.returncode,2)
        self.assertFalse(any(e[0]=='xcodebuild' for e in self.events()))

    def test_gate_rejects_nondefault_ref_and_different_sha(self):
        for change in ({'GITHUB_REF':'refs/heads/feature'}, {'DSH_SOURCE_SHA':'b'*40},
                       {'DSH_UPLOAD':'yes'}, {'DSH_VERSION':'1.2.3;bad'}, {'DSH_BUILD':'0'}):
            with self.subTest(change=change):
                self.assertEqual(self.run_ci('preflight',**change).returncode,2)
        self.assertEqual(self.events(),[])

    def test_gate_rejects_nonmanual_or_untrusted_workflow(self):
        for change in ({'GITHUB_EVENT_NAME':'push'}, {'GITHUB_WORKFLOW_SHA':'b'*40},
                       {'GITHUB_WORKFLOW_REF':'jt-wang/dsh-anywhere/.github/workflows/testflight.yml@refs/heads/feature'}):
            with self.subTest(change=change):
                self.assertEqual(self.run_ci('gate',**change).returncode,2)
        self.assertEqual(self.events(),[])

    def test_restore_and_unlink_failures_do_not_skip_keychain_cleanup(self):
        result=self.run_ci('archive',TEST_ARCHIVE_FAIL='1',TEST_RESTORE_FAIL='1',TEST_PROFILE_UNLINK_FAIL='1')
        self.assertEqual(result.returncode,55,result.stderr)
        self.assertTrue(any(e[:2]==['security','delete-keychain'] for e in self.events()))
        self.assertIn(['security','list-keychains','-d','user','-s','/synthetic/original.keychain-db'], self.events())
        self.assertFalse(list((self.root/'temp').glob('dsh-signing-*')))


if __name__ == '__main__':
    unittest.main(verbosity=2)
