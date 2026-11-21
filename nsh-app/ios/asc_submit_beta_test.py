"""Offline checks of the Beta App Review submission. No Apple calls: a fake ASC that changes as the script writes."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import asc_status as asc
import asc_submit_beta as submit

LINK = 'https://testflight.apple.com/join/Public42'


class FakeAsc:
    """Two builds of 0.1.8 (41 already under review, 42 the one asked for), an internal group, the public external
    group and another external group. Writes change what the next reads return."""

    def __init__(self, processing='VALID', submitted=None, assigned=False, localization=None):
        self.processing, self.review = processing, {'build-42': submitted, 'build-41': 'APPROVED'}
        self.members = {'internal': [], 'public': ['build-42'] if assigned else [], 'other': []}
        self.localization = localization  # whatsNew text of build 42's en-US localization, None when it has none
        self.writes = []

    def build(self, build_id, number, processing):
        rel = {'preReleaseVersion': {'data': {'type': 'preReleaseVersions', 'id': 'pre'}},
               'buildBetaDetail': {'data': {'type': 'buildBetaDetails', 'id': 'detail-' + build_id}}}
        included = [{'type': 'preReleaseVersions', 'id': 'pre', 'attributes': {'platform': 'IOS', 'version': '0.1.8'}},
                    {'type': 'buildBetaDetails', 'id': 'detail-' + build_id,
                     'attributes': {'externalBuildState': 'WAITING_FOR_BETA_REVIEW' if self.review[build_id]
                                    else 'READY_FOR_BETA_SUBMISSION'}}]
        if self.review[build_id]:
            rel['betaAppReviewSubmission'] = {'data': {'type': 'betaAppReviewSubmissions', 'id': 'review-' + build_id}}
            included.append({'type': 'betaAppReviewSubmissions', 'id': 'review-' + build_id,
                             'attributes': {'betaReviewState': self.review[build_id]}})
        return {'type': 'builds', 'id': build_id, 'relationships': rel,
                'attributes': {'version': number, 'processingState': processing, 'expired': False}}, included

    def listing(self, route, params):
        if route == '/v1/apps':
            return [{'type': 'apps', 'id': 'app-1', 'attributes': {'bundleId': asc.BUNDLE}}], []
        if route == '/v1/builds' and params.get('include') == 'betaBuildLocalizations':
            refs = [{'type': 'betaBuildLocalizations', 'id': 'loc-42'}] if self.localization is not None else []
            item = {'type': 'builds', 'id': 'build-42', 'relationships': {'betaBuildLocalizations': {'data': refs}}}
            return [item], [{'type': 'betaBuildLocalizations', 'id': 'loc-42',
                             'attributes': {'locale': 'en-US', 'whatsNew': self.localization}}] if refs else []
        if route == '/v1/builds':
            items, included = [], []
            for build_id, number, processing in (('build-41', '41', 'VALID'), ('build-42', '42', self.processing)):
                item, inc = self.build(build_id, number, processing)
                items.append(item)
                included += inc
            return items, included
        if route == '/v1/apps/app-1/betaGroups':
            def group(group_id, internal, link):
                return {'type': 'betaGroups', 'id': group_id, 'attributes': {
                    'isInternalGroup': internal, 'hasAccessToAllBuilds': internal, 'publicLinkEnabled': bool(link),
                    'publicLink': link}}
            return [group('internal', True, None), group('other', False, 'https://testflight.apple.com/join/Other7'),
                    group('public', False, LINK)], []
        group_id = route.split('/')[3]
        return [{'type': 'builds', 'id': b} for b in self.members[group_id]], []

    def write(self, env, method, path, body, deadline):
        self.writes.append((method, path, body))
        if path == '/v1/betaGroups/public/relationships/builds':
            self.members['public'] += [d['id'] for d in body['data']]
        elif path.startswith('/v1/betaGroups/'):
            self.members[path.split('/')[3]] += [d['id'] for d in body['data']]
        elif path == '/v1/betaAppReviewSubmissions':
            self.review[body['data']['relationships']['build']['data']['id']] = 'WAITING_FOR_REVIEW'
        else:
            self.localization = body['data']['attributes']['whatsNew']


class Submit(unittest.TestCase):
    def setUp(self):
        scratch = Path(__file__).resolve().parents[2] / '.amp/in/orb-backup'
        scratch.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix='asc-submit-test-', dir=scratch)
        self.addCleanup(self.tmp.cleanup)
        self.output = Path(self.tmp.name) / 'receipt.json'
        self.env = dict(PATH=os.environ['PATH'], RUNNER_TEMP=self.tmp.name,
                        GITHUB_REPOSITORY='jt-wang/dsh-anywhere', GITHUB_REF='refs/heads/main',
                        GITHUB_SHA='a' * 40, DSH_DEFAULT_BRANCH='main', DSH_SOURCE_SHA='a' * 40,
                        GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_WORKFLOW_SHA='a' * 40,
                        GITHUB_WORKFLOW_REF='jt-wang/dsh-anywhere/.github/workflows/testflight.yml@refs/heads/main',
                        DSH_VERSION='0.1.8', DSH_BUILD='42', DSH_UPLOAD='false', DSH_STATUS_ONLY='false',
                        DSH_SUBMIT_BETA='true', DSH_PUBLIC_LINK='Public42', DSH_WHAT_TO_TEST='Try voice input.',
                        ASC_KEY_ID='SYNTHETIC1', ASC_ISSUER_ID='11111111-2222-3333-4444-555555555555',
                        ASC_PRIVATE_KEY_P8='never-export-key')

    def cli(self, fake, **env):
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {**self.env, **env}, clear=True))
            stack.enter_context(patch.object(asc, 'Client', return_value=fake))
            stack.enter_context(patch.object(submit, 'write', side_effect=fake.write))
            out = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            code = submit.main(['--output', str(self.output)])
        saved = self.output.read_text()
        self.assertNotIn('never-export', saved + out.getvalue())
        return code, json.loads(saved), out.getvalue()

    def test_valid_build_goes_to_the_public_group_and_beta_review_only(self):
        fake = FakeAsc()
        code, receipt, _ = self.cli(fake)
        self.assertEqual(code, 0)
        self.assertEqual([(m, p) for m, p, _ in fake.writes], [
            ('POST', '/v1/betaBuildLocalizations'), ('POST', '/v1/betaGroups/public/relationships/builds'),
            ('POST', '/v1/betaAppReviewSubmissions')])
        self.assertEqual(fake.writes[1][2], {'data': [{'type': 'builds', 'id': 'build-42'}]})
        self.assertEqual(fake.writes[2][2]['data']['relationships']['build']['data']['id'], 'build-42')
        self.assertEqual(fake.writes[0][2]['data']['attributes'], {'locale': 'en-US', 'whatsNew': 'Try voice input.'})
        self.assertEqual(fake.members, {'internal': [], 'public': ['build-42'], 'other': []})
        self.assertEqual(fake.review['build-41'], 'APPROVED')
        self.assertEqual((receipt['observation'], receipt['beta_review_state'], receipt['group_has_build'],
                          receipt['submitted'], receipt['added_to_group']), ('complete', 'WAITING_FOR_REVIEW', True, True, True))
        self.assertNotIn('build_inventory', receipt)

    def test_rerun_after_submission_writes_nothing_more(self):
        fake = FakeAsc(submitted='WAITING_FOR_REVIEW', assigned=True, localization='Try voice input.')
        code, receipt, _ = self.cli(fake)
        self.assertEqual((code, fake.writes), (0, []))
        self.assertEqual((receipt['submitted'], receipt['added_to_group'], receipt['group_has_build']), (False, False, True))

    def test_a_different_what_to_test_is_replaced_not_added(self):
        fake = FakeAsc(localization='Old text')
        self.assertEqual(self.cli(fake)[0], 0)
        self.assertEqual(fake.writes[0][:2], ('PATCH', '/v1/betaBuildLocalizations/loc-42'))
        self.assertEqual(fake.localization, 'Try voice input.')

    def test_nothing_is_written_unless_the_build_is_valid_and_not_rejected(self):
        for fake, message in ((FakeAsc(processing='PROCESSING'), 'not VALID'),
                              (FakeAsc(submitted='REJECTED'), 'rejected')):
            with self.subTest(message=message):
                code, receipt, out = self.cli(fake)
                self.assertEqual((code, fake.writes), (1, []))
                self.assertIn(message, receipt['error'] + out)

    def test_unknown_public_link_writes_nothing(self):
        fake = FakeAsc()
        code, receipt, _ = self.cli(fake, DSH_PUBLIC_LINK='Missing9')
        self.assertEqual((code, fake.writes), (1, []))
        self.assertIn('external group', receipt['error'])

    def test_inputs_and_gate_are_checked_before_asc(self):
        for change in ({'DSH_SUBMIT_BETA': 'false'}, {'DSH_UPLOAD': 'true'}, {'DSH_STATUS_ONLY': 'true'},
                       {'DSH_PUBLIC_LINK': 'https://testflight.apple.com/join/Public42'}, {'DSH_WHAT_TO_TEST': '  '}):
            with self.subTest(change=change):
                fake = FakeAsc()
                with patch.object(FakeAsc, 'listing', side_effect=AssertionError('no ASC call')):
                    code, receipt, _ = self.cli(fake, **change)
                self.assertEqual((code, fake.writes), (1, []))

    def test_writes_only_to_the_allowlisted_paths_and_methods(self):
        for method, path in (('DELETE', '/v1/betaAppReviewSubmissions'), ('POST', '/v1/appStoreVersionSubmissions'),
                             ('POST', '/v1/betaGroups/x/relationships/betaTesters'), ('POST', '/v1/builds/x')):
            with self.subTest(path=path), self.assertRaisesRegex(asc.StatusError, 'Unsafe ASC write'):
                submit.write(self.env, method, path, {}, float('inf'))


if __name__ == '__main__':
    unittest.main()
