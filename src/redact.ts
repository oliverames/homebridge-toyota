/**
 * Scrubs anything token-like from text that came from Toyota (or from the
 * request we sent) before it reaches a log line or an error message.
 */
export function redact(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted]')
    .replace(
      /("?(?:access_?token|refresh_?token|id_?token|token|api_?key|x-api-key|authorization|password|secret|guid|device_?id)"?\s*[:=]\s*)("[^"]*"|[^\s,;&}]+)/gi,
      '$1"[redacted]"',
    )
    .replace(/\b[A-Z0-9]{13}([A-Z0-9]{4})\b/g, '…$1')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]');
}
