export class JwtError extends Error {}

export interface JwtPayload {
  sub: string;
  aud?: string;
  exp?: number;
}

function decodePart(part: string | undefined): Record<string, unknown> {
  if (!part) {
    throw new JwtError('invalid token structure');
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      throw new JwtError('invalid token body');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof JwtError) {
      throw error;
    }
    throw new JwtError('invalid token encoding');
  }
}

/**
 * Reads the id_token returned straight from Toyota's token endpoint over TLS.
 * Validates alg (rejects "none"), aud and exp. The signature is intentionally
 * not verified (same trade-off as RedLink: no usable JWKS, only `sub` is used).
 */
export function validatedPayload(token: string, expectedAudience: string, nowMs = Date.now()): JwtPayload {
  const parts = token.split('.');
  if (parts.length < 2) {
    throw new JwtError('invalid token structure');
  }
  const header = decodePart(parts[0]);
  const alg = typeof header['alg'] === 'string' ? header['alg'] : '';
  if (alg === '' || alg.toLowerCase() === 'none') {
    throw new JwtError('invalid token algorithm');
  }
  const body = decodePart(parts[1]);
  const aud = typeof body['aud'] === 'string' ? body['aud'] : undefined;
  if (aud !== expectedAudience) {
    throw new JwtError('unexpected token audience');
  }
  const exp = typeof body['exp'] === 'number' ? body['exp'] : undefined;
  if (exp === undefined) {
    throw new JwtError('token has no expiration');
  }
  if (exp * 1000 <= nowMs) {
    throw new JwtError('token expired');
  }
  const sub = typeof body['sub'] === 'string' ? body['sub'] : '';
  if (sub === '') {
    throw new JwtError('token has no subject');
  }
  return { sub, aud, exp };
}

/**
 * The `exp` of a token, in epoch ms, without validating anything. Used only to
 * show how long a sign-in lasts; never to trust a token.
 */
export function expiryMs(token: string): number | undefined {
  try {
    const exp = decodePart(token.split('.')[1])['exp'];
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
