import { useState } from 'react';
import type { WizardStepProps } from './types';

/** External Evalution Cloud auth pages, opened in a new tab. */
const SIGNUP_URL = 'https://evalut.io/signup';
const FORGOT_LOGIN_URL = 'https://evalut.io/forgot';

/**
 * Stubbed login screen for Evalution Cloud.
 *
 * The form is intentionally non-functional for now: submitting (or skipping)
 * simply advances the wizard. Sign-up and account-recovery live on the web, so
 * those links open evalut.io in a new tab. Wire the form to a real auth backend
 * later.
 */
export function LoginStep({ onNext }: WizardStepProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // TODO: authenticate against Evalution Cloud. For now, just continue.
    onNext();
  };

  return (
    <div className="welcome-login">
      <h2>Log in to Evalution Cloud</h2>
      <p className="welcome-subtitle">
        Sync prompts, traces, and evals across your team — or skip and stay fully local.
      </p>

      <form onSubmit={handleSubmit}>
        <label className="welcome-field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
          />
        </label>
        <label className="welcome-field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
          />
        </label>

        <a className="welcome-link welcome-forgot" href={FORGOT_LOGIN_URL} target="_blank">
          Forgot your login?
        </a>

        <button type="submit" className="welcome-btn-primary">
          Log in
        </button>
      </form>

      <div className="welcome-login-footer">
        <a className="welcome-link" href={SIGNUP_URL} target="_blank" rel="noreferrer">
          Need an account? Sign up
        </a>
        <button type="button" className="welcome-skip" onClick={onNext}>
          Skip for now →
        </button>
      </div>
    </div>
  );
}
