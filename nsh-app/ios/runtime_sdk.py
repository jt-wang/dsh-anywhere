#!/usr/bin/env python3
"""Build the patched SDK without signing secrets, then verify its exact output."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

PIN = '7b3031fb7c9b93b0dee65f48a227bcf15d2bda38'
PATCH = Path(__file__).with_name('nsh-window-tap.patch')
SECRETS = ('APPLE_TEAM_ID', 'IOS_DISTRIBUTION_P12_BASE64', 'IOS_DISTRIBUTION_P12_PASSWORD',
           'IOS_PROVISION_PROFILE_BASE64', 'ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY_P8')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def context():
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        return {'mode': 'local'}
    keys = ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA')
    if any(not os.environ.get(key) for key in keys):
        raise ValueError('missing workflow run identity')
    return {key: os.environ[key] for key in keys}


def source():
    root = Path(os.environ['NSH_SOURCE']).resolve(strict=True)
    clean = {k: v for k, v in os.environ.items() if k not in SECRETS}
    head = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], env=clean).decode().strip()
    if head != PIN:
        raise ValueError('wrong NSH revision')
    check = subprocess.run(['git', '-C', str(root), 'apply', '--reverse', '--check', str(PATCH)],
                           env=clean, capture_output=True)
    if check.returncode:
        raise ValueError('NSH runtime patch is not applied')
    return root


def inventory(root):
    if not root.is_dir() or root.is_symlink():
        raise ValueError('SDK framework is missing or redirected')
    result = {}
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            if not path.resolve(strict=True).is_relative_to(root.resolve()):
                raise ValueError('SDK link escapes framework')
            result[relative] = {'link': os.readlink(path)}
        elif path.is_file():
            result[relative] = {'sha256': digest(path), 'mode': path.stat().st_mode & 0o777}
        elif not path.is_dir():
            raise ValueError('unsupported SDK entry')
    if not any('sha256' in value for value in result.values()):
        raise ValueError('SDK framework is empty')
    return result


def metadata(root):
    return {'schema': 1, 'nsh_commit': PIN, 'source': str(root), 'patch_sha256': digest(PATCH),
            'builder_sha256': digest(Path(__file__)), 'cli_sha256': digest(root/'target/release/nsh'),
            'context': context()}


def prepare(receipt):
    if any(os.environ.get(name) for name in SECRETS):
        raise ValueError('SDK preparation must run without signing or ASC secrets')
    receipt.unlink(missing_ok=True)
    root = source()
    facts = metadata(root)
    framework = root/'dist/nsh/embed/ios/NativeShell.xcframework'
    if framework.is_symlink():
        raise ValueError('SDK output is redirected')
    if framework.exists():
        shutil.rmtree(framework)
    subprocess.run(['cargo', 'xtask', 'ios-embed', '--no-catalyst', '--no-dev'], cwd=root, check=True)
    facts['files'] = inventory(framework)
    receipt.parent.mkdir(parents=True, exist_ok=True)
    temporary = receipt.with_suffix('.tmp')
    temporary.write_text(json.dumps(facts, sort_keys=True) + '\n')
    temporary.replace(receipt)


def verify(receipt, copied=None):
    root = source()
    actual = json.loads(receipt.read_text())
    expected = metadata(root)
    expected['files'] = inventory(root/'dist/nsh/embed/ios/NativeShell.xcframework')
    if actual != expected:
        raise ValueError('SDK receipt does not match this run, source, patch or framework')
    if copied is not None and inventory(copied) != actual['files']:
        raise ValueError('copied SDK differs from the verified framework')


def main():
    try:
        if len(sys.argv) == 3 and sys.argv[1] == 'prepare':
            prepare(Path(sys.argv[2]))
        elif len(sys.argv) in (3, 4) and sys.argv[1] == 'verify':
            verify(Path(sys.argv[2]), Path(sys.argv[3]) if len(sys.argv) == 4 else None)
        else:
            raise ValueError('usage: runtime_sdk.py prepare RECEIPT | verify RECEIPT [COPIED_FRAMEWORK]')
        return 0
    except subprocess.CalledProcessError as error:
        return error.returncode if error.returncode > 0 else 128 - error.returncode
    except (KeyError, OSError, ValueError):
        print('SDK preparation/verification refused: missing or mismatched inputs; no fallback.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
