#!/usr/bin/env python3
"""Trusted GitHub runner entry point for signed validation and opt-in TestFlight upload."""
import os
import base64
import datetime
import hashlib
import json
from pathlib import Path
import plistlib
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile

IOS = Path(__file__).resolve().parent
BUNDLE_ID = 'io.jingtao.dshanywhere'
SIGNING = ('APPLE_TEAM_ID', 'IOS_DISTRIBUTION_P12_BASE64',
           'IOS_DISTRIBUTION_P12_PASSWORD', 'IOS_PROVISION_PROFILE_BASE64')
ASC = ('ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY_P8')


class ConfigurationError(Exception):
    pass


def require(name):
    value = os.environ.get(name, '')
    if not value:
        raise ConfigurationError('missing configuration: ' + name)
    return value


def gate():
    branch = require('DSH_DEFAULT_BRANCH')
    expected_ref = 'refs/heads/' + branch
    if (require('GITHUB_EVENT_NAME') != 'workflow_dispatch'
            or require('GITHUB_REPOSITORY') != 'jt-wang/dsh-anywhere'
            or require('GITHUB_REF') != 'refs/heads/' + branch
            or require('GITHUB_WORKFLOW_REF') != 'jt-wang/dsh-anywhere/.github/workflows/testflight.yml@' + expected_ref
            or require('GITHUB_WORKFLOW_SHA') != require('GITHUB_SHA')
            or not re.fullmatch(r'[0-9a-f]{40}', require('DSH_SOURCE_SHA'))
            or require('DSH_SOURCE_SHA') != require('GITHUB_SHA')):
        raise ConfigurationError('only the default branch workflow and its exact SHA are allowed')
    if not re.fullmatch(r'\d+\.\d+\.\d+', require('DSH_VERSION')):
        raise ConfigurationError('version must be major.minor.patch')
    if not re.fullmatch(r'[1-9][0-9]{0,8}', require('DSH_BUILD')):
        raise ConfigurationError('build must be a positive integer (at most nine digits)')
    if require('DSH_UPLOAD') not in ('false', 'true'):
        raise ConfigurationError('upload must be exactly false or true')


def preflight():
    gate()
    for name in SIGNING:
        require(name)
    if not re.fullmatch(r'[A-Z0-9]{10}', require('APPLE_TEAM_ID')):
        raise ConfigurationError('invalid APPLE_TEAM_ID')
    if os.environ['DSH_UPLOAD'] == 'true':
        for name in ASC:
            require(name)


def call(args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, **kwargs).stdout


def private_file(path, data):
    with path.open('xb') as handle:
        os.chmod(path, 0o600)
        handle.write(data)


def signing_config():
    gate()
    for name in SIGNING:
        require(name)
    if not re.fullmatch(r'[A-Z0-9]{10}', require('APPLE_TEAM_ID')):
        raise ConfigurationError('invalid APPLE_TEAM_ID')


