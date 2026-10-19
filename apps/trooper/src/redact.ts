const TOKEN_SHAPES = [/gh[pousr]_[A-Za-z0-9]{20,}/g, /sk-ant-[A-Za-z0-9_-]{20,}/g];

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redact(text: string, secrets: string[]): string {
  let out = text;
  // Longest first so a secret containing another secret is replaced whole.
  const known = secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  for (const s of known) out = out.replace(new RegExp(escapeRegExp(s), 'g'), '[REDACTED]');
  for (const re of TOKEN_SHAPES) out = out.replace(re, '[REDACTED]');
  return out;
}
