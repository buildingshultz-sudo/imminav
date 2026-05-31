'use strict';
// ImmiNav -- Express + Claude + free-trial/referral via shared trial.js.
// Plain-language compliance + business-formation guidance for immigrant
// entrepreneurs. Always disclaims as not-legal-advice.
require('dotenv').config({ path: '/root/solomon-v4/.env' });
require('dotenv').config();

const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const trial = require('./trial');

const PORT  = parseInt(process.env.IMMINAV_PORT || '4002', 10);
const MODEL = process.env.IN_MODEL || 'claude-sonnet-4-6';
const VERSION = '0.2.0';
const APP_NAME = 'imminav';
const STARTED_AT = Date.now();
const DB_PATH = process.env.IN_DB || path.join(__dirname, 'imminav.db');
const FREE_CAP = 3;
const REFERRAL_BONUS_DAYS = 7;
const DISCLAIMER = 'This is general guidance, not legal advice. Consult a qualified attorney for your specific situation.';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[FATAL] ANTHROPIC_API_KEY not set. Check /root/solomon-v4/.env');
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── DB SETUP ─────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
trial.setupTables(db);
console.log('[' + APP_NAME + '] DB ready at', DB_PATH);

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(trial.sessionMiddleware(db));

app.get('/health', (req, res) => {
  let sessions = 0, waitlist = 0;
  try { sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n; } catch (_) {}
  try { waitlist = db.prepare('SELECT COUNT(*) AS n FROM waitlist').get().n; } catch (_) {}
  res.json({ ok: true, app: APP_NAME, version: VERSION, uptime: Math.round((Date.now() - STARTED_AT) / 1000), sessions, waitlist, free_cap: FREE_CAP });
});

app.get('/me', (req, res) => {
  const gate = trial.checkTrial(req, FREE_CAP);
  res.json({
    ok: true,
    session_id: req.session.session_id,
    ref_id: req.session.ref_id,
    referral_link: trial.refLink(req),
    used: gate.used,
    cap: gate.cap,
    remaining: gate.remaining === Infinity ? 'unlimited' : gate.remaining,
    bonus_active: gate.isBonus,
    bonus_expires_at: gate.bonus_expires_at
  });
});

app.post('/ask', async (req, res) => {
  const question = (req.body && req.body.question || '').trim();
  if (!question) return res.status(400).json({ ok: false, error: 'question required', disclaimer: DISCLAIMER });
  if (question.length > 3000) return res.status(400).json({ ok: false, error: 'question too long (max 3000 chars)', disclaimer: DISCLAIMER });

  // ── Free trial gate ──
  const gate = trial.checkTrial(req, FREE_CAP);
  if (!gate.allowed) {
    const payload = trial.paywallPayload(req, FREE_CAP);
    payload.disclaimer = DISCLAIMER;
    return res.status(402).json(payload);
  }

  const country_of_origin = req.body.country_of_origin || null;
  const us_state          = req.body.us_state || null;
  const business_type     = req.body.business_type || null;
  const stage             = req.body.stage || null;

  const system =
`You are ImmiNav, a plain-language compliance + business-formation explainer for immigrant entrepreneurs in the United States. Your audience may be working in English as a second language. Voice: clear, kind, respectful, no jargon (define every acronym the first time you use it). NEVER claim to give legal advice -- you give general guidance and point the user to the right professional.

Return ONLY compact JSON, no preamble, no markdown:
{
  "answer": string,
  "next_steps": [string, ...],
  "key_terms": [{"term": string, "plain_meaning": string}, ...],
  "documents_or_forms": [string, ...],
  "when_to_get_a_lawyer": string,
  "confidence": "high"|"medium"|"low",
  "scope_caveats": [string, ...]
}

If the question touches an area where outcomes vary a lot by visa status, state, or recent regulatory change, set confidence to "low" or "medium" and explicitly recommend a licensed immigration attorney or business attorney in scope_caveats. Never invent specific filing fees that you cannot verify with high confidence -- use ranges and say "current fee varies, check the official site".`;

  try {
    const t0 = Date.now();
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system,
      messages: [{
        role: 'user',
        content: JSON.stringify({ question, country_of_origin, us_state, business_type, stage })
      }]
    });
    const text = (resp.content.find(b => b.type === 'text') || {}).text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(502).json({ ok: false, error: 'model did not return JSON', raw: text.slice(0, 400), disclaimer: DISCLAIMER });
    let result;
    try { result = JSON.parse(m[0]); }
    catch (e) { return res.status(502).json({ ok: false, error: 'JSON parse failed: ' + e.message, raw: m[0].slice(0, 400), disclaimer: DISCLAIMER }); }

    // ── Bookkeeping on success ──
    trial.incrementUsage(db, req.session.session_id);
    const refConv = trial.tryReferralConversion(db, req.session, req.body.ref_id, REFERRAL_BONUS_DAYS);
    req.session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(req.session.session_id);
    const extrasOut = trial.successExtras(req, null, REFERRAL_BONUS_DAYS);

    return res.json({
      ok: true,
      app: APP_NAME,
      model: MODEL,
      duration_ms: Date.now() - t0,
      input_tokens: resp.usage && resp.usage.input_tokens,
      output_tokens: resp.usage && resp.usage.output_tokens,
      used: req.session.usage_count,
      cap: FREE_CAP,
      remaining: extrasOut.bonus_active ? 'unlimited' : Math.max(0, FREE_CAP - req.session.usage_count),
      disclaimer: DISCLAIMER,
      ...extrasOut,
      referral_conversion: refConv,
      ...result
    });
  } catch (err) {
    const detail = err.response && err.response.data || err.message || String(err);
    console.error('[POST /ask] error:', detail);
    return res.status(500).json({ ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400), disclaimer: DISCLAIMER });
  }
});

app.post('/waitlist', (req, res) => {
  const out = trial.waitlistInsert(db, req.session?.session_id, (req.body && req.body.email) || '', (req.body && req.body.note) || '');
  if (!out.ok) return res.status(400).json(out);
  return res.json({ ok: true, waitlist_id: out.waitlist_id, message: "You're on the list. We'll email when access opens." });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${APP_NAME}] v${VERSION} listening on 0.0.0.0:${PORT}  model=${MODEL}  db=${DB_PATH}  free_cap=${FREE_CAP}`);
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
