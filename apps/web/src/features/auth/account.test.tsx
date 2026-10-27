import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { authSubmission, signupValidationError } from './Login';
describe("Account submission", () => {
    function signupData(change: Record<string, string> = {}) {
        const values = new FormData();
        for (const [key, value] of Object.entries({
            name: 'Ada Lovelace',
            email: ' ada@example.test ',
            workspace_name: ' Analysis Lab ',
            password: 'a secure password',
            password_confirmation: 'a secure password',
            ...change,
        }))
            values.set(key, value);
        return values;
    }
    test("sign-up and sign-in use their exact contracts with normalized identity fields", () => {
        {
            assert.deepEqual(authSubmission('sign-up', signupData()), {
                path: '/api/auth/sign-up/email',
                body: { name: 'Ada Lovelace', email: 'ada@example.test', password: 'a secure password', workspace_name: 'Analysis Lab' },
            });
        }
        {
            const values = new FormData();
            values.set('email', ' owner@example.test ');
            values.set('password', 'existing password');
            assert.deepEqual(authSubmission('sign-in', values), { path: '/api/auth/sign-in/email', body: { email: 'owner@example.test', password: 'existing password' } });
        }
    });
    test('signup validation blocks empty labels, short passwords and confirmation mismatches', () => {
        assert.equal(signupValidationError({ name: ' ', workspaceName: 'Lab', password: 'a secure password', confirmation: 'a secure password' })?.message, 'Enter your name.');
        assert.equal(signupValidationError({ name: 'Ada', workspaceName: ' ', password: 'a secure password', confirmation: 'a secure password' })?.message, 'Enter a workspace name.');
        assert.equal(signupValidationError({ name: 'Ada', workspaceName: 'Lab', password: 'too short', confirmation: 'too short' })?.message, 'Use at least 12 characters for your password.');
        assert.equal(signupValidationError({ name: 'Ada', workspaceName: 'Lab', password: 'a secure password', confirmation: 'different password' })?.message, 'The password confirmation does not match.');
        assert.throws(() => authSubmission('sign-up', signupData({ password_confirmation: 'different password' })), /does not match/);
    });
});
