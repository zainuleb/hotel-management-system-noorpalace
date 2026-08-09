import type { Role, User } from './domain.js';

declare global {
  namespace Express {
    interface Request {
      /** Populated by the session middleware for every authenticated request. */
      user?: Pick<User, 'id' | 'username' | 'full_name' | 'role' | 'must_change_password'> & { role: Role };
      sessionId?: string;
      csrfToken?: string;
      /** One-shot messages carried across a redirect. */
      flash: (type: 'success' | 'error' | 'info', message: string) => void;
    }
  }
}

export {};
