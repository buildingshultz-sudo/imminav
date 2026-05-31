'use strict';
// trial.js - Free-trial + referral plumbing shared by TradeQuote / ImmiNav /
// RuralRoute. Each app drops this file into its own dir and calls:
//
//   const trial = require('./trial');
//   trial.setupTables(db);
//   app.use(trial.sessionMiddleware(db));
//   // ... inside a protected route ...
//   const gate = trial.checkTrial(req, FREE_CAP);
//   if (!gate.allowed) return res.status(402).json(trial.paywallPayload(req, FREE_CAP));
//   // ... do work ...
//   trial.incrementUsage(db, req.session.session_id);
//   trial.tryReferralConversion(db, req.session, REFERRAL_BONUS_DAYS);
//   // ... return success + trial.successExtras(req) ...
//
// Session id = client IP for v1. NAT collisions are accepted -- the user can
// always join the waitlist or refer. UA stored for context but not used to
// disambiguate. Public referral token is a separate short opaque string so we
// never put IPs in URLs.

const crypto = require('crypto');

function setupTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id          TEXT PRIMARY KEY,
      ref_id              TEXT UNIQUE NOT NULL,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      usage_count         INTEGER DEFAULT 0,
      bonus_expires_at    DATETIME,
      referred_by_ref_id  TEXT,
      user_agent          TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_ref_id_idx ON sessions (ref_id);
    CREATE TABLE IF NOT EXISTS referrals (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_ref_id     TEXT NOT NULL,
      referred_session_id TEXT NOT NULL UNIQUE,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      converted_at        DATETIME
    );
    CREATE TABLE IF NOT EXISTS waitlist (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id          TEXT,
      email               TEXT NOT NULL,
      note                TEXT,
      joined_at           DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function _shortRef() {
  return crypto.randomBytes(5).toString('base64url'); // ~7 chars URL-safe
}

function _ipFromReq(req) {
  // x-forwarded-for is set when behind a proxy; first hop is the client.
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.ip || req.socket?.remoteAddress || 'unknown';
}

// Express middleware: ensures a session row exists, attaches req.session.
function sessionMiddleware(db) {
  const findById = db.prepare('SELECT * FROM sessions WHERE session_id = ?');
  const insertRow = db.prepare('INSERT INTO sessions (session_id, ref_id, user_agent) VALUES (?, ?, ?)');
  const findRefById = db.prepare('SELECT * FROM sessions WHERE session_id = ?');
  return (req, res, next) => {
    try {
      const session_id = _ipFromReq(req);
      let row = findById.get(session_id);
      if (!row) {
        let ref_id;
        // Tiny retry loop in case of UNIQUE collision (extremely unlikely)
        for (let i = 0; i < 5; i++) {
          ref_id = _shortRef();
          try { insertRow.run(session_id, ref_id, (req.headers['user-agent'] || '').slice(0, 240)); break; } catch (_) {}
        }
        row = findRefById.get(session_id);
      }
      req.session = row;
    } catch (e) {
      console.error('[trial] sessionMiddleware error:', e.message);
      req.session = { session_id: 'error', ref_id: 'error', usage_count: 0 };
    }
    next();
  };
}

// Returns {allowed, remaining, isBonus, used, cap, bonus_expires_at}.
function checkTrial(req, cap) {
  const s = req.session || { usage_count: 0 };
  const now = Date.now();
  const bonusActive = s.bonus_expires_at && new Date(s.bonus_expires_at).getTime() > now;
  if (bonusActive) {
    return { allowed: true, remaining: Infinity, isBonus: true, used: s.usage_count, cap, bonus_expires_at: s.bonus_expires_at };
  }
  const used = s.usage_count || 0;
  const remaining = Math.max(0, cap - used);
  return { allowed: remaining > 0, remaining, isBonus: false, used, cap, bonus_expires_at: null };
}

function incrementUsage(db, session_id) {
  db.prepare('UPDATE sessions SET usage_count = usage_count + 1 WHERE session_id = ?').run(session_id);
}

// If the request body carries a ref_id AND this session hasn't been credited
// yet AND the ref is valid (and not self-referring), record + (on success)
// grant bonus. Returns { recorded: bool, granted_to_ref_id: string|null }.
function tryReferralConversion(db, session, ref_id_from_request, BONUS_DAYS) {
  try {
    if (!ref_id_from_request || typeof ref_id_from_request !== 'string') return { recorded: false, granted_to_ref_id: null };
    if (!session || !session.session_id) return { recorded: false, granted_to_ref_id: null };
    if (ref_id_from_request === session.ref_id) return { recorded: false, granted_to_ref_id: null }; // self-ref blocked
    const referrer = db.prepare('SELECT session_id, ref_id, bonus_expires_at FROM sessions WHERE ref_id = ?').get(ref_id_from_request);
    if (!referrer) return { recorded: false, granted_to_ref_id: null };
    // Already converted? Skip.
    const existing = db.prepare('SELECT id, converted_at FROM referrals WHERE referred_session_id = ?').get(session.session_id);
    if (existing && existing.converted_at) return { recorded: false, granted_to_ref_id: null };
    if (!existing) {
      db.prepare('INSERT INTO referrals (referrer_ref_id, referred_session_id) VALUES (?, ?)').run(ref_id_from_request, session.session_id);
    }
    // Mark converted + grant bonus to the referrer.
    db.prepare('UPDATE referrals SET converted_at = CURRENT_TIMESTAMP WHERE referred_session_id = ?').run(session.session_id);
    db.prepare('UPDATE sessions SET referred_by_ref_id = ? WHERE session_id = ? AND referred_by_ref_id IS NULL').run(ref_id_from_request, session.session_id);
    // Extend referrer bonus: start at max(now, existing bonus) + BONUS_DAYS.
    const nowMs = Date.now();
    const currentBonusMs = referrer.bonus_expires_at ? new Date(referrer.bonus_expires_at).getTime() : 0;
    const newBonus = new Date(Math.max(nowMs, currentBonusMs) + BONUS_DAYS * 86400000).toISOString();
    db.prepare('UPDATE sessions SET bonus_expires_at = ? WHERE ref_id = ?').run(newBonus, ref_id_from_request);
    return { recorded: true, granted_to_ref_id: ref_id_from_request };
  } catch (e) {
    console.error('[trial] tryReferralConversion error:', e.message);
    return { recorded: false, granted_to_ref_id: null };
  }
}

// Helpers for response shape.
function paywallPayload(req, cap, baseUrl) {
  return {
    ok: false,
    paywall: true,
    used: req.session?.usage_count || cap,
    cap,
    message: `You've used your ${cap} free trial${cap === 1 ? '' : 's'}. Join the waitlist below — early access is on the way.`,
    referral_link: refLink(req, baseUrl),
    waitlist_endpoint: '/waitlist'
  };
}

function successExtras(req, baseUrl, BONUS_DAYS) {
  const s = req.session || {};
  const now = Date.now();
  const bonusActive = s.bonus_expires_at && new Date(s.bonus_expires_at).getTime() > now;
  return {
    referral_link: refLink(req, baseUrl),
    bonus_active: !!bonusActive,
    bonus_expires_at: bonusActive ? s.bonus_expires_at : null,
    referral_reward_days: BONUS_DAYS
  };
}

function refLink(req, baseUrl) {
  const ref = req.session?.ref_id;
  if (!ref) return null;
  const base = baseUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}/?ref=${ref}`;
}

function waitlistInsert(db, session_id, email, note) {
  if (!email || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email)) {
    return { ok: false, error: 'invalid email' };
  }
  const info = db.prepare('INSERT INTO waitlist (session_id, email, note) VALUES (?, ?, ?)').run(session_id || null, email.slice(0, 200), (note || '').slice(0, 500));
  return { ok: true, waitlist_id: info.lastInsertRowid };
}

module.exports = {
  setupTables,
  sessionMiddleware,
  checkTrial,
  incrementUsage,
  tryReferralConversion,
  paywallPayload,
  successExtras,
  refLink,
  waitlistInsert
};
