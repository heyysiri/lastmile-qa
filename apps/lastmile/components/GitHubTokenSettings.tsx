'use client';

import { useEffect, useState } from 'react';
import { api, type GitHubCredentialStatus } from '../lib/api';
import { StudioError } from './Studio';

export function GitHubTokenSettings() {
  const [status, setStatus] = useState<GitHubCredentialStatus>();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let mounted = true;
    api.githubCredentials().then(value => { if (mounted) setStatus(value); }, problem => { if (mounted) setError(problem); });
    return () => { mounted = false; };
  }, []);

  async function save() {
    if (busy || !token.trim()) return;
    setBusy(true); setError(null);
    try { setStatus(await api.saveGitHubCredentials(token.trim())); setToken(''); }
    catch (problem) { setError(problem); }
    finally { setBusy(false); }
  }

  return <section aria-label="GitHub access">
    <h3>GitHub access</h3>
    <p className="field-hint" role="status">{status?.configured
      ? status.source === 'saved' ? 'GitHub token saved for this installation.' : 'GitHub access is already configured on the server.'
      : status ? 'Save a token once to clone, sync, and open pull requests.' : 'Checking GitHub access…'}</p>
    <label className="field"><span>GitHub personal access token</span>
      <input type="password" autoComplete="new-password" spellCheck={false} maxLength={1000}
        value={token} disabled={busy} placeholder={status?.configured ? 'Paste a new token to replace it' : 'Paste your token'}
        onChange={event => setToken(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void save(); } }} />
    </label>
    <p className="field-hint">Stored encrypted on the server. Choose your repository and allow Contents and Pull requests read/write. Repository permissions are checked when used. <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Create a token</a></p>
    <button type="button" className="secondary" disabled={busy || !token.trim()} onClick={() => void save()}>{busy ? 'Saving token…' : status?.configured ? 'Replace token' : 'Save token'}</button>
    <StudioError error={error} />
  </section>;
}
