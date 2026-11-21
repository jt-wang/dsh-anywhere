#!/usr/bin/env python3
"""Read-only, exact-source App Store Connect inventory and processing receipt."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

import testflight_ci

ORIGIN = 'https://api.appstoreconnect.apple.com'
BUNDLE = testflight_ci.BUNDLE_ID
PROCESSING = frozenset(('PROCESSING', 'FAILED', 'INVALID', 'VALID'))
BETA_STATES = frozenset(('PROCESSING', 'PROCESSING_EXCEPTION', 'MISSING_EXPORT_COMPLIANCE',
                         'READY_FOR_BETA_TESTING', 'IN_BETA_TESTING', 'EXPIRED', 'IN_EXPORT_COMPLIANCE_REVIEW',
                         'READY_FOR_BETA_SUBMISSION', 'WAITING_FOR_BETA_REVIEW', 'IN_BETA_REVIEW',
                         'BETA_REJECTED', 'BETA_APPROVED', 'NOT_APPLICABLE'))
REVIEW_STATES = frozenset(('WAITING_FOR_REVIEW', 'IN_REVIEW', 'REJECTED', 'APPROVED'))
ERROR_CODES = frozenset(('FORBIDDEN_ERROR', 'NOT_AUTHORIZED', 'AUTHENTICATION_ERROR',
                         'PARAMETER_ERROR.INVALID', 'PARAMETER_ERROR.UNKNOWN',
                         'PARAMETER_ERROR.INVALID_COMBINATION', 'PARAMETER_ERROR.INVALID_VALUE'))


class StatusError(Exception):
    pass


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def raw_signature(der):
    # OpenSSL emits DER; ES256 JWT requires fixed-width R || S.
    if len(der) < 8 or der[0] != 0x30 or der[1] != len(der) - 2:
        raise StatusError('Invalid ES256 signature')
    parts, pos = [], 2
    for _ in range(2):
        if pos + 2 > len(der) or der[pos] != 2:
            raise StatusError('Invalid ES256 signature')
        size = der[pos + 1]
        value = der[pos + 2:pos + 2 + size]
        if not value or len(value) != size or value[0] & 0x80:
            raise StatusError('Invalid ES256 signature')
        value = value.lstrip(b'\0')
        if len(value) > 32:
            raise StatusError('Invalid ES256 signature')
        parts.append(value.rjust(32, b'\0'))
        pos += 2 + size
    if pos != len(der):
        raise StatusError('Invalid ES256 signature')
    return b''.join(parts)


def safe_url(url):
    parsed = urllib.parse.urlsplit(url)
    path_ok = parsed.path in ('/v1/apps', '/v1/builds') or re.fullmatch(
        r'/v1/(?:apps/[A-Za-z0-9-]+/betaGroups|betaGroups/[A-Za-z0-9-]+/relationships/builds)', parsed.path)
    if (parsed.scheme != 'https' or parsed.netloc != 'api.appstoreconnect.apple.com'
            or not path_ok or parsed.fragment):
        raise StatusError('Unsafe ASC pagination URL rejected')
    return url


def token(env, url):
    # One exact GET path AND encoded query per two-minute team-key token.
    parsed = urllib.parse.urlsplit(safe_url(url))
    return jwt(env, ['GET ' + parsed.path + ('?' + parsed.query if parsed.query else '')])


def jwt(env, scope):
    # A two-minute team-key token; Apple scopes only GET requests, so a write passes scope=None.
    now = int(time.time())
    header = {'alg': 'ES256', 'kid': env['ASC_KEY_ID'], 'typ': 'JWT'}
    payload = {'iss': env['ASC_ISSUER_ID'], 'iat': now, 'exp': now + 120, 'aud': 'appstoreconnect-v1',
               **({'scope': scope} if scope else {})}
    message = '.'.join(b64(json.dumps(p, separators=(',', ':')).encode()) for p in (header, payload))
    child_env = {k: v for k, v in env.items() if k not in ('APPLE_TEAM_ID', 'API_PRIVATE_KEYS_DIR')
                 and not k.startswith(('ASC_', 'IOS_DISTRIBUTION_', 'IOS_PROVISION_'))}
    with tempfile.TemporaryDirectory(prefix='asc-status-', dir=env.get('RUNNER_TEMP')) as folder:
        key = Path(folder) / 'key.p8'
        with key.open('xb') as handle:
            key.chmod(0o600)
            handle.write(env['ASC_PRIVATE_KEY_P8'].encode())
        result = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', str(key)],
                                input=message.encode(), capture_output=True, env=child_env, timeout=10)
        if result.returncode:
            raise StatusError('JWT signing failed')
        signature = raw_signature(result.stdout)
    return message + '.' + b64(signature)


def error_codes(exc, allowed):
    # Never expose Apple's messages, IDs, headers, URLs, or response body: only its allowed error codes.
    codes = set()
    try:
        body = exc.read(65537)
        data = json.loads(body) if len(body) <= 65536 else None
        errors = data.get('errors') if isinstance(data, dict) else None
        for error in errors if isinstance(errors, list) else []:
            code = error.get('code') if isinstance(error, dict) else None
            if isinstance(code, str) and allowed(code):
                codes.add(code)
    except (ValueError, OSError, TimeoutError, RecursionError):
        pass
    finally:
        exc.close()
    return ' (codes: ' + ', '.join(sorted(codes)) + ')' if codes else ''


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise StatusError('ASC redirect rejected')


class Client:
    def __init__(self, env, deadline):
        self.env, self.deadline = env, deadline
        self.opener = urllib.request.build_opener(NoRedirect())

    def get(self, url):
        safe_url(url)  # Validate before attaching credentials.
        if self.deadline <= time.monotonic():
            raise StatusError('ASC observation timed out')
        request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token(self.env, url),
                                                     'Accept': 'application/json'}, method='GET')
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise StatusError('ASC observation timed out')
        try:
            with self.opener.open(request, timeout=min(30, remaining)) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            raise StatusError('ASC HTTP ' + str(exc.code) + error_codes(exc, ERROR_CODES.__contains__)) from None
        except (urllib.error.URLError, TimeoutError):
            raise StatusError('ASC network error or request timeout') from None

    def listing(self, route, params):
        url = ORIGIN + route + ('?' + urllib.parse.urlencode(params) if params else '')
        data, included, visited = [], [], set()
        while url:
            safe_url(url)
            if urllib.parse.urlsplit(url).path != route:
                raise StatusError('ASC pagination changed resource path')
            if url in visited:
                raise StatusError('ASC pagination cycle')
            visited.add(url)
            page = self.get(url)
            if (not isinstance(page, dict) or not isinstance(page.get('data'), list)
                    or not isinstance(page.get('included', []), list)
                    or not isinstance(page.get('links', {}), dict)):
                raise StatusError('Malformed ASC collection')
            data.extend(page['data'])
            included.extend(page.get('included', []))
            url = page.get('links', {}).get('next')
            if url is not None and not isinstance(url, str):
                raise StatusError('Malformed ASC pagination')
        return data, included


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch('[A-Za-z0-9-]{1,100}', value):
        raise StatusError('Invalid ASC resource identity')
    return value


def related(item, name, included):
    link = item.get('relationships', {}).get(name, {}).get('data')
    if not isinstance(link, dict):
        return {}
    return next((r for r in included if (r['type'], r['id']) == (link['type'], link['id'])), {})


def state(value, allowed):
    return value if isinstance(value, str) and value in allowed else None


def groups(client, app_id, build_id):
    # ASC rejects the collection filters: traverse app ownership, then build linkage.
    items, _ = client.listing('/v1/apps/' + app_id + '/betaGroups', {})
    result = []
    for group in items:
        group_id = identifier(group['id'])
        builds, _ = client.listing('/v1/betaGroups/' + group_id + '/relationships/builds', {})
        attrs = group.get('attributes', {})
        internal = attrs.get('isInternalGroup') is True
        automatic = attrs.get('hasAccessToAllBuilds') is True
        explicit = build_id is not None and any(b['type'] == 'builds' and b['id'] == build_id for b in builds)
        access = build_id is not None and (explicit or (internal and automatic))
        link = attrs.get('publicLink')
        valid_link = isinstance(link, str) and bool(re.fullmatch(
            r'https://testflight\.apple\.com/join/[A-Za-z0-9]+', link))
        enabled = attrs.get('publicLinkEnabled') is True
        # No group names, invitation URLs, tester information, or free-form strings.
        result.append({'id': group_id, 'is_internal': internal,
                       'has_access_to_all_builds': automatic, 'assigned_to_build': explicit,
                       'has_build_access': access, 'public_link_enabled': enabled,
                       'public_invitation_for_build': bool(access and not internal and enabled and valid_link)})
    return result


def inventory(client, app_id, version, build, receipt):
    items, included = client.listing('/v1/builds', {
        'filter[app]': app_id, 'filter[preReleaseVersion.platform]': 'IOS',
        'include': 'preReleaseVersion,buildBetaDetail,betaAppReviewSubmission', 'limit': '200'})
    builds, selected, seen = [], [], set()
    for item in items:
        pre = related(item, 'preReleaseVersion', included).get('attributes', {})
        attrs = item.get('attributes', {})
        number, release_version = attrs.get('version'), pre.get('version')
        if (item.get('type') != 'builds' or pre.get('platform') != 'IOS'
                or not isinstance(number, str) or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){0,2}', number)
                or not isinstance(release_version, str)
                or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){0,2}', release_version)
                or item.get('relationships', {}).get('app', {}).get('data', {}).get('id', app_id) != app_id):
            raise StatusError('ASC build inventory contains an unexpected identity')
        build_id = identifier(item['id'])
        if build_id in seen:
            raise StatusError('Duplicate ASC build identity across pages')
        seen.add(build_id)
        builds.append({'id': build_id, 'version': release_version, 'build': number,
                       'processing_state': state(attrs.get('processingState'), PROCESSING),
                       'expired': attrs.get('expired') if isinstance(attrs.get('expired'), bool) else None})
        if (release_version, number) == (version, build):
            selected.append(item)
    if len(selected) > 1:
        raise StatusError('Multiple exact iOS builds returned by ASC')
    highest = max((int(b['build']) for b in builds if b['build'].isdigit()), default=None)
    receipt['build_inventory'] = {
        'queried_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'builds': builds,
        'highest_numeric_build': highest, 'next_numeric_build': (highest or 0) + 1,
        'requested_build_occupied': any(b['build'] == build for b in builds)}
    receipt.update(build_found=bool(selected), build_id=None, processing_state=None, processing_valid=False,
                   internal_build_state=None, external_build_state=None, beta_review_state=None,
                   groups=None, internal_group_has_build_access=None, public_invitation_for_build=None)
    if selected:
        item = selected[0]
        detail = related(item, 'buildBetaDetail', included).get('attributes', {})
        review = related(item, 'betaAppReviewSubmission', included).get('attributes', {})
        processing = state(item.get('attributes', {}).get('processingState'), PROCESSING)
        receipt.update(build_id=item['id'], processing_state=processing, processing_valid=processing == 'VALID',
                       internal_build_state=state(detail.get('internalBuildState'), BETA_STATES),
                       external_build_state=state(detail.get('externalBuildState'), BETA_STATES),
                       beta_review_state=state(review.get('betaReviewState'), REVIEW_STATES))


def observe(client, version, build, receipt, deadline, wait_seconds):
    apps, _ = client.listing('/v1/apps', {'filter[bundleId]': BUNDLE, 'fields[apps]': 'bundleId'})
    apps = [a for a in apps if a.get('attributes', {}).get('bundleId') == BUNDLE]
    if len(apps) != 1:
        raise StatusError('Expected exactly one ASC app for bundle ID')
    app_id = identifier(apps[0]['id'])
    receipt['app_id'] = app_id
    while True:
        if time.monotonic() >= deadline:
            raise StatusError('ASC observation timed out')
        inventory(client, app_id, version, build, receipt)
        receipt['groups'] = groups(client, app_id, receipt['build_id'])
        receipt['internal_group_has_build_access'] = any(
            g['is_internal'] and g['has_build_access'] for g in receipt['groups'])
        receipt['public_invitation_for_build'] = any(g['public_invitation_for_build'] for g in receipt['groups'])
        if not wait_seconds:
            return
        if receipt['build_found'] and receipt['processing_state'] not in ('VALID', 'PROCESSING'):
            raise StatusError('ASC build processing failed or returned an unknown state')
        if time.monotonic() >= deadline:
            raise StatusError('ASC observation timed out')
        if receipt['processing_valid']:
            return
        time.sleep(min(30, max(0, deadline - time.monotonic())))


def run(args):
    receipt = {'schema_version': 1, 'bundle_id': BUNDLE, 'source_sha': None, 'version': None, 'build': None,
               'app_id': None, 'build_found': False, 'build_id': None, 'processing_state': None,
               'processing_valid': False, 'internal_build_state': None, 'external_build_state': None,
               'beta_review_state': None, 'groups': None, 'internal_group_has_build_access': None,
               'public_invitation_for_build': None, 'build_inventory': None, 'observation': 'error'}
    try:
        try:
            testflight_ci.gate()  # Same exact default/source/workflow SHA; no signing preflight.
        except testflight_ci.ConfigurationError:
            raise StatusError('Trusted TestFlight configuration gate failed') from None
        env = dict(os.environ)
        receipt.update(source_sha=env['DSH_SOURCE_SHA'], version=env['DSH_VERSION'], build=env['DSH_BUILD'])
        if (not re.fullmatch('[A-Z0-9]{10}', env.get('ASC_KEY_ID', ''))
                or not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}',
                                    env.get('ASC_ISSUER_ID', '')) or not env.get('ASC_PRIVATE_KEY_P8')):
            raise StatusError('Missing or invalid ASC configuration')
        deadline = time.monotonic() + (args.wait_seconds or 120)
        observe(Client(env, deadline), env['DSH_VERSION'], env['DSH_BUILD'], receipt, deadline, args.wait_seconds)
        receipt['observation'] = 'complete'
    except StatusError as exc:
        receipt['error'] = str(exc)
        raise
    except Exception:
        receipt['error'] = 'ASC observation failed'
        raise StatusError(receipt['error']) from None
    finally:
        # Explicit allowlisted receipt only, including on gate/network/processing failure.
        Path(args.output).write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--wait-seconds', type=int, default=0, choices=range(0, 1201), metavar='0..1200')
    args = parser.parse_args(argv)

    def cancelled(_signum, _frame):
        raise StatusError('ASC observation cancelled')

    previous = {sig: signal.signal(sig, cancelled) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        run(args)
        print('ASC read-only observation complete; see allowlisted receipt.')
        return 0
    except StatusError as exc:
        print(str(exc))
        return 1
    except Exception:
        print('ASC observation failed; receipt could not be written.')
        return 1
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == '__main__':
    raise SystemExit(main())
