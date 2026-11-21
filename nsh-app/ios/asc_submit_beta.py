#!/usr/bin/env python3
"""Puts one VALID build on the external TestFlight group behind a public link and submits it for Beta App Review.

Only the requested version and build, only the external group whose public link is https://testflight.apple.com/join/
<code>, and only Beta App Review: never App Store review, never another build or group. Each step is skipped when ASC
already has it (the What to Test text, the group, a submission), so a rerun is safe. Writes an allowlisted receipt.
"""
import argparse
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

import asc_status as asc
import testflight_ci

# The only writes this script can make.
WRITES = (r'/v1/betaBuildLocalizations', r'/v1/betaBuildLocalizations/[A-Za-z0-9-]{1,100}',
          r'/v1/betaGroups/[A-Za-z0-9-]{1,100}/relationships/builds', r'/v1/betaAppReviewSubmissions')
LOCALE = 'en-US'


def write(env, method, path, body, deadline):
    if method not in ('POST', 'PATCH') or not any(re.fullmatch(p, path) for p in WRITES):
        raise asc.StatusError('Unsafe ASC write rejected')
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise asc.StatusError('ASC submission timed out')
    request = urllib.request.Request(asc.ORIGIN + path, data=json.dumps(body).encode(), method=method, headers={
        'Authorization': 'Bearer ' + asc.jwt(env, None), 'Content-Type': 'application/json',
        'Accept': 'application/json'})
    step = re.sub(r'/[A-Za-z0-9-]{20,}', '/{id}', path)
    try:
        with urllib.request.build_opener(asc.NoRedirect()).open(request, timeout=min(30, remaining)) as response:
            response.read(65536)
    except urllib.error.HTTPError as exc:
        # Apple's error codes are its own enum names (FORBIDDEN_ERROR, STATE_ERROR, ENTITY_ERROR.ATTRIBUTE.REQUIRED).
        codes = asc.error_codes(exc, lambda c: re.fullmatch(r'[A-Z_]{1,40}(?:\.[A-Z_]{1,40}){0,4}', c) is not None)
        raise asc.StatusError(method + ' ' + step + ': ASC HTTP ' + str(exc.code) + codes) from None
    except (urllib.error.URLError, TimeoutError):
        raise asc.StatusError(method + ' ' + step + ': ASC network error or request timeout') from None


def external_group(client, app_id, code):
    items, _ = client.listing('/v1/apps/' + app_id + '/betaGroups', {})
    link = 'https://testflight.apple.com/join/' + code
    found = [g for g in items if g.get('attributes', {}).get('isInternalGroup') is False
             and g.get('attributes', {}).get('publicLink') == link]
    if len(found) != 1:
        raise asc.StatusError('Expected exactly one external group with that public link')
    return asc.identifier(found[0]['id'])


def what_to_test(client, app_id, version, build):
    items, included = client.listing('/v1/builds', {
        'filter[app]': app_id, 'filter[version]': build, 'filter[preReleaseVersion.version]': version,
        'filter[preReleaseVersion.platform]': 'IOS', 'include': 'betaBuildLocalizations'})
    if len(items) != 1:
        raise asc.StatusError('Expected exactly one ASC build for that version and build')
    ids = {r['id'] for r in items[0].get('relationships', {}).get('betaBuildLocalizations', {}).get('data') or []}
    return next(({'id': asc.identifier(r['id']), 'text': r.get('attributes', {}).get('whatsNew')}
                 for r in included if r.get('type') == 'betaBuildLocalizations' and r.get('id') in ids
                 and r.get('attributes', {}).get('locale') == LOCALE), None)


