import crypto from 'crypto';

const SESSION_TTL = parseInt(process.env.SESSION_TTL_HOURS || '24', 10) * 60 * 60 * 1000;

// In-memory session store: sessionId -> { expiresAt }
const sessions = new Map();

export function createSession() {
  const sessionId = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionId, { expiresAt: Date.now() + SESSION_TTL });
  return sessionId;
}

export function validateSession(sessionId) {
  if (!sessionId) return false;
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}

export function deleteSession(sessionId) {
  if (sessionId) sessions.delete(sessionId);
}

// Periodically remove expired sessions (every hour)
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(id);
  }
}, 60 * 60 * 1000).unref();

export default { createSession, validateSession, deleteSession };
