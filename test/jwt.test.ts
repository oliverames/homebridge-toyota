import { describe, expect, it } from 'vitest';
import { JwtError, validatedPayload } from '../src/jwt';
import { makeJwt } from './helpers';

const NOW = 1_800_000_000_000;
const good = { sub: 'g', aud: 'oneappsdkclient', exp: NOW / 1000 + 60 };

describe('validatedPayload', () => {
  it('accepts a well-formed token', () => {
    expect(validatedPayload(makeJwt(good), 'oneappsdkclient', NOW).sub).toBe('g');
  });
  it('rejects alg none', () => {
    expect(() => validatedPayload(makeJwt(good, { alg: 'none' }), 'oneappsdkclient', NOW)).toThrow(JwtError);
  });
  it('rejects the wrong audience', () => {
    expect(() => validatedPayload(makeJwt({ ...good, aud: 'other' }), 'oneappsdkclient', NOW)).toThrow(/audience/);
  });
  it('rejects expired and exp-less tokens', () => {
    expect(() => validatedPayload(makeJwt({ ...good, exp: NOW / 1000 - 1 }), 'oneappsdkclient', NOW)).toThrow(/expired/);
    expect(() => validatedPayload(makeJwt({ sub: 'g', aud: 'oneappsdkclient' }), 'oneappsdkclient', NOW)).toThrow(/expiration/);
  });
  it('rejects a missing subject and garbage', () => {
    expect(() => validatedPayload(makeJwt({ ...good, sub: '' }), 'oneappsdkclient', NOW)).toThrow(/subject/);
    expect(() => validatedPayload('nope', 'oneappsdkclient', NOW)).toThrow(JwtError);
  });
});
