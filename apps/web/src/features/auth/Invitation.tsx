import { useRef, useState, type FormEvent } from 'react';
import { ApiError, request, resource, type InvitationClaim, type Session } from '../../api';
import { commandKey, type CommandIdentity } from '../../command-key';
import { ErrorNotice, Field, Status, formError } from '../../ui';

const initialInvitationToken = location.pathname === '/invite' ? new URLSearchParams(location.hash.slice(1)).get('token') ?? '' : '';
if (location.pathname === '/invite' && location.hash) history.replaceState(null, '', location.pathname);

export function InvitationPage({ session, onSignedIn, navigate }: { session: Session | null; onSignedIn: () => Promise<void>; navigate: (path: string) => void }) {
  const [token, setToken] = useState(initialInvitationToken);
  const [activeSession, setActiveSession] = useState(session);
  const [claim, setClaim] = useState<InvitationClaim | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [switchRequired, setSwitchRequired] = useState(false);
  const claimCommand = useRef<CommandIdentity>(null), signInCommand = useRef<CommandIdentity>(null), signOutCommand = useRef<CommandIdentity>(null), enrollCommand = useRef<CommandIdentity>(null);

  async function exchange() {
    if (!token) return; setPending(true); setError(null);
    try {
      const path = '/api/v1/invitations/claim', body = { token };
      const result = await resource<InvitationClaim>(path, { method: 'POST', csrf: activeSession?.csrf_token, idempotencyKey: commandKey(claimCommand, { path, method: 'POST', principal: activeSession?.user.id ?? 'enrollment', body }), body });
      setClaim(result);
      if (result.status === 'claimed') { setToken(''); await onSignedIn(); if (result.workspace_id) navigate(`/w/${result.workspace_id}/cases`); }
    } catch (cause) { setError(formError(cause)); if (cause instanceof ApiError && cause.code === 'ACCOUNT_SWITCH_REQUIRED') setSwitchRequired(true); } finally { setPending(false); }
  }

  async function switchAccount() {
    setPending(true);
    try {
      const path = '/api/auth/sign-out', body = {};
      await request(path, { method: 'POST', body, idempotencyKey: commandKey(signOutCommand, { path, method: 'POST', principal: activeSession?.user.id, body }) });
      signOutCommand.current = null; setActiveSession(null); setError(null); setShowLogin(true); setSwitchRequired(false); claimCommand.current = null;
      // The private invitation stays in this component while the genuine account changes.
      await onSignedIn();
    } catch (cause) { setError(formError(cause)); } finally { setPending(false); }
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget); setPending(true); setError(null);
    try {
      const path = '/api/auth/sign-in/email', body = { email: String(values.get('email')).trim(), password: String(values.get('password')) };
      await request(path, { method: 'POST', body, idempotencyKey: commandKey(signInCommand, { path, method: 'POST', body }) });
      setActiveSession(await resource<Session>('/api/v1/session'));
      signInCommand.current = null; setShowLogin(false); setClaim(null); setSwitchRequired(false); claimCommand.current = null;
      await onSignedIn();
    } catch (cause) { setError(formError(cause)); } finally { setPending(false); }
  }

  async function enroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!claim?.intended_email) return; const values = new FormData(event.currentTarget); setPending(true); setError(null);
    try {
      const path = '/api/auth/sign-up/email', body = { email: claim.intended_email, name: String(values.get('name')).trim(), password: String(values.get('password')) };
      await request(path, { method: 'POST', body, idempotencyKey: commandKey(enrollCommand, { path, method: 'POST', body }) });
      enrollCommand.current = null;
      setToken(''); await onSignedIn(); navigate(claim.workspace_id ? `/w/${claim.workspace_id}/cases` : '/');
    } catch (cause) { setError(formError(cause)); } finally { setPending(false); }
  }

  return <main className="invite-page"><a className="brand dark-brand" href="/" onClick={event => { event.preventDefault(); navigate('/'); }}><span className="brand-mark" aria-hidden="true">F</span>faultline</a><section className="panel invite-card"><p className="eyebrow">Workspace invite</p><h1>Join your team</h1><ErrorNotice error={error} />{showLogin ? <form onSubmit={signIn}><h2>Sign in to continue</h2><Field label="Invited email"><input name="email" type="email" required maxLength={254} autoComplete="username" defaultValue={claim?.intended_email ?? ''} autoFocus /></Field><Field label="Password"><input name="password" type="password" required autoComplete="current-password" /></Field><div className="form-actions"><button className="secondary" type="button" onClick={() => { setShowLogin(false); setError(null); }} disabled={pending}>Back</button><button className="primary" type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button></div></form> : claim?.status === 'enrollment_required' ? <form onSubmit={enroll}><Status tone="warning">Create your account</Status><p>Use <strong>{claim.intended_email}</strong> to join.</p><Field label="Your name"><input name="name" required maxLength={200} autoComplete="name" autoFocus /></Field><Field label="Password" hint="Use at least 12 characters."><input name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password" required /></Field><button className="primary wide" type="submit" disabled={pending}>{pending ? 'Creating account…' : 'Create account and join'}</button><button className="text-button" type="button" onClick={() => { setShowLogin(true); setError(null); }} disabled={pending}>Already have an account? Sign in</button></form> : token ? <>{activeSession && <p>Signed in as <strong>{activeSession.user.email}</strong>.</p>}{switchRequired ? <div className="notice warning"><strong>Use the invited account</strong><p>Sign out, then sign in with the email address that received this invite.</p><button className="primary" onClick={switchAccount} disabled={pending}>{pending ? 'Signing out…' : 'Switch account'}</button></div> : <><button className="primary" onClick={exchange} disabled={pending}>{pending ? 'Checking invite…' : 'Accept invite'}</button>{!activeSession && <div><button className="text-button" onClick={() => setShowLogin(true)} disabled={pending}>Sign in first</button></div>}</>}</> : claim?.status === 'claimed' ? <p>Invite accepted. Your workspace is ready.</p> : <><p>This invite link is missing or expired. Ask the workspace owner for a new one.</p><button className="secondary" onClick={() => navigate('/')}>Return to Faultline</button></>}</section></main>;
}
