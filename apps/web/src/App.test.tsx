import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Login} from './features/auth/Login';
import {ApiError} from './api';
import {readAccount} from './read-state';

const actions = {onRetry: () => {}, onSignedIn: async () => {}};
const render = (error: Error | null) => renderToStaticMarkup(<Login unavailable={error !== null} {...actions} />);

test('session 503 retains the real sign-in screen, blocks account mutations and offers retry', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({error: {code: 'SERVICE_UNAVAILABLE', message: 'Internal configuration detail'}}, {status: 503});
  try {
    let error: Error | null = null;
    try {await readAccount(new AbortController().signal); assert.fail('Unavailable session must not authenticate.');}
    catch (cause) {assert.ok(cause instanceof ApiError && cause.status === 503); error = cause;}
    const html = render(error);
    assert.match(html, /Sign in to Faultline/);
    assert.match(html, /name="email"/);
    assert.match(html, /name="password"/);
    assert.match(html, /We couldn’t load your account\. Try again\./);
    assert.match(html, /type="button">Try again<\/button>/);
    assert.match(html, /type="submit" disabled=""/);
    assert.match(html, /aria-pressed="false" disabled="">Create account/);
    assert.doesNotMatch(html, /Internal configuration detail|Invalid password|Workspace navigation/);
  } finally {globalThis.fetch = original;}
});

test('retry receiving an ordinary unsigned-in 401 restores usable sign-in and account creation', async () => {
  const original = globalThis.fetch;
  const attempts: number[] = [];
  globalThis.fetch = async () => {
    const status = attempts.length < 2 ? 503 : 401;
    attempts.push(status);
    return Response.json({error: {code: status === 401 ? 'UNAUTHENTICATED' : 'SERVICE_UNAVAILABLE', message: 'Unavailable'}}, {status});
  };
  try {
    for (const expectedStatus of [503, 401]) {
      let error: Error | null = null;
      try {await readAccount(new AbortController().signal); assert.fail('No response contains an authenticated account.');}
      catch (cause) {assert.ok(cause instanceof ApiError); assert.equal(cause.status, expectedStatus); if (cause.status !== 401) error = cause;}
      const html = render(error);
      assert.match(html, /Sign in to Faultline/);
      if (expectedStatus === 503) assert.match(html, /type="submit" disabled=""/);
      else {
        assert.doesNotMatch(html, /temporarily unavailable|type="submit" disabled=""/);
        assert.match(html, /aria-pressed="false">Create account/);
      }
    }
    assert.deepEqual(attempts, [503, 503, 401, 401]);
  } finally {globalThis.fetch = original;}
});

test('a network failure keeps authentication unavailable without exposing transport details', () => {
  const html = render(new TypeError('fetch failed at private host'));
  assert.match(html, /Sign in to Faultline/);
  assert.match(html, /type="submit" disabled=""/);
  assert.doesNotMatch(html, /private host/);
});
