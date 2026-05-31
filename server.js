'use strict';
// ImmiNav — Express + Claude. Immigrant entrepreneur asks a compliance / business
// question, gets plain-language guidance + next steps. Every response carries
// the explicit "not legal advice" disclaimer.
require('dotenv').config({ path: '/root/solomon-v4/.env' });
require('dotenv').config();

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

const PORT  = parseInt(process.env.IMMINAV_PORT || '4002', 10);
const MODEL = process.env.IN_MODEL || 'claude-sonnet-4-6';
const VERSION = '0.1.0';
const APP_NAME = 'imminav';
const STARTED_AT = Date.now();
const DISCLAIMER = 'This is general guidance, not legal advice. Consult a qualified attorney for your specific situation.';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[FATAL] ANTHROPIC_API_KEY not set. Check /root/solomon-v4/.env');
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ ok: true, app: APP_NAME, version: VERSION, uptime: Math.round((Date.now() - STARTED_AT) / 1000) });
});

app.post('/ask', async (req, res) => {
  const question = (req.body && req.body.question || '').trim();
  if (!question) return res.status(400).json({ ok: false, error: 'question required', disclaimer: DISCLAIMER });
  if (question.length > 3000) return res.status(400).json({ ok: false, error: 'question too long (max 3000 chars)', disclaimer: DISCLAIMER });
  const country_of_origin = req.body.country_of_origin || null;
  const us_state          = req.body.us_state || null;
  const business_type     = req.body.business_type || null;
  const stage             = req.body.stage || null; // researching | filed-llc | operating | scaling

  const system =
`You are ImmiNav, a plain-language compliance + business-formation explainer for immigrant entrepreneurs in the United States. Your audience may be working in English as a second language. Voice: clear, kind, respectful, no jargon (define every acronym the first time you use it). NEVER claim to give legal advice — you give general guidance and point the user to the right professional.

Return ONLY compact JSON, no preamble, no markdown:
{
  "answer": string,                       // plain-language, 1-3 short paragraphs
  "next_steps": [string, ...],            // 3-6 concrete actions the person can take this week
  "key_terms": [{"term": string, "plain_meaning": string}, ...],  // anything jargony in your answer
  "documents_or_forms": [string, ...],    // e.g. "IRS Form SS-4 (EIN application)", "Indiana INBiz Articles of Organization"
  "when_to_get_a_lawyer": string,         // 1-2 sentences on the trigger conditions
  "confidence": "high"|"medium"|"low",    // your confidence the answer is correct + applicable
  "scope_caveats": [string, ...]          // any place where the answer narrows or breaks (state-specific, visa-status-specific, etc.)
}

If the question touches an area where outcomes vary a lot by visa status, state, or recent regulatory change, set confidence to "low" or "medium" and explicitly recommend a licensed immigration attorney or business attorney in scope_caveats. Never invent specific filing fees that you cannot verify with high confidence — use ranges and say "current fee varies, check the official site".`;

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
    if (!m) {
      return res.status(502).json({ ok: false, error: 'model did not return JSON', raw: text.slice(0, 400), disclaimer: DISCLAIMER });
    }
    let result;
    try { result = JSON.parse(m[0]); }
    catch (e) { return res.status(502).json({ ok: false, error: 'JSON parse failed: ' + e.message, raw: m[0].slice(0, 400), disclaimer: DISCLAIMER }); }

    return res.json({
      ok: true,
      app: APP_NAME,
      model: MODEL,
      duration_ms: Date.now() - t0,
      input_tokens: resp.usage && resp.usage.input_tokens,
      output_tokens: resp.usage && resp.usage.output_tokens,
      disclaimer: DISCLAIMER,
      ...result
    });
  } catch (err) {
    const detail = err.response && err.response.data || err.message || String(err);
    console.error('[POST /ask] error:', detail);
    return res.status(500).json({ ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400), disclaimer: DISCLAIMER });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${APP_NAME}] v${VERSION} listening on 0.0.0.0:${PORT}  model=${MODEL}`);
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