def submit(env, client, receipt, code, text, deadline):
    version, build = env['DSH_VERSION'], env['DSH_BUILD']
    asc.observe(client, version, build, receipt, deadline, 0)
    if not receipt['processing_valid']:
        raise asc.StatusError('The build is not VALID in ASC')
    if receipt['beta_review_state'] == 'REJECTED':
        raise asc.StatusError('Beta App Review rejected this build; it needs a new build')
    build_id, app_id = receipt['build_id'], receipt['app_id']
    group_id = external_group(client, app_id, code)

    current = what_to_test(client, app_id, version, build)
    if current is None:
        write(env, 'POST', '/v1/betaBuildLocalizations', {'data': {
            'type': 'betaBuildLocalizations', 'attributes': {'locale': LOCALE, 'whatsNew': text},
            'relationships': {'build': {'data': {'type': 'builds', 'id': build_id}}}}}, deadline)
    elif current['text'] != text:
        write(env, 'PATCH', '/v1/betaBuildLocalizations/' + current['id'], {'data': {
            'type': 'betaBuildLocalizations', 'id': current['id'], 'attributes': {'whatsNew': text}}}, deadline)
    receipt['what_to_test_set'] = True

    assigned = any(g['id'] == group_id and g['assigned_to_build'] for g in receipt['groups'])
    if not assigned:
        write(env, 'POST', '/v1/betaGroups/' + group_id + '/relationships/builds',
              {'data': [{'type': 'builds', 'id': build_id}]}, deadline)
    receipt['added_to_group'] = not assigned

    if receipt['beta_review_state'] is None:
        write(env, 'POST', '/v1/betaAppReviewSubmissions', {'data': {
            'type': 'betaAppReviewSubmissions',
            'relationships': {'build': {'data': {'type': 'builds', 'id': build_id}}}}}, deadline)
        receipt['submitted'] = True
    else:
        receipt['submitted'] = False

    # Read back what ASC now says.
    asc.observe(client, version, build, receipt, deadline, 0)
    receipt['group_has_build'] = any(g['id'] == group_id and g['assigned_to_build'] for g in receipt['groups'])
    if not receipt['group_has_build'] or receipt['beta_review_state'] is None:
        raise asc.StatusError('ASC does not show the build in the group under Beta App Review')


def run(args):
    receipt = {'schema_version': 1, 'bundle_id': asc.BUNDLE, 'workflow_sha': None, 'version': None, 'build': None,
               'what_to_test_set': False, 'added_to_group': False, 'submitted': False, 'group_has_build': False,
               'observation': 'error'}
    try:
        try:
            testflight_ci.gate()
        except testflight_ci.ConfigurationError:
            raise asc.StatusError('Trusted TestFlight configuration gate failed') from None
        env = dict(os.environ)
        if env.get('DSH_SUBMIT_BETA') != 'true':
            raise asc.StatusError('submit_beta is not set')
        receipt.update(workflow_sha=env['DSH_SOURCE_SHA'], version=env['DSH_VERSION'], build=env['DSH_BUILD'])
        code, text = env.get('DSH_PUBLIC_LINK', ''), env.get('DSH_WHAT_TO_TEST', '').strip()
        if not re.fullmatch(r'[A-Za-z0-9]{4,20}', code):
            raise asc.StatusError('public_link must be the code after https://testflight.apple.com/join/')
        if not 1 <= len(text) <= 4000:
            raise asc.StatusError('what_to_test must be 1 to 4000 characters')
        if (not re.fullmatch('[A-Z0-9]{10}', env.get('ASC_KEY_ID', ''))
                or not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}',
                                    env.get('ASC_ISSUER_ID', '')) or not env.get('ASC_PRIVATE_KEY_P8')):
            raise asc.StatusError('Missing or invalid ASC configuration')
        deadline = time.monotonic() + 300
        submit(env, asc.Client(env, deadline), receipt, code, text, deadline)
        receipt['observation'] = 'complete'
    except asc.StatusError as exc:
        receipt['error'] = str(exc)
        raise
    except Exception:
        receipt['error'] = 'ASC submission failed'
        raise asc.StatusError(receipt['error']) from None
    finally:
        receipt.pop('build_inventory', None)
        Path(args.output).write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    args = parser.parse_args(argv)
    try:
        run(args)
        print('Build added to the public group and under Beta App Review; see the receipt.')
        return 0
    except asc.StatusError as exc:
        print(str(exc))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
