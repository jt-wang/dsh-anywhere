"""Offline public CLI/client checks. No Apple calls, signing identity, or uploads."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.parse

import asc_status as status


def build_page(number='42', version='0.1.8', processing='VALID', build_id='build-42', expired=False):
    relationships = {name: {'data': {'type': kind, 'id': prefix + build_id}}
                     for name, kind, prefix in (
                         ('preReleaseVersion', 'preReleaseVersions', 'pre-'),
                         ('buildBetaDetail', 'buildBetaDetails', 'detail-'),
                         ('betaAppReviewSubmission', 'betaAppReviewSubmissions', 'review-'))}
    return {'data': [{'type': 'builds', 'id': build_id, 'relationships': relationships,
                      'attributes': {'version': number, 'processingState': processing,
                                     'expired': expired, 'private': 'never-export'}}],
            'included': [
                {'type': 'preReleaseVersions', 'id': 'pre-' + build_id,
                 'attributes': {'platform': 'IOS', 'version': version}},
                {'type': 'buildBetaDetails', 'id': 'detail-' + build_id,
                 'attributes': {'internalBuildState': 'IN_BETA_TESTING',
                                'externalBuildState': 'READY_FOR_BETA_SUBMISSION'}},
                {'type': 'betaAppReviewSubmissions', 'id': 'review-' + build_id,
                 'attributes': {'betaReviewState': 'WAITING_FOR_REVIEW', 'private': 'never-export'}}]}


def group(group_id='group-1', internal=True, automatic=False, enabled=False):
    return {'type': 'betaGroups', 'id': group_id,
            'attributes': {'name': 'never-export', 'isInternalGroup': internal,
                           'hasAccessToAllBuilds': automatic, 'publicLinkEnabled': enabled,
                           'publicLink': 'https://testflight.apple.com/join/Synthetic42'}}


APP_PAGE = {'data': [{'type': 'apps', 'id': 'app-1', 'attributes': {'bundleId': status.BUNDLE}}]}
EMPTY = {'data': []}


class Status(unittest.TestCase):
    def setUp(self):
        # parents[0] is ios, [1] is nsh-app, and [2] is the repository root.
        scratch = Path(__file__).resolve().parents[2] / '.amp/in/orb-backup'
        scratch.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix='asc-status-test-', dir=scratch)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.output = self.root / 'receipt.json'
        self.env = dict(PATH=os.environ['PATH'], RUNNER_TEMP=str(self.root),
                        GITHUB_REPOSITORY='jt-wang/dsh-anywhere', GITHUB_REF='refs/heads/main',
                        GITHUB_SHA='a' * 40, DSH_DEFAULT_BRANCH='main', DSH_SOURCE_SHA='a' * 40,
                        GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_WORKFLOW_SHA='a' * 40,
                        GITHUB_WORKFLOW_REF='jt-wang/dsh-anywhere/.github/workflows/testflight.yml@refs/heads/main',
                        DSH_VERSION='0.1.8', DSH_BUILD='42', DSH_UPLOAD='false',
                        ASC_KEY_ID='SYNTHETIC1', ASC_ISSUER_ID='11111111-2222-3333-4444-555555555555',
                        ASC_PRIVATE_KEY_P8='never-export-key')
        self.opener = Mock()
        self.pages = []
        self.requests = []
        self.clock = 100.0

    def open(self, request, timeout):
        self.assertEqual(request.get_method(), 'GET')
        self.assertGreater(timeout, 0)
        self.requests.append(request)
        page = self.pages.pop(0)
        if isinstance(page, Exception):
            raise page
        return contextlib.closing(io.BytesIO(json.dumps(page).encode()))

    def cli(self, pages, wait=0, real_token=False):
        self.pages = list(pages)
        self.opener.open.side_effect = self.open
        args = ['--output', str(self.output)] + (['--wait-seconds', str(wait)] if wait else [])
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, self.env, clear=True))
            stack.enter_context(patch.object(status.urllib.request, 'build_opener', return_value=self.opener))
            stack.enter_context(patch.object(status.time, 'monotonic', side_effect=lambda: self.clock))
            stack.enter_context(patch.object(status.time, 'sleep', side_effect=self.advance))
            if not real_token:
                stack.enter_context(patch.object(status, 'token', return_value='never-export-token'))
            out = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            code = status.main(args)
        saved = self.output.read_text()
        self.assertNotIn('never-export', saved + out.getvalue())
        self.assertNotIn('PRIVATE KEY', saved + out.getvalue())
        return code, json.loads(saved), out.getvalue()

    def advance(self, seconds):
        self.assertGreater(seconds, 0)
        self.clock += seconds

    def test_missing_build_inventory_is_success_without_sleep(self):
        code, receipt, _ = self.cli([APP_PAGE, EMPTY, EMPTY])
        self.assertEqual(code, 0)
        self.assertEqual(self.clock, 100)
        self.assertFalse(receipt['build_found'])
        self.assertFalse(receipt['processing_valid'])
        self.assertEqual(receipt['build_inventory']['builds'], [])
        self.assertIsNone(receipt['build_inventory']['highest_numeric_build'])
        self.assertEqual(receipt['build_inventory']['next_numeric_build'], 1)
        self.assertFalse(receipt['build_inventory']['requested_build_occupied'])
        self.assertEqual(receipt['bundle_id'], 'io.jingtao.dshanywhere')
        self.assertEqual(receipt['observation'], 'complete')
        self.assertEqual(receipt['groups'], [])
        self.assertFalse(receipt['internal_group_has_build_access'])
        self.assertFalse(receipt['public_invitation_for_build'])

    def test_missing_build_inventories_automatic_groups_without_claiming_access(self):
        group_page = {'data': [group('automatic', automatic=True),
                               group('external', internal=False, enabled=True)]}
        other_builds = {'data': [{'type': 'builds', 'id': 'other-build'}]}
        code, receipt, _ = self.cli([APP_PAGE, EMPTY, group_page, other_builds, other_builds])
        self.assertEqual(code, 0)
        self.assertFalse(receipt['build_found'])
        self.assertIsNone(receipt['build_id'])
        self.assertEqual(len(receipt['groups']), 2)
        self.assertTrue(receipt['groups'][0]['has_access_to_all_builds'])
        for row in receipt['groups']:
            self.assertFalse(row['assigned_to_build'])
            self.assertFalse(row['has_build_access'])
            self.assertFalse(row['public_invitation_for_build'])
        self.assertFalse(receipt['internal_group_has_build_access'])
        self.assertFalse(receipt['public_invitation_for_build'])
        self.assertEqual([urllib.parse.urlsplit(r.full_url).path for r in self.requests[2:]], [
            '/v1/apps/app-1/betaGroups',
            '/v1/betaGroups/automatic/relationships/builds',
            '/v1/betaGroups/external/relationships/builds'])
        self.assertEqual(self.clock, 100)

    def test_inventory_all_pages_old_invalid_expired_and_occupied_across_versions(self):
        first = build_page(number='41', version='0.1.7', processing='INVALID', build_id='old', expired=True)
        next_url = status.ORIGIN + '/v1/builds?filter%5Bapp%5D=app-1&cursor=a%2Bb%26c'
        first['links'] = {'next': next_url}
        second = build_page(number='42', version='0.1.6', processing='FAILED', build_id='older')
        third = build_page(number='1.2.3', version='0.1.5', build_id='dotted')
        second['data'] += third['data']
        second['included'] += third['included']
        code, receipt, _ = self.cli([APP_PAGE, first, second, EMPTY])
        self.assertEqual(code, 0)
        inventory = receipt['build_inventory']
        self.assertRegex(inventory['queried_at'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        self.assertEqual([b['id'] for b in inventory['builds']], ['old', 'older', 'dotted'])
        self.assertTrue(inventory['builds'][0]['expired'])
        self.assertEqual(inventory['builds'][0]['processing_state'], 'INVALID')
        self.assertEqual(inventory['highest_numeric_build'], 42)
        self.assertEqual(inventory['next_numeric_build'], 43)
        self.assertTrue(inventory['requested_build_occupied'])
        self.assertFalse(receipt['build_found'])
        self.assertEqual(receipt['groups'], [])
        self.assertFalse(receipt['internal_group_has_build_access'])
        self.assertEqual(self.requests[2].full_url, next_url)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.requests[1].full_url).query)
        self.assertEqual(query['filter[preReleaseVersion.platform]'], ['IOS'])
        self.assertFalse({'filter[version]', 'filter[processingState]', 'filter[expired]',
                          'filter[preReleaseVersion.version]'} & query.keys())

    def test_exact_selection_states_and_automatic_internal_access(self):
        app_first = {'data': [], 'links': {'next': status.ORIGIN + '/v1/apps?cursor=2'}}
        groups_first = {'data': [group('automatic', automatic=True)],
                        'links': {'next': status.ORIGIN + '/v1/apps/app-1/betaGroups?cursor=2'}}
        groups_second = {'data': [group('external', internal=False, enabled=True)]}
        relation_first = {'data': [], 'links': {
            'next': status.ORIGIN + '/v1/betaGroups/external/relationships/builds?cursor=2'}}
        code, receipt, _ = self.cli([app_first, APP_PAGE, build_page(), groups_first, groups_second,
                                    EMPTY, relation_first, {'data': [{'type': 'builds', 'id': 'build-42'}]}])
        self.assertEqual(code, 0)
        self.assertEqual(receipt['build_id'], 'build-42')
        self.assertTrue(receipt['processing_valid'])
        self.assertEqual(receipt['internal_build_state'], 'IN_BETA_TESTING')
        self.assertEqual(receipt['external_build_state'], 'READY_FOR_BETA_SUBMISSION')
        self.assertEqual(receipt['beta_review_state'], 'WAITING_FOR_REVIEW')
        automatic, external = receipt['groups']
        self.assertFalse(automatic['assigned_to_build'])
        self.assertTrue(automatic['has_build_access'])
        self.assertTrue(receipt['internal_group_has_build_access'])
        self.assertTrue(external['assigned_to_build'])
        self.assertTrue(receipt['public_invitation_for_build'])
        self.assertNotIn('public_link', external)
        self.assertNotIn('name', external)

    def test_external_automatic_is_not_access_and_disabled_link_not_invitation(self):
        groups = {'data': [group('external-auto', internal=False, automatic=True, enabled=True),
                           group('disabled', internal=False)]}
        code, receipt, _ = self.cli([APP_PAGE, build_page(), groups, EMPTY,
                                    {'data': [{'type': 'builds', 'id': 'build-42'}]}])
        self.assertEqual(code, 0)
        self.assertFalse(receipt['groups'][0]['has_build_access'])
        self.assertTrue(receipt['groups'][1]['has_build_access'])
        self.assertFalse(receipt['public_invitation_for_build'])
        self.assertFalse(receipt['internal_group_has_build_access'])

    def test_wait_processing_to_valid_and_missing_to_valid(self):
        for first in (EMPTY, build_page(processing='PROCESSING')):
            with self.subTest(first=first):
                self.clock = 100
                pages = [APP_PAGE, first, EMPTY]
                code, receipt, _ = self.cli(pages + [build_page(), EMPTY], wait=40)
                self.assertEqual(code, 0)
                self.assertTrue(receipt['processing_valid'])
                self.assertEqual(self.clock, 130)
                self.assertFalse(self.pages)

    def test_wait_invalid_unknown_and_timeout_write_inventory_on_failure(self):
        for processing in ('INVALID', 'FAILED', 'NEVER_EXPORT_SECRET'):
            code, receipt, _ = self.cli([APP_PAGE, build_page(processing=processing), EMPTY], wait=20)
            self.assertEqual(code, 1)
            self.assertEqual(receipt['observation'], 'error')
            self.assertTrue(receipt['build_inventory']['requested_build_occupied'])
            self.assertIn('unknown state', receipt['error'])
            if processing == 'NEVER_EXPORT_SECRET':
                self.assertIsNone(receipt['processing_state'])
        for first in (EMPTY, build_page(processing='PROCESSING')):
            self.clock = 100
            code, receipt, _ = self.cli([APP_PAGE, first, EMPTY], wait=10)
            self.assertEqual(code, 1)
            self.assertEqual(self.clock, 110)
            self.assertIn('timed out', receipt['error'])
            self.assertIsNotNone(receipt['build_inventory'])
            self.assertEqual(receipt['groups'], [])
            self.assertFalse(receipt['internal_group_has_build_access'])

    def test_zero_wait_is_inventory_not_processing_acceptance(self):
        for processing in ('INVALID', 'PROCESSING', 'NEVER_EXPORT_SECRET'):
            code, receipt, _ = self.cli([APP_PAGE, build_page(processing=processing), EMPTY])
            self.assertEqual(code, 0)
            self.assertFalse(receipt['processing_valid'])
            self.assertEqual(self.clock, 100)

    def test_exact_trust_gate_runs_before_any_client_no_signing_variables_needed(self):
        for key, value in (('GITHUB_SHA', 'b' * 40), ('DSH_SOURCE_SHA', 'b' * 40),
                           ('GITHUB_WORKFLOW_SHA', 'b' * 40), ('GITHUB_REF', 'refs/heads/other'),
                           ('GITHUB_WORKFLOW_REF', 'never-export'), ('GITHUB_EVENT_NAME', 'push'),
                           ('GITHUB_REPOSITORY', 'jt-wang/dsh-anywhere-dev'), ('DSH_UPLOAD', 'invalid')):
            with self.subTest(key=key), patch.dict(self.env, {key: value}):
                code, receipt, _ = self.cli([])
                self.assertEqual(code, 1)
                self.assertIn('gate failed', receipt['error'])
                self.assertIsNone(receipt['source_sha'])
                self.assertIsNone(receipt['build_inventory'])
        self.assertEqual(self.requests, [])
        for name in status.testflight_ci.ASC:
            with patch.dict(self.env, {name: ''}):
                code, receipt, _ = self.cli([])
                self.assertEqual(code, 1)
                self.assertIn('ASC configuration', receipt['error'])

    def test_http_and_unexpected_errors_exclude_credentials_and_server_text(self):
        bodies = [b'never-export', b' ' * 65537,
                  json.dumps({'errors': [{'code': 'FORBIDDEN_ERROR', 'detail': 'never-export'},
                                         {'code': 'FORBIDDEN_ERROR.never-export'},
                                         {'code': ['never-export']}]}).encode()]
        for http_code in (401, 403, 429, 500):
            for body in bodies:
                error = urllib.error.HTTPError(status.ORIGIN, http_code, 'never-export',
                                               {'Authorization': 'never-export'}, io.BytesIO(body))
                code, receipt, out = self.cli([error])
                self.assertEqual(code, 1)
                self.assertIn('ASC HTTP ' + str(http_code), receipt['error'])
                self.assertEqual(out.strip(), receipt['error'])
                self.assertNotIn('FORBIDDEN_ERROR.never-export', out)
        for error in (urllib.error.URLError('never-export'), TimeoutError('never-export'),
                      ValueError('never-export'), KeyError('never-export')):
            code, receipt, _ = self.cli([error])
            self.assertEqual(code, 1)
            self.assertEqual(receipt['observation'], 'error')

    def test_pagination_origin_path_cycle_and_redirect_denied_before_credentials(self):
        bad = ['http://api.appstoreconnect.apple.com/v1/apps', 'https://example.invalid/v1/apps',
               status.ORIGIN + ':443/v1/apps', status.ORIGIN + '/v1/betaTesters',
               'https://api.appstoreconnect.apple.com@evil.invalid/v1/apps',
               status.ORIGIN + '/v1/apps/app-1/betaTesters',
               status.ORIGIN + '/v1/betaGroups/../relationships/builds',
               status.ORIGIN + '/v1/apps#fragment']
        for url in bad:
            client = status.Client(self.env, time.monotonic() + 10)
            with patch.object(status, 'token') as token:
                with self.assertRaises(status.StatusError):
                    client.get(url)
                token.assert_not_called()
            code, receipt, _ = self.cli([{'data': [], 'links': {'next': url}}])
            self.assertEqual(code, 1)
            self.assertIn('Unsafe', receipt['error'])
            self.assertFalse(self.pages)
        for url, message in ((status.ORIGIN + '/v1/builds', 'changed resource path'),
                             (status.ORIGIN + '/v1/apps?cursor=2', 'cycle')):
            page = {'data': [], 'links': {'next': url}}
            code, receipt, _ = self.cli([page, page])
            self.assertEqual(code, 1)
            self.assertIn(message, receipt['error'])
        client = status.Client(self.env, time.monotonic() + 10)
        self.assertTrue(any(isinstance(h, status.NoRedirect) for h in client.opener.handlers))
        for code in (301, 302, 303, 307, 308):
            with self.assertRaisesRegex(status.StatusError, 'redirect rejected'):
                status.NoRedirect().redirect_request(None, None, code, '', {}, status.ORIGIN + '/v1/apps')

    def test_malformed_identity_and_duplicate_exact_build_fail_closed(self):
        pages = [build_page()]
        duplicate = build_page(build_id='duplicate')
        pages[0]['data'] += duplicate['data']
        pages[0]['included'] += duplicate['included']
        for page in (pages[0], {'data': 'never-export'}, build_page(number='never-export'),
                     {'data': [], 'links': {'next': 42}}):
            code, receipt, _ = self.cli([APP_PAGE, page])
            self.assertEqual(code, 1)
            self.assertEqual(receipt['observation'], 'error')

    def test_inventory_retained_when_group_observation_fails(self):
        code, receipt, _ = self.cli([APP_PAGE, build_page(), urllib.error.URLError('never-export')])
        self.assertEqual(code, 1)
        self.assertTrue(receipt['processing_valid'])
        self.assertEqual(receipt['observation'], 'error')
        self.assertEqual(receipt['build_inventory']['builds'][0]['id'], 'build-42')
        self.assertIsNone(receipt['groups'])

    def test_client_deadline_and_malformed_signature_fail_without_network(self):
        client = status.Client(self.env, time.monotonic() - 1)
        with patch.object(status, 'token') as token:
            with self.assertRaisesRegex(status.StatusError, 'timed out'):
                client.get(status.ORIGIN + '/v1/apps')
            token.assert_not_called()
        for der in (b'', b'never-export', b'\x30\x06\x02\x01\xff\x02\x01\x01',
                    b'\x30\x06\x02\x01\x01\x02\x02\x01'):
            with self.assertRaisesRegex(status.StatusError, 'Invalid ES256 signature'):
                status.raw_signature(der)

    def test_subprocess_cli_gate_failure_writes_receipt_without_traceback(self):
        env = dict(self.env, GITHUB_WORKFLOW_SHA='b' * 40, PYTHONDONTWRITEBYTECODE='1')
        result = subprocess.run(['python3', str(Path(status.__file__)), '--output', str(self.output)],
                                env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, '')
        self.assertIn('configuration gate failed', result.stdout)
        self.assertNotIn('never-export', result.stdout + self.output.read_text())
        self.assertEqual(json.loads(self.output.read_text())['observation'], 'error')

    def test_real_jwt_exact_scopes_signature_permissions_cleanup_and_failure(self):
        generated = subprocess.run(['openssl', 'genpkey', '-algorithm', 'EC', '-pkeyopt',
                                    'ec_paramgen_curve:P-256'], capture_output=True, check=True)
        self.env['ASC_PRIVATE_KEY_P8'] = generated.stdout.decode()
        self.env.update(APPLE_TEAM_ID='never-export', IOS_DISTRIBUTION_P12_PASSWORD='never-export',
                        API_PRIVATE_KEYS_DIR='never-export')
        next_url = status.ORIGIN + '/v1/builds?filter%5Bapp%5D=app-1&cursor=a%2Bb%26c'
        first = {'data': [], 'links': {'next': next_url}}
        external, keys = subprocess.run, []

        def sign(args, **kwargs):
            key = Path(args[-1])
            self.assertEqual(key.stat().st_mode & 0o777, 0o600)
            self.assertEqual(key.parent.stat().st_mode & 0o777, 0o700)
            self.assertFalse(any(k.startswith(('ASC_', 'IOS_')) or k in ('APPLE_TEAM_ID', 'API_PRIVATE_KEYS_DIR')
                                 for k in kwargs['env']))
            keys.append(key)
            return external(args, **kwargs)

        with patch.object(status.subprocess, 'run', side_effect=sign):
            code, receipt, _ = self.cli([APP_PAGE, first, build_page(), {'data': [group()]},
                                        {'data': [{'type': 'builds', 'id': 'build-42'}]}], real_token=True)
        self.assertEqual(code, 0)
        self.assertTrue(receipt['processing_valid'])
        self.assertEqual(len(self.requests), 5)
        for request in self.requests:
            jwt = request.get_header('Authorization').removeprefix('Bearer ')
            header, claims, signature = [base64.urlsafe_b64decode(p + '=' * (-len(p) % 4))
                                         for p in jwt.split('.')]
            self.assertEqual(json.loads(header), {'alg': 'ES256', 'kid': 'SYNTHETIC1', 'typ': 'JWT'})
            claims = json.loads(claims)
            self.assertEqual(claims['scope'], ['GET ' + request.full_url.removeprefix(status.ORIGIN)])
            self.assertEqual(claims['exp'] - claims['iat'], 120)
            self.assertEqual(claims['aud'], 'appstoreconnect-v1')
            self.assertEqual(claims['iss'], self.env['ASC_ISSUER_ID'])
            self.assertEqual(len(signature), 64)
            # Independently verify JOSE R||S using OpenSSL's DER verifier.
            integers = []
            for part in (signature[:32], signature[32:]):
                value = part.lstrip(b'\0') or b'\0'
                if value[0] & 0x80:
                    value = b'\0' + value
                integers.append(bytes([2, len(value)]) + value)
            contents = b''.join(integers)
            sigfile, pubfile = self.root / 'signature.der', self.root / 'public.pem'
            sigfile.write_bytes(bytes([0x30, len(contents)]) + contents)
            public = external(['openssl', 'pkey', '-pubout'], input=generated.stdout,
                              capture_output=True, check=True)
            pubfile.write_bytes(public.stdout)
            verified = external(['openssl', 'dgst', '-sha256', '-verify', str(pubfile),
                                 '-signature', str(sigfile)], input='.'.join(jwt.split('.')[:2]).encode(),
                                capture_output=True)
            self.assertEqual(verified.returncode, 0)
        self.assertTrue(all(not key.exists() for key in keys))
        self.assertIn('cursor=a%2Bb%26c', self.requests[2].full_url)
        self.assertEqual(self.requests[3].full_url, status.ORIGIN + '/v1/apps/app-1/betaGroups')
        self.assertEqual(self.requests[4].full_url, status.ORIGIN + '/v1/betaGroups/group-1/relationships/builds')
        failure = subprocess.CompletedProcess([], 17, b'never-export', b'never-export')
        for effect in (failure, TimeoutError('never-export')):
            with patch.object(status.subprocess, 'run', **({'side_effect': effect} if isinstance(effect, Exception)
                                                         else {'return_value': effect})):
                code, receipt, _ = self.cli([APP_PAGE], real_token=True)
            self.assertEqual(code, 1)
            self.assertEqual(receipt['observation'], 'error')
            self.assertFalse(list(self.root.glob('asc-status-*')))


if __name__ == '__main__':
    unittest.main()
