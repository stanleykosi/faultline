export type CommandIdentity = { bodyCanonical: string; key: string } | null;

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  throw new Error('A command requires a finite JSON intent.');
}

/** Keep an uncertain command's identity until its safe result arrives or its reviewed intent changes. */
export function commandKey(reference: { current: CommandIdentity }, intent: unknown): string {
  const bodyCanonical = canonical(intent);
  if (!reference.current || reference.current.bodyCanonical !== bodyCanonical) reference.current = { bodyCanonical, key: crypto.randomUUID() };
  return reference.current.key;
}
