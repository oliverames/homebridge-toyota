import { describe, expect, it } from 'vitest';
import { findRejection, parseEnvelope } from '../src/envelope';

const rejection = (value: unknown) => findRejection(parseEnvelope(JSON.stringify(value)));

describe('envelope', () => {
  it('unwraps payload, data, or the whole body', () => {
    expect(parseEnvelope('{"payload":{"a":1}}').data).toEqual({ a: 1 });
    expect(parseEnvelope('{"data":{"a":2}}').data).toEqual({ a: 2 });
    expect(parseEnvelope('[1]').data).toEqual([1]);
    expect(parseEnvelope('').data).toBeUndefined();
  });
  it('treats Toyota success codes with success text as success', () => {
    expect(rejection({ payload: { returnCode: 'OSS-001', message: 'Request Processed successfully' } })).toBeUndefined();
    expect(rejection({ status: { messages: [{ responseCode: 'ONE-GLOBAL-RS-10000', description: 'Request processed successfully' }] } })).toBeUndefined();
    expect(rejection({ payload: { returnCode: '000000' } })).toBeUndefined();
    expect(rejection({ payload: { returnCode: 200 } })).toBeUndefined();
  });
  it('surfaces real rejections', () => {
    expect(rejection({ payload: { returnCode: 'VEHICLE_MOVING', message: 'Vehicle is moving' } })).toEqual({ code: 'VEHICLE_MOVING', message: 'Vehicle is moving' });
    expect(rejection({ status: 'ERROR', message: 'nope' })).toEqual({ code: 'ERROR', message: 'nope' });
    expect(rejection({ status: { messages: [{ responseCode: 'APIGW-403', description: 'Unauthorized' }] } })?.code).toBe('APIGW-403');
  });
  it('"unsuccessful" is not success', () => {
    expect(rejection({ payload: { returnCode: 'X-1', message: 'Request unsuccessful' } })?.code).toBe('X-1');
  });
});
