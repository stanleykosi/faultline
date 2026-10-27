import React, { useState, type FormEvent } from 'react';
import { request } from '../../api';
import { ErrorNotice, Field, formError } from '../../ui';

export type AuthMode = 'sign-in' | 'sign-up';

export function signupValidationError(values: { name: string; workspaceName: string; password: string; confirmation: string }): Error | null {
  if (!values.name.trim()) return new Error('Enter your name.');
  if (!values.workspaceName.trim()) return new Error('Enter a workspace name.');
  if (values.password.length < 12) return new Error('Use at least 12 characters for your password.');
  if (values.password !== values.confirmation) return new Error('The password confirmation does not match.');
  return null;
}

export function authSubmission(mode: AuthMode, values: FormData): { path: string; body: Record<string, string> } {
  const email = String(values.get('email') ?? '').trim();
  const password = String(values.get('password') ?? '');
  if (mode === 'sign-in') return { path: '/api/auth/sign-in/email', body: { email, password } };
  const name = String(values.get('name') ?? '').trim();
  const workspaceName = String(values.get('workspace_name') ?? '').trim();
  const validationError = signupValidationError({ name, workspaceName, password, confirmation: String(values.get('password_confirmation') ?? '') });
  if (validationError) throw validationError;
  return { path: '/api/auth/sign-up/email', body: { name, email, password, workspace_name: workspaceName } };
}

function SignInFields() {
  return <><Field label="Email address"><input name="email" type="email" autoComplete="username" required maxLength={254} autoFocus /></Field><Field label="Password"><input name="password" type="password" autoComplete="current-password" required /></Field></>;
}

export function CreateAccountFields() {
  return <><Field label="Your name"><input name="name" autoComplete="name" required maxLength={200} autoFocus /></Field><Field label="Email address"><input name="email" type="email" autoComplete="email" required maxLength={254} /></Field><Field label="Team or project name"><input name="workspace_name" autoComplete="organization" required maxLength={200} /></Field><Field label="Password" hint="Use at least 12 characters."><input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></Field><Field label="Confirm password"><input name="password_confirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></Field></>;
}

export function Login({ onSignedIn, unavailable = false, onRetry }: { onSignedIn: () => Promise<void>; unavailable?: boolean; onRetry?: () => void }) {
  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  function selectMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (unavailable || pending) return;
    const values = new FormData(event.currentTarget);
    let submission: ReturnType<typeof authSubmission>;
    try { submission = authSubmission(mode, values); }
    catch (cause) { setError(formError(cause)); return; }

    setPending(true);
    setError(null);
    try {
      await request(submission.path, { method: 'POST', body: submission.body });
      await onSignedIn();
    } catch (cause) {
      setError(formError(cause));
    } finally {
      setPending(false);
    }
  }

  const signingUp = mode === 'sign-up';
  return <main className="login-page">
    <div className="login-story">
      <a className="brand dark-brand" href="/" aria-label="Faultline home"><span className="brand-mark" aria-hidden="true">F</span>faultline</a>
    </div>
    <div className="login-form-area">
      <form className="login-form" onSubmit={submit}>
        <h2>{signingUp ? 'Create your account' : 'Sign in to Faultline'}</h2>
        <div className="auth-mode-switch" role="group" aria-label="Choose account action">
          <button type="button" className={signingUp ? '' : 'active'} aria-pressed={!signingUp} onClick={() => selectMode('sign-in')} disabled={pending || unavailable}>Sign in</button>
          <button type="button" className={signingUp ? 'active' : ''} aria-pressed={signingUp} onClick={() => selectMode('sign-up')} disabled={pending || unavailable}>Create account</button>
        </div>
        {unavailable && <div className="notice" role="alert"><p>We couldn’t load your account. Try again.</p>{onRetry && <button type="button" onClick={onRetry}>Try again</button>}</div>}
        <ErrorNotice error={error} />
        {signingUp ? <CreateAccountFields /> : <SignInFields />}
        <button className="primary wide" type="submit" disabled={pending || unavailable}>{pending ? (signingUp ? 'Creating account…' : 'Signing in…') : (signingUp ? 'Create account' : 'Sign in')}<span aria-hidden="true">→</span></button>
      </form>
    </div>
  </main>;
}
