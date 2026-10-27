import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, createHmac} from 'node:crypto';
import {DomainError} from '../errors.js';
import {REDACTION_POLICY_VERSION, redactApprovedText, type ApprovedTextRedactionInput} from './redaction.js';

const key = Buffer.alloc(32, 0x73);
const wid = '11111111-1111-4111-8111-111111111111', cid = '22222222-2222-4222-8222-222222222222';
const input = (text: string): ApprovedTextRedactionInput => ({text, workspace_id: wid, case_id: cid, policy_version: REDACTION_POLICY_VERSION, key});
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

test('J022A fixed policy removes independently authored contact and labelled secrets without returning matched plaintext', () => {
  const original = 'Résumé customer customer@example.test\nAuthorization: Bearer low_entropy_123\npassword = "hunter2"; token=abc; api_key: "fixture-key"; Phone: +234 803 123 4567. Checkout failed.';
  const email = '[EMAIL_' + createHmac('sha256', key).update(JSON.stringify(['faultline.redaction.email.v1', REDACTION_POLICY_VERSION, wid, cid, 'customer@example.test'])).digest('hex') + ']';
  const expected = `Résumé customer ${email}\nAuthorization: [REDACTED_SECRET]\npassword = "[REDACTED_SECRET]"; token=[REDACTED_SECRET]; api_key: "[REDACTED_SECRET]"; Phone: [REDACTED_PHONE]. Checkout failed.`;
  const result = redactApprovedText(input(original));
  assert.equal(result.text, expected);
  assert.deepEqual(result.counts, {emails: 1, secrets: 4, phones: 1});
  assert.equal(result.policy_version, 'contact-secrets-v1'); assert.equal(result.pseudonym_scope, 'workspace_case');
  assert.equal(result.input_hash, createHmac('sha256', key).update(JSON.stringify(['faultline.redaction.input.v1', REDACTION_POLICY_VERSION, wid, cid, original])).digest('hex'));
  assert.notEqual(result.input_hash, digest(original)); assert.equal(result.output_hash, digest(expected));
  const receipt = JSON.stringify(result);
  for (const secret of ['customer@example.test', 'low_entropy_123', 'hunter2', 'fixture-key', '+234 803 123 4567']) assert.equal(receipt.includes(secret), false);
  assert.ok(result.limitations.some(value => value.includes('not guaranteed removed')));
  assert.ok(result.limitations.some(value => value.includes('grants no access or declassification authority')));
});

test('opaque exact email joins are stable only under the same workspace, case, policy and retained key', () => {
  const source = input('same@example.test and same@example.test');
  const result = redactApprovedText(source), matches = result.text.match(/\[EMAIL_[a-f0-9]{64}\]/g)!;
  assert.equal(matches.length, 2); assert.equal(matches[0], matches[1]); assert.deepEqual(result.counts, {emails: 2, secrets: 0, phones: 0});
  assert.deepEqual(redactApprovedText(source), result);
  for (const changed of [
    {...source, workspace_id: '33333333-3333-4333-8333-333333333333'},
    {...source, case_id: '44444444-4444-4444-8444-444444444444'},
    {...source, key: Buffer.alloc(32, 0x74)},
  ]) {const other = redactApprovedText(changed); assert.notEqual(other.text, result.text); assert.notEqual(other.input_hash, result.input_hash);}
  assert.notEqual(redactApprovedText(input('Same@example.test')).text, redactApprovedText(input('same@example.test')).text);
  const lowEntropy = redactApprovedText(input('token=1'));
  assert.equal(lowEntropy.text, 'token=[REDACTED_SECRET]'); assert.notEqual(lowEntropy.input_hash, digest('token=1'));
});

