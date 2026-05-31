# ImmiNav

Plain-language compliance + business-formation guidance for immigrant entrepreneurs in the US.

App #3 on the Shultz Enterprises 12-app roadmap.

**This is general guidance, not legal advice.** Every response carries that disclaimer in both the API payload and the UI. Visa rules, tax rules, and state filings change — every answer points users toward licensed professionals where the stakes warrant it.

## Stack
- Node.js + Express
- Anthropic Claude Sonnet 4.6 via `@anthropic-ai/sdk`
- Plain HTML/CSS UI, no front-end framework

## Endpoints

| Method | Path     | Purpose                                                                 |
|--------|----------|-------------------------------------------------------------------------|
| GET    | `/`      | Web UI                                                                  |
| GET    | `/health`| `{ ok, app, version, uptime }`                                          |
| POST   | `/ask`   | Body: `{ question, country_of_origin?, us_state?, business_type?, stage? }` → returns `{ ok, disclaimer, answer, next_steps, key_terms, documents_or_forms, when_to_get_a_lawyer, confidence, scope_caveats }` |

## Running locally

```bash
npm install
cp .env.example .env   # then set ANTHROPIC_API_KEY
node server.js
```

Default port `4002`. Override with `IMMINAV_PORT` or `PORT`.

## Deploy (PM2)

```bash
pm2 start server.js --name imminav
pm2 save
```

Binds to `0.0.0.0`.

## License
MIT — see [LICENSE](./LICENSE).