def archive():
    signing_config()
    require('NSH_SOURCE')
    receipt = require('DSH_NSH_RECEIPT')
    clean = {k: v for k, v in os.environ.items() if k not in (*SIGNING, *ASC)}
    checked = subprocess.run([sys.executable, str(IOS/'runtime_sdk.py'), 'verify', receipt], env=clean)
    if checked.returncode:
        return checked.returncode
    scratch = Path(tempfile.mkdtemp(prefix='dsh-signing-', dir=require('RUNNER_TEMP')))
    keychain = scratch / 'signing.keychain-db'
    manifest = IOS.parent / 'nsh.json'
    original = manifest.read_bytes()
    installed = None
    original_keychains = None
    created_keychain = False
    result = 0
    try:
        p12 = scratch / 'distribution.p12'
        profile = scratch / 'profile.mobileprovision'
        private_file(p12, base64.b64decode(require('IOS_DISTRIBUTION_P12_BASE64'), validate=True))
        private_file(profile, base64.b64decode(require('IOS_PROVISION_PROFILE_BASE64'), validate=True))
        facts = plistlib.loads(call(['security', 'cms', '-D', '-i', str(profile)]))
        ent = facts.get('Entitlements', {})
        expiry = facts.get('ExpirationDate')
        if (facts.get('TeamIdentifier') != [os.environ['APPLE_TEAM_ID']]
                or ent.get('application-identifier') != os.environ['APPLE_TEAM_ID'] + '.' + BUNDLE_ID
                or ent.get('get-task-allow') is not False or 'ProvisionedDevices' in facts
                or facts.get('ProvisionsAllDevices', False)
                or not isinstance(expiry, datetime.datetime)
                or expiry.replace(tzinfo=datetime.timezone.utc) <= datetime.datetime.now(datetime.timezone.utc)
                or not re.fullmatch(r'[0-9A-Fa-f-]{36}', facts.get('UUID', ''))
                or not facts.get('Name') or re.search(r'[<>&\r\n]', facts['Name'])):
            raise ConfigurationError('profile must be an unexpired App Store profile for this team and DSH bundle')
        original_keychains = shlex.split(call(['security', 'list-keychains', '-d', 'user']).decode())
        password = os.urandom(32).hex()
        call(['security', 'create-keychain', '-p', password, str(keychain)])
        created_keychain = True
        call(['security', 'set-keychain-settings', '-lut', '21600', str(keychain)])
        call(['security', 'unlock-keychain', '-p', password, str(keychain)])
        call(['security', 'import', str(p12), '-P', require('IOS_DISTRIBUTION_P12_PASSWORD'),
              '-A', '-t', 'cert', '-f', 'pkcs12', '-k', str(keychain)])
        call(['security', 'set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, str(keychain)])
        identities = call(['security', 'find-identity', '-v', '-p', 'codesigning', str(keychain)]).decode()
        matching = [hashlib.sha1(cert).hexdigest().upper() for cert in facts.get('DeveloperCertificates', [])]
        if not any(fingerprint in line and 'Apple Distribution:' in line
                   for fingerprint in matching for line in identities.splitlines()):
            raise ConfigurationError('p12 has no Apple Distribution private-key identity matching the profile')
        call(['security', 'list-keychains', '-d', 'user', '-s', str(keychain), *original_keychains])
        profile_dir = Path(os.environ.get('DSH_CI_PROFILE_DIRECTORY',
                           str(Path.home() / 'Library/MobileDevice/Provisioning Profiles')))
        profile_dir.mkdir(parents=True, exist_ok=True)
        target = profile_dir / (facts['UUID'] + '.mobileprovision')
        private_file(target, profile.read_bytes())  # Refuse to overwrite an existing profile.
        installed = target
        app = json.loads(original)
        if app.get('id') != BUNDLE_ID:
            raise ConfigurationError('unexpected app bundle in nsh.json')
        app.update(version=os.environ['DSH_VERSION'], build=int(os.environ['DSH_BUILD']))
        manifest.write_text(json.dumps(app, indent=2) + '\n')
        output = Path(require('RUNNER_TEMP')) / 'dsh-testflight'
        # No ASC key or encoded signing material is inherited by the build subprocess.
        env = {k: v for k, v in os.environ.items() if k not in (*SIGNING, *ASC)}
        env.update(ARCHIVE='1', DSH_TEAM=os.environ['APPLE_TEAM_ID'], DSH_PROFILE=facts['Name'],
                   DSH_BUNDLE_PREFIX=BUNDLE_ID.rsplit('.', 1)[0], DSH_OUT=str(output),
                   DSH_DERIVED=str(Path(require('RUNNER_TEMP')) / 'dsh-derived'))
        subprocess.run(['bash', str(IOS / 'build.sh')], env=env, check=True)
        ipa = output / 'export/DSH.ipa'
        if not ipa.is_file() or not ipa.stat().st_size:
            raise ConfigurationError('archive command returned without an IPA')
        with tempfile.TemporaryDirectory(prefix='dsh-verify-', dir=require('RUNNER_TEMP')) as unpacked:
            call(['/usr/bin/ditto', '-x', '-k', str(ipa), unpacked])
            apps = list((Path(unpacked) / 'Payload').glob('*.app'))
            if len(apps) != 1 or not apps[0].is_dir():
                raise ConfigurationError('IPA must contain exactly one app')
            call(['codesign', '--verify', '--deep', '--strict', str(apps[0])])
        summary = {'bundle_id': BUNDLE_ID, 'version': app['version'], 'build': app['build'],
                   'source_sha': os.environ['DSH_SOURCE_SHA'],
                   'ipa_sha256': hashlib.sha256(ipa.read_bytes()).hexdigest(),
                   'runtime_receipt_sha256': hashlib.sha256(Path(receipt).read_bytes()).hexdigest(), 'uploaded': False}
        (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        print('Signed IPA checked; not uploaded.')
    except subprocess.CalledProcessError as error:
        result = error.returncode if error.returncode > 0 else 128 - error.returncode
        print('Archive/signing command failed (exit %d).' % result, file=sys.stderr)
    except (ConfigurationError, ValueError, OSError) as error:
        result = 2
        print('Archive configuration or output invalid: ' + type(error).__name__, file=sys.stderr)
    except InterruptedError as error:
        result = error.errno
    finally:
        cleanup_error = 0
        cleanups = [('restore version', lambda: manifest.write_bytes(original))]
        if installed is not None:
            cleanups.append(('remove profile', lambda: installed.unlink(missing_ok=True)))
        if original_keychains is not None:
            cleanups.append(('restore keychain list', lambda: call(
                ['security', 'list-keychains', '-d', 'user', '-s', *original_keychains])))
        if created_keychain:
            cleanups.append(('delete keychain', lambda: call(['security', 'delete-keychain', str(keychain)])))
        cleanups.append(('remove signing files', lambda: shutil.rmtree(scratch)))
        for label, cleanup in cleanups:
            try:
                cleanup()
            except (subprocess.CalledProcessError, OSError):
                cleanup_error = 1
                print('Cleanup failed: ' + label, file=sys.stderr)
        result = result or cleanup_error
    return result


def upload():
    gate()
    if os.environ['DSH_UPLOAD'] != 'true':
        raise ConfigurationError('upload requires DSH_UPLOAD=true')
    for name in ASC:
        require(name)
    if (not re.fullmatch(r'[A-Z0-9]{10}', os.environ['ASC_KEY_ID'])
            or not re.fullmatch(r'[0-9a-fA-F-]{36}', os.environ['ASC_ISSUER_ID'])):
        raise ConfigurationError('invalid ASC key/issuer identifiers')
    output = Path(require('RUNNER_TEMP')) / 'dsh-testflight'
    ipa = output / 'export/DSH.ipa'
    summary_path = output / 'summary.json'
    summary = json.loads(summary_path.read_text())
    if (summary.get('bundle_id') != BUNDLE_ID
            or summary.get('version') != os.environ['DSH_VERSION']
            or summary.get('build') != int(os.environ['DSH_BUILD'])
            or summary.get('source_sha') != os.environ['DSH_SOURCE_SHA']
            or summary.get('ipa_sha256') != hashlib.sha256(ipa.read_bytes()).hexdigest()
            or summary.get('uploaded') is not False):
        raise ConfigurationError('IPA does not match this checked source/version/build, or was already uploaded')
    # altool's documented search includes ./private_keys; nothing enters the user's key directory.
    with tempfile.TemporaryDirectory(prefix='dsh-asc-', dir=require('RUNNER_TEMP')) as temp:
        keys = Path(temp) / 'private_keys'
        keys.mkdir(mode=0o700)
        private_file(keys / ('AuthKey_' + os.environ['ASC_KEY_ID'] + '.p8'),
                     os.environ['ASC_PRIVATE_KEY_P8'].encode())
        env = {k: v for k, v in os.environ.items() if k not in (*SIGNING, *ASC)}
        for action in ('--validate-app', '--upload-app'):
            try:
                call(['xcrun', 'altool', action, '-f', str(ipa), '-t', 'ios',
                      '--apiKey', os.environ['ASC_KEY_ID'], '--apiIssuer', os.environ['ASC_ISSUER_ID']],
                     cwd=temp, env=env)
            except subprocess.CalledProcessError as error:
                print('Apple %s failed (exit %d); no automatic retry.' % (action, error.returncode), file=sys.stderr)
                return error.returncode if error.returncode > 0 else 128 - error.returncode
    summary['uploaded'] = True
    summary_path.write_text(json.dumps(summary, indent=2) + '\n')
    print('Upload command succeeded; App Store Connect processing and TestFlight availability still need checking.')
    return 0


def main():
    try:
        if sys.argv[1:] == ['gate']:
            gate()
        elif sys.argv[1:] == ['preflight']:
            preflight()
        elif sys.argv[1:] == ['archive']:
            return archive()
        elif sys.argv[1:] == ['upload']:
            return upload()
        else:
            raise ConfigurationError('usage: testflight_ci.py gate|preflight|archive|upload')
        return 0
    except ConfigurationError as error:
        print(str(error), file=sys.stderr)
        return 2
    except InterruptedError as error:
        return error.errno
    except (OSError, ValueError):
        print('Required file/tool is unavailable or invalid.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    def interrupted(signum, _frame):
        raise InterruptedError(128 + signum, 'stopped')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    sys.exit(main())