test('quoted, newline-separated, bearer, URL credential and recognized API key forms use fixed markers', () => {
  const source = '"api_key" :\n"ab\\\"cd"\naccess-token = \'low value\'\nBearer\r\nshort_secret\nAuthorization = Basic Zml4dHVyZQ==\nhttps://example.test/?token=tiny&ordinary=kept\nsk-abcdefghijklmnop1234\nghp_abcdefghijklmnopqrst1234\npassword="unterminated';
  const result = redactApprovedText(input(source));
  assert.equal(result.text, '"api_key" :\n"[REDACTED_SECRET]"\naccess-token = \'[REDACTED_SECRET]\'\nBearer [REDACTED_SECRET]\nAuthorization = [REDACTED_SECRET]\nhttps://example.test/?token=[REDACTED_SECRET]&ordinary=kept\n[REDACTED_SECRET]\n[REDACTED_SECRET]\npassword="[REDACTED_SECRET]"');
  assert.deepEqual(result.counts, {emails: 0, secrets: 8, phones: 0});
  for (const secret of ['short_secret', 'Zml4dHVyZQ==', 'low value', 'abcdefghijklmnop1234', 'unterminated']) assert.equal(JSON.stringify(result).includes(secret), false);
  const repeated = redactApprovedText(input(result.text));
  assert.equal(repeated.text, result.text); assert.deepEqual(repeated.counts, {emails: 0, secrets: 0, phones: 0});
});

test('finite phone formats are removed while ordinary Unicode, IDs, dates and untrusted instructions remain data', () => {
  const unchanged = 'Checkout café 👩🏾‍💻 成功. Order1234567890 at2026-10-12T10:00:00+01:00; token count4; password reset help; sk-short; email word; contact=user-at-example.test. <script>globalThis.REDACTION_TEST_EXECUTED=true</script>';
  const scope = globalThis as typeof globalThis & {REDACTION_TEST_EXECUTED?: boolean};
  const before = scope.REDACTION_TEST_EXECUTED;
  const safe = redactApprovedText(input(unchanged));
  assert.equal(safe.text, unchanged); assert.deepEqual(safe.counts, {emails: 0, secrets: 0, phones: 0}); assert.equal(scope.REDACTION_TEST_EXECUTED, before);
  const phones = redactApprovedText(input('+234 803 123 4567; (202) 555-0100; 202-555-0101.'));
  assert.equal(phones.text, '[REDACTED_PHONE]; [REDACTED_PHONE]; [REDACTED_PHONE].'); assert.deepEqual(phones.counts, {emails: 0, secrets: 0, phones: 3});
  assert.equal(redactApprovedText(input('token=""; password=\'\'')).text, 'token=""; password=\'\'');
});

test('unsupported policy, unsafe scope/key/text and output expansion block without leaking or truncating input', () => {
  assert.throws(() => redactApprovedText({...input('unchanged'), policy_version: 'owner-review-v1'}), code('REDACTION_POLICY_UNSUPPORTED'));
  assert.throws(() => redactApprovedText({...input('unchanged'), key: Buffer.alloc(31)}), code('REDACTION_KEY_INVALID'));
  for (const scope of [{workspace_id: '../workspace'}, {case_id: 'other-case'}]) assert.throws(() => redactApprovedText({...input('unchanged'), ...scope}), code('REDACTION_SCOPE_INVALID'));
  for (const text of ['', 'x'.repeat(8001), 'unpaired\ud800', 'NUL\0value']) assert.throws(() => redactApprovedText(input(text)), code('REDACTION_TEXT_LIMIT'));
  assert.equal(redactApprovedText(input('x'.repeat(8000))).text, 'x'.repeat(8000));
  assert.throws(() => redactApprovedText(Object.assign(input('unchanged'), {transform: '(source)=>source'})), code('REDACTION_INPUT'));
  assert.throws(() => redactApprovedText(input('a@b.test '.repeat(120))), code('REDACTION_OUTPUT_LIMIT'));
  try {redactApprovedText({...input('DO_NOT_LEAK_ORIGINAL'), policy_version: 'unapproved'}); assert.fail('Unsupported policy must reject.');}
  catch (error) {assert.ok(error instanceof DomainError); assert.equal(JSON.stringify({message: error.message, code: error.code}).includes('DO_NOT_LEAK_ORIGINAL'), false);}
});
