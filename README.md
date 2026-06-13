# Amazon Ads Agent ⚡

AI-powered analyzer for Amazon Advertising Sponsored Products campaigns. Two modes:

1. **Interactive app** (React) — drag & drop analysis on-demand
2. **Weekly automation** (GitHub Actions) — receive Claude AI analysis via email every Monday

## Architecture

```
                ┌─→ amazon_ads_api.py ──→ JSON ──→ React App ──→ Claude (interactive)
Amazon Ads API ─┤
                └─→ weekly_analysis.py ─→ Claude ──→ Email (automated weekly)
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
│   └── main.jsx
├── python/
│   ├── amazon_ads_api.py         # Fetcher (CLI tool)
│   └── weekly_analysis.py        # Automation script
├── .github/workflows/
│   └── weekly-analysis.yml       # Weekly cron job
├── GITHUB_ACTIONS.md             # Automation setup guide
├── README.md
└── package.json
```

## License

Private — Lupo & Felix internal tool
