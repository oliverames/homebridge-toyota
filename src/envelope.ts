import { isObject, str } from './json';

export interface Envelope {
  status?: string;
  message?: string;
  /** `payload` when present, else the whole parsed body. */
  data: unknown;
  raw: unknown;
}

export function parseEnvelope(text: string): Envelope {
  if (text.trim() === '') {
    return { status: 'ok', data: undefined, raw: undefined };
  }
  const raw: unknown = JSON.parse(text);
  const object = isObject(raw) ? raw : undefined;
  const payload = object?.['payload'];
  return {
    status: str(object?.['status']),
    message: str(object?.['message']),
    data: payload ?? (object?.['data'] ?? raw),
    raw,
  };
}

export interface Rejection {
  code?: string;
  message?: string;
}

const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return str(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function isSuccessCode(value: string): boolean {
  const n = normalize(value);
  if (['success', 'successful', 'ok', 'accepted', 'complete', 'completed', 'true'].includes(n)) {
    return true;
  }
  if (n !== '' && /^0+$/.test(n)) {
    return true;
  }
  const numeric = Number(n);
  return Number.isInteger(numeric) && numeric >= 200 && numeric < 300;
}

/**
 * Toyota's success codes are not a closed set (`OSS-001`, `ONE-GLOBAL-RS-10000`
 * accompany "Request Processed successfully"), so an unknown code is a failure
 * only when no accompanying text reports success.
 */
function reportsSuccess(texts: (string | undefined)[]): boolean {
  return texts.some((text) => {
    if (!text) {
      return false;
    }
    const n = normalize(text);
    return n.includes('success') && !n.includes('unsuccess') && !n.includes('notsuccess');
  });
}

const FAILURE_STATUSES = ['error', 'failed', 'failure', 'rejected', 'denied', 'notaccepted', 'nok'];

function rejectionIn(value: unknown, fallback: string | undefined): Rejection | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = rejectionIn(item, fallback);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (!isObject(value)) {
    return undefined;
  }
  const code = scalar(value['returnCode']);
  if (code && !isSuccessCode(code)) {
    const message = scalar(value['message']) ?? scalar(value['description']) ?? fallback;
    if (!reportsSuccess([message])) {
      return { code, message };
    }
  }
  const status = value['status'];
  if (isObject(status) && Array.isArray(status['messages'])) {
    for (const entry of status['messages']) {
      if (!isObject(entry)) {
        continue;
      }
      const responseCode = scalar(entry['responseCode']);
      if (!responseCode || isSuccessCode(responseCode)) {
        continue;
      }
      const detailed = scalar(entry['detailedDescription']);
      const described = scalar(entry['description']);
      if (reportsSuccess([detailed, described])) {
        continue;
      }
      return { code: responseCode, message: detailed ?? described ?? fallback };
    }
  }
  for (const nested of Object.values(value)) {
    const found = rejectionIn(nested, fallback);
    if (found) {
      return found;
    }
  }
  return undefined;
}

export function findRejection(envelope: Envelope): Rejection | undefined {
  if (envelope.status && FAILURE_STATUSES.includes(normalize(envelope.status))) {
    return { code: envelope.status, message: envelope.message };
  }
  return rejectionIn(envelope.raw, envelope.message) ?? rejectionIn(envelope.data, envelope.message);
}
