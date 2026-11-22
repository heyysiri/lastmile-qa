import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunnerError } from './store';

/** Installation-scoped credentials, separate from projects, snapshots and model context. */
export function createGitHubCredentials(options: { directory: string; fallback?: string; fetch?: typeof fetch }) {
  const tokenPath = join(options.directory, 'github.enc');
  const keyPath = join(options.directory, 'key');
  let saved: string | undefined;
  if (existsSync(tokenPath)) {
    const bytes = readFileSync(tokenPath);
    const decipher = createDecipheriv('aes-256-gcm', readFileSync(keyPath), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    saved = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
  const status = () => ({ configured: Boolean(saved || options.fallback), source: saved ? 'saved' as const : options.fallback ? 'environment' as const : 'none' as const });
  return {
    status,
    token() {
      const token = saved || options.fallback;
      if (!token) throw new Error('Save a GitHub personal access token in project Setup before connecting.');
      return token;
    },
    async save(value: unknown) {
      if (typeof value !== 'string' || !/^[\x21-\x7e]{1,1000}$/.test(value)) throw new RunnerError(400, 'validation', 'Enter a valid GitHub personal access token.');
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)('https://api.github.com/user', {
          headers: { authorization: `Bearer ${value}`, accept: 'application/vnd.github+json' },
          redirect: 'error', signal: AbortSignal.timeout(8000),
        });
        await response.body?.cancel();
      } catch { throw new RunnerError(502, 'github_unavailable', 'Could not validate the token with GitHub. Your previous token is unchanged.'); }
      if (response.status === 401) throw new RunnerError(400, 'github_auth', 'GitHub rejected this token. Check that it is valid and has not expired.');
      if (!response.ok) throw new RunnerError(502, 'github_unavailable', 'Could not validate the token with GitHub. Your previous token is unchanged.');
      mkdirSync(options.directory, { recursive: true, mode: 0o700 });
      chmodSync(options.directory, 0o700);
      if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', readFileSync(keyPath), iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      const temporary = `${tokenPath}.${randomUUID()}`;
      try {
        writeFileSync(temporary, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, tokenPath);
      } finally { rmSync(temporary, { force: true }); }
      saved = value;
      return status();
    },
  };
}
export type GitHubCredentials = ReturnType<typeof createGitHubCredentials>;
