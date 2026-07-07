# Amazon Ads Agent ⚡

AI-powered analyzer for Amazon Advertising Sponsored Products campaigns. Three modes:

1. **Interactive app** (React) — drag & drop analysis on-demand, anche online su GitHub Pages
2. **Weekly automation** (GitHub Actions) — receive Claude AI analysis via email every Monday, dati pubblicati automaticamente per la UI online
3. **Azioni** — rivedi, modifica, aggiungi e applica le modifiche proposte da Claude direttamente dalla UI (via GitHub Actions), niente più copia-incolla di JSON

## Architecture

```
                ┌─→ amazon_ads_api.py ──→ JSON ──→ React App (locale o GitHub Pages) ──→ Claude (interactive)
Amazon Ads API ─┤
                └─→ weekly_analysis.py ─→ Claude ──→ Email (automated weekly)
                                       └─→ public/data/*.json ──→ commit ──→ Pages rebuild ──→ React App (tab "Azioni")
                                                                                                      │
                                                                                        conferma azioni → apply-actions.yml
```

## Quick Start — Interactive Mode

### 1. Install the React app

```bash
npm install
npm run dev
```

Opens at `http://localhost:3000`

### 2. Configure API key

Copy `.env.example` to `.env` and add your Anthropic key (or enter in the app UI):

```bash
cp .env.example .env
```

### 3. Fetch Amazon data

```bash
cd python
pip install requests

# Set Amazon Ads credentials (env vars or edit CONFIG in amazon_ads_api.py)
python amazon_ads_api.py --marketplace IT --days 14
```

### 4. Analyze

Drag the generated JSON into the app → **🤖 AI Advisor → Analizza**.

## Quick Start — Automated Weekly Mode

See [`GITHUB_ACTIONS.md`](./GITHUB_ACTIONS.md) for full setup. TL;DR:

1. Push repo to GitHub
2. Add secrets: `AMAZON_ADS_*`, `ANTHROPIC_API_KEY`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_TO`
3. Workflow runs every Monday at 07:00 UTC
4. Receive HTML email with Claude analysis for each marketplace

Test it manually: **Actions → Weekly Amazon Ads Analysis → Run workflow**.

## Quick Start — UI Online (GitHub Pages)

L'app React può girare anche online, senza installare nulla in locale:

1. **Abilita GitHub Pages**: Settings → Pages → Source: **GitHub Actions**.
2. Push su `main` → il workflow `Deploy UI to GitHub Pages` builda e pubblica l'app. L'URL è tipo `https://tuo-utente.github.io/amazon-ads-agent/`.
3. Ogni run della weekly analysis pubblica automaticamente i dati (`public/data/<MARKETPLACE>.json`, committati dal bot) e l'app li mostra da sola all'apertura, senza upload manuale.

⚠️ **Attenzione — le pagine GitHub Pages sono pubbliche di default**, anche se il repo è privato (a meno di GitHub Enterprise Cloud con Pages ristretta). Chiunque conosca l'URL vedrebbe i dati di spesa/keyword/campagne pubblicati lì. Se questo è un problema, valuta di mettere il sito dietro un proxy con autenticazione (es. Cloudflare Access) o di non abilitare la pubblicazione automatica e usare solo il drag & drop locale.

### Tab "✅ Azioni" — confermare ed applicare le modifiche

Nella UI (locale o online), la tab **Azioni** mostra le modifiche che Claude propone (negative keyword, bid, budget, pause/riattivazioni):

- **Spunta/deseleziona** le singole azioni, **modifica** bid/budget al volo, **rimuovi** quelle che non ti convincono
- **+ Aggiungi azione manuale** per crearne di tue (stesso formato di `apply_changes.py`)
- **⬇️ Scarica actions.json** — sempre disponibile, va incollato nel workflow `Apply Amazon Ads Changes` (tab Actions su GitHub), come già succedeva prima
- **🚀 Applica direttamente da qui** — connetti il tuo account GitHub (OAuth Device Flow, nessun token da copiare) e lancia il workflow di apply con un click. Vedi sotto come creare l'OAuth App.

#### Creare l'OAuth App per l'apply con un click

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
2. Homepage URL: l'URL della tua Pages (es. `https://tuo-utente.github.io/amazon-ads-agent/`)
3. Authorization callback URL: puoi mettere lo stesso URL (non viene usato nel Device Flow, ma è obbligatorio)
4. Spunta **"Enable Device Flow"**
5. Copia il **Client ID** e incollalo nel pannello "⚙️ Config" della tab Azioni, insieme al repo (`owner/repo`)

Il token generato resta solo nel browser (localStorage), non viene mai inviato ad Anthropic o a terzi, e puoi revocarlo in qualsiasi momento da GitHub → Settings → Applications. Consigliato: lascia sempre "dry-run" attivo la prima volta, controlla l'anteprima su Actions, poi applica per davvero.

## Features

**Dashboard**
- ACoS, ROAS, CTR, CVR, CPC at a glance
- Color-coded campaign performance
- Filter keywords by waste/top/active, sort by any metric
- Search term analysis (find new keywords, identify wasted spend)

**AI Advisor**
- 🔴 Keywords to negate
- 🟢 Keywords to scale
- 🟡 Bid optimization
- 🔵 Match type recommendations
- 📊 Campaign structure improvements
- 🔍 New keyword opportunities

## Supported Marketplaces

IT, FR, DE, ES, UK, NL, SE, PL, BE, IE

## Tech Stack

- **Frontend**: React 18 + Vite
- **AI**: Anthropic Claude API (Sonnet)
- **Data**: Amazon Advertising API v3
- **Automation**: GitHub Actions
- **Email**: Gmail SMTP
- **Python**: `requests` only

## File Structure

```
amazon-ads-agent/
├── src/                          # React app
│   ├── App.jsx
│   ├── ActionsPanel.jsx          # Tab "Azioni": revisione/conferma/apply
│   ├── github.js                 # GitHub OAuth Device Flow + workflow dispatch
│   ├── theme.js
│   └── main.jsx
├── public/data/                  # JSON pubblicati dalla weekly analysis (auto-committati)
├── python/
│   ├── amazon_ads_api.py         # Fetcher (CLI tool)
│   ├── weekly_analysis.py        # Automation script
│   └── apply_changes.py          # Applica azioni via API (con conferma)
├── .github/workflows/
│   ├── weekly-analysis.yml       # Weekly cron job + pubblica dati
│   ├── deploy-pages.yml          # Build + deploy UI su GitHub Pages
│   └── apply-actions.yml         # Applica modifiche (manuale o da UI)
├── GITHUB_ACTIONS.md             # Automation setup guide
├── README.md
└── package.json
```

## License

Private — Lupo & Felix internal tool
