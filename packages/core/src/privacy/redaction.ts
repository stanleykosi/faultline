import {createHmac} from 'node:crypto';
import {byteHash, canonical} from '../canonical.js';
import {demand} from '../errors.js';

export const REDACTION_POLICY_VERSION = 'contact-secrets-v1';
export interface ApprovedTextRedactionInput {
  text: string;
  workspace_id: string;
  case_id: string;
  policy_version: string;
  key: Buffer;
}
export interface ApprovedTextRedactionResult {
  text: string;
  input_hash: string;
  output_hash: string;
  policy_version: string;
  counts: {emails: number; secrets: number; phones: number};
  pseudonym_scope: 'workspace_case';
  limitations: string[];
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const inputKeys = new Set(['text', 'workspace_id', 'case_id', 'policy_version', 'key']);
const secretMarker = '[REDACTED_SECRET]', phoneMarker = '[REDACTED_PHONE]';

/**
 * Fixed text policy only. The caller owns approval, retained key version, access,
 * immutable publication and declassification; this function establishes none.
 * Hash domains separate contact pseudonyms from the keyed original-text binding.
 */
export function redactApprovedText(input: ApprovedTextRedactionInput): ApprovedTextRedactionResult {
  demand(input && typeof input === 'object' && Object.keys(input).every(key => inputKeys.has(key)), 'REDACTION_INPUT', 'Use only the finite text redaction fields.');
  demand(input.policy_version === REDACTION_POLICY_VERSION, 'REDACTION_POLICY_UNSUPPORTED', 'Select the supported owner-approved finite policy before requesting redaction.', 409);
  demand(Buffer.isBuffer(input.key) && input.key.length === 32, 'REDACTION_KEY_INVALID', 'Redaction requires a retained 32-byte policy key.', 503);
  demand(typeof input.workspace_id === 'string' && uuid.test(input.workspace_id) && typeof input.case_id === 'string' && uuid.test(input.case_id), 'REDACTION_SCOPE_INVALID', 'Redaction requires exact workspace and investigation identities.');
  demand(typeof input.text === 'string' && input.text.length > 0 && input.text.length <= 8000 && Buffer.from(input.text, 'utf8').toString('utf8') === input.text && !input.text.includes('\0'), 'REDACTION_TEXT_LIMIT', 'Redaction requires nonempty well-formed text bounded to 8000 characters without NUL.');
  const scope = [REDACTION_POLICY_VERSION, input.workspace_id.toLowerCase(), input.case_id.toLowerCase()];
  const input_hash = createHmac('sha256', input.key).update(canonical(['faultline.redaction.input.v1', ...scope, input.text])).digest('hex');
  const counts = {emails: 0, secrets: 0, phones: 0};
  let text = input.text;
  // Quoted values preserve their framing. Separators can span lines, but labels
  // and recognized credential families remain fixed; no caller regex is used.
  const label = '(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|client[_ -]?secret|authorization|password|passwd|secret|token)';
  const assignments = new RegExp('(\\b' + label + '\\b["\']?[ \\t\\r\\n]{0,32}[:=][ \\t\\r\\n]{0,32})("(?:\\\\[\\s\\S]|[^"\\\\])*(?:"|$)|\'(?:\\\\[\\s\\S]|[^\'\\\\])*(?:\'|$)|(?:Bearer|Basic)[ \\t\\r\\n]{1,32}[A-Za-z0-9._~+/-]+={0,8}|\\[REDACTED_SECRET\\]|[^\\s,;}\\]\\)"\'&<>]+)', 'gi');
  text = text.replace(assignments, (_match: string, prefix: string, value: string) => {
    if ([secretMarker, '"' + secretMarker + '"', "'" + secretMarker + "'", '""', "''"].includes(value)) return _match;
    counts.secrets++;
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
    return prefix + quote + secretMarker + quote;
  });
  text = text.replace(/\bBearer[ \t\r\n]{1,32}[A-Za-z0-9._~+/-]+={0,8}/gi, () => {counts.secrets++; return 'Bearer ' + secretMarker;});
  text = text.replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,512}|gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{22,255}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g, () => {counts.secrets++; return secretMarker;});
  text = text.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?){1,126}/gi, (email: string) => {
    counts.emails++;
    return '[EMAIL_' + createHmac('sha256', input.key).update(canonical(['faultline.redaction.email.v1', ...scope, email])).digest('hex') + ']';
  });
  // Explicit international numbers (7..15 digits), formatted ten-digit phone
  // numbers, and parenthesized area codes. Bare numeric IDs/dates are retained.
  text = text.replace(/(?<![A-Za-z0-9_])\+[0-9](?:[ .()\t-]{0,3}[0-9]){6,14}(?![ .()\t-]*[0-9])|(?<![A-Za-z0-9_])\([2-9][0-9]{2}\)[ \t.-]?[0-9]{3}[ .-][0-9]{4}(?![0-9])|\b[2-9][0-9]{2}[ .-][0-9]{3}[ .-][0-9]{4}\b/g, () => {counts.phones++; return phoneMarker;});
  demand(text.length <= 8000, 'REDACTION_OUTPUT_LIMIT', 'Redacted text exceeds the finite evidence limit; select a smaller excerpt before review.');
  return {
    text, input_hash, output_hash: byteHash(text), policy_version: REDACTION_POLICY_VERSION, counts, pseudonym_scope: 'workspace_case',
    limitations: [
      'Only the selected owner-approved finite contact/credential text policy was applied; this result grants no access or declassification authority.',
      'Unknown PII, unlabelled credentials, encoded secrets, uncommon contact forms and arbitrary free text are not guaranteed removed. Review the exact minimized excerpt before shared or model use.',
      'Contact pseudonyms join only exact matched email text within this workspace and investigation under the retained policy key; they do not establish a person identity.',
      'Original-text binding uses a keyed HMAC; the caller must retain and pin its key version. Output hash is SHA256 of the exact redacted UTF8 bytes.',
    ],
  };
}
