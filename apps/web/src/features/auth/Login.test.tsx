import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authSubmission, CreateAccountFields, Login, signupValidationError } from './Login';

function signupData(change: Record<string, string> = {}) {
  const values = new FormData();
  for (const [key, value] of Object.entries({
    name: 'Ada Lovelace',
    email: ' ada@example.test ',
    workspace_name: ' Analysis Lab ',
    password: 'a secure password',
    password_confirmation: 'a secure password',
    ...change,
  })) values.set(key, value);
  return values;
}

test('public login exposes both account actions while retaining the sign-in form', () => {
  const rendered = renderToStaticMarkup(<Login onSignedIn={async () => {}} />);
  assert.match(rendered, /aria-label="Choose account action"/);
  assert.match(rendered, /aria-pressed="true"[^>]*>Sign in/);
  assert.match(rendered, /aria-pressed="false"[^>]*>Create account/);
  assert.match(rendered, /<input(?=[^>]*name="email")(?=[^>]*autoComplete="username")[^>]*>/);
  assert.match(rendered, /<input(?=[^>]*name="password")(?=[^>]*autoComplete="current-password")[^>]*>/);
});

test('create-account fields require identity, workspace and confirmed 12-character password', () => {
  const rendered = renderToStaticMarkup(<form><CreateAccountFields /></form>);
  for (const name of ['name', 'email', 'workspace_name', 'password', 'password_confirmation']) assert.match(rendered, new RegExp(`<input(?=[^>]*name="${name}")(?=[^>]*required)[^>]*>`));
  assert.equal((rendered.match(/minLength="12"/g) ?? []).length, 2);
  assert.match(rendered, /Use at least 12 characters/);
});

test('signup submission uses the public Better Auth contract and trims identity labels', () => {
  assert.deepEqual(authSubmission('sign-up', signupData()), {
    path: '/api/auth/sign-up/email',
    body: { name: 'Ada Lovelace', email: 'ada@example.test', password: 'a secure password', workspace_name: 'Analysis Lab' },
  });
});

test('sign-in submission remains on the existing endpoint', () => {
  const values = new FormData(); values.set('email', ' owner@example.test '); values.set('password', 'existing password');
  assert.deepEqual(authSubmission('sign-in', values), { path: '/api/auth/sign-in/email', body: { email: 'owner@example.test', password: 'existing password' } });
});

test('signup validation blocks empty labels, short passwords and confirmation mismatches', () => {
  assert.equal(signupValidationError({ name: ' ', workspaceName: 'Lab', password: 'a secure password', confirmation: 'a secure password' })?.message, 'Enter your name.');
  assert.equal(signupValidationError({ name: 'Ada', workspaceName: ' ', password: 'a secure password', confirmation: 'a secure password' })?.message, 'Enter a workspace name.');
  assert.equal(signupValidationError({ name: 'Ada', workspaceName: 'Lab', password: 'too short', confirmation: 'too short' })?.message, 'Use at least 12 characters for your password.');
  assert.equal(signupValidationError({ name: 'Ada', workspaceName: 'Lab', password: 'a secure password', confirmation: 'different password' })?.message, 'The password confirmation does not match.');
  assert.throws(() => authSubmission('sign-up', signupData({ password_confirmation: 'different password' })), /does not match/);
});
