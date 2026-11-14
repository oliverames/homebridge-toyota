import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Session {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  guid: string;
  deviceId: string;
  username: string;
}

/** Refresh when the access token has 5 minutes or less left (matches RedLink). */
export const REFRESH_LEEWAY_MS = 5 * 60 * 1000;

export function requiresRefresh(session: Session, nowMs = Date.now(), leewayMs = REFRESH_LEEWAY_MS): boolean {
  return session.expiresAt - nowMs <= leewayMs;
}

export function newDeviceId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v['accessToken'] === 'string' &&
    typeof v['refreshToken'] === 'string' &&
    typeof v['idToken'] === 'string' &&
    typeof v['expiresAt'] === 'number' &&
    typeof v['guid'] === 'string' &&
    typeof v['deviceId'] === 'string' &&
    typeof v['username'] === 'string'
  );
}

/** Small JSON file store, mode 0600, written atomically. */
export class FileStore<T> {
  constructor(
    private readonly path: string,
    private readonly validate: (value: unknown) => value is T,
  ) {}

  load(): T | undefined {
    try {
      if (!existsSync(this.path)) {
        return undefined;
      }
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      return this.validate(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  save(value: T): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  clear(): void {
    try {
      unlinkSync(this.path);
    } catch {
      // already gone
    }
  }
}
