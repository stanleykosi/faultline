import {demand, DomainError} from '../errors.js';

type Container = {kind: 'object'; keys: Set<string>; keyExpected: boolean} | {kind: 'array'};

/**
 * Lexically inspect already byte-bounded JSON before native parsing can discard
 * duplicate keys. This tracks containers and string tokens only; JSON.parse
 * remains the independent validator for the complete JSON grammar and values.
 * Source keys/values are never included in diagnostics.
 */
export function rejectDuplicateJsonKeys(text: string, maxDepth: number): void {
  const containers: Container[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index], current = containers.at(-1);
    if (char === '"') {
      const start = index++; let escaped = false;
      for (; index < text.length && text[index] !== '"'; index++) {
        if (text[index] === '\\') {escaped = true; index++;} // An escaped quote cannot end the token.
      }
      demand(index < text.length, 'INVALID_JSON', 'Malformed JSON');
      if (current?.kind === 'object' && current.keyExpected) {
        let key: unknown;
        // Ordinary keys require no extra JSON parse per event property. Escaped
        // keys use native decoding; full grammar validation still runs next.
        try {key = escaped ? JSON.parse(text.slice(start, index + 1)) : text.slice(start + 1, index);}
        catch {throw new DomainError('INVALID_JSON', 'Malformed JSON');}
        demand(typeof key === 'string', 'INVALID_JSON', 'Malformed JSON');
        demand(!current.keys.has(key), 'DUPLICATE_JSON_KEY', 'Duplicate JSON object keys cannot be accepted');
        current.keys.add(key); current.keyExpected = false;
      } else {
        demand(containers.length <= maxDepth, 'DEPTH_LIMIT', 'Input exceeds the supported nesting depth');
      }
    } else if (char === '{' || char === '[') {
      demand(containers.length <= maxDepth, 'DEPTH_LIMIT', 'Input exceeds the supported nesting depth');
      containers.push(char === '{' ? {kind: 'object', keys: new Set(), keyExpected: true} : {kind: 'array'});
    } else if (char === '}' || char === ']') {
      demand(current?.kind === (char === '}' ? 'object' : 'array'), 'INVALID_JSON', 'Malformed JSON');
      containers.pop();
    } else if (char === ',') {
      if (current?.kind === 'object') current.keyExpected = true;
    } else if (char !== ':' && char !== ' ' && char !== '\t' && char !== '\r' && char !== '\n') {
      // Primitive values also contribute one level in structural validation.
      demand(containers.length <= maxDepth, 'DEPTH_LIMIT', 'Input exceeds the supported nesting depth');
    }
  }
  demand(containers.length === 0, 'INVALID_JSON', 'Malformed JSON');
}
