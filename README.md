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

# Credenziali via variabili d'ambiente (o modifica CONFIG in amazon_ads_api.py)
export AMAZON_ADS_CLIENT_ID='amzn1.application-oa2-client.xxxxx'
export AMAZON_ADS_CLIENT_SECRET='amzn1.oa2-cs.v1.xxxxx'
export AMAZON_ADS_REFRESH_TOKEN='Atzr|xxxxx'

python amazon_ads_api.py --marketplace IT --days 14
```

Produce `amazon_ads_IT_<data>_<ora>.json` nella cartella corrente.

⚠️ **`--days` non può superare 31**: l'API di reporting v3 rifiuta gli intervalli più lunghi, e il risultato sarebbe un file con la struttura delle campagne ma zero righe di performance. Se chiedi di più, lo script riduce la finestra a 31 giorni segnalandolo. Prima di usarlo, verifica che sia completo:

```bash
python check_data.py amazon_ads_IT_20260828_1530.json
```

Controlla i punti in cui il fetcher ha già sbagliato: liste troncate (un conteggio multiplo esatto di 100 è sospetto), report in timeout o saltati, e soprattutto la sovrapposizione tra le keyword del report e quelle della lista strutturale — è da lì che arriva il bid, e senza sovrapposizione i bid restano a zero. Esce con codice 1 se il file non è affidabile.

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

### Tab "Azioni" — rivedere e applicare le modifiche

La tab **Azioni** raccoglie tutto ciò che è applicabile: le proposte della weekly analysis **e** quelle generate al volo dal Consulente sui dati che hai appena caricato.

Il flusso è a tre passi obbligati, pensato per non applicare mai niente alla cieca:

1. **Rivedi** — le azioni sono raggruppate per intento (*Tagliare gli sprechi*, *Far crescere*, *Ottimizzare i bid*, *Budget e campagne*). Ogni riga mostra la variazione in percentuale, il motivo con il dato che la giustifica e l'impatto stimato in euro. Puoi spuntare/deselezionare (anche per gruppo), modificare bid e budget in linea, cercare, filtrare, rimuovere o aggiungere azioni tue. Le scelte sopravvivono a un refresh della pagina.
2. **Anteprima** — lancia il workflow in sola lettura. Legge lo stato **attuale** su Amazon, scarta le azioni già allineate (bid già a quel valore, keyword già in pausa) e scrive un riepilogo leggibile nel summary del run.
3. **Applica** — si sblocca solo dopo un'anteprima riuscita, e solo per *quella* selezione: se cambi idea e modifichi qualcosa, l'anteprima decade e va rifatta. Serve comunque digitare `APPLICA`.

Lo stato del run viene seguito in tempo reale nella UI, con il link diretto al log.

**Se non hai gli ID** (tipico dei CSV di Seller Central) i consigli restano testuali: l'applicazione automatica richiede il JSON prodotto da `amazon_ads_api.py`.

#### Limiti di sicurezza e rollback

Prima di scrivere su Amazon, `apply_changes.py` applica dei limiti — validi anche per le azioni scritte a mano, così un errore di battitura (bid `45.00` invece di `0.45`) non diventa una spesa:

| Cosa | Limite |
|---|---|
| Variazione bid | ±50%, comunque tra €0.02 e €5.00 |
| Variazione budget | ±50%, comunque tra €1 e €100/giorno |
| Azioni per run | max 80 |
| Nuove campagne per run | max 4 |

Si scavalcano con `--allow-large-changes`, da usare consapevolmente.

Ogni applicazione produce un file `rollback_<MP>_<data>.json` tra gli artefatti del run: rilanciandolo si riportano bid, budget e stati com'erano. Negative e keyword aggiunte non hanno un'azione inversa via API e vengono elencate a parte come promemoria.

- **⬇️ Scarica JSON** resta sempre disponibile, per incollarlo a mano nel workflow o lanciarlo da riga di comando.
- **Connetti con GitHub** usa un fine-grained token limitato a questo repo. Vedi sotto.

#### Connettere GitHub

L'app gira solo nel browser, senza backend. Gli endpoint di login di GitHub (`github.com/login/…`) **non inviano header CORS**, quindi il Device Flow da qui non funziona: il browser blocca la richiesta e `fetch` fallisce con "Failed to fetch". `api.github.com` invece il CORS ce l'ha, quindi con un token in mano tutto il resto funziona.

La via che funziona è un **fine-grained token**:

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. **Repository access**: *Only select repositories* → scegli solo questo repo
3. **Permissions → Repository permissions → Actions**: *Read and write*
4. Genera, copia il token e incollalo nel pannello Azioni → **Connetti**

Il token resta nel browser (localStorage) e serve solo a lanciare il workflow. Limitandolo a un repo e al solo permesso Actions, non può leggere né toccare altro. Revocalo quando vuoi da GitHub → Settings → Personal access tokens. Metti una scadenza breve se usi la UI da un computer condiviso.

Appena connesso, l'app verifica di riuscire davvero a vedere il workflow: se il token non ha i permessi giusti te lo dice subito, invece di farti scoprire il 403 al momento di applicare.

**Device Flow (opzionale)**: resta disponibile se metti davanti un proxy che aggiunga gli header CORS (es. un Cloudflare Worker che inoltra a `github.com`). L'URL del proxy si configura nel pannello, sotto "Accesso senza token". Senza proxy non può funzionare.

**Senza connettere niente**: **⬇️ Scarica JSON** e incollalo nel workflow `Apply Amazon Ads Changes` dal tab Actions di GitHub, come prima.

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

## Test

```bash
npm test
```

Test senza dipendenze (solo `node`), su `tests/smoke.mjs`. Coprono i punti in cui il codice ha già sbagliato: numeri in formato europeo, CSV con punto e virgola, join dei bid reali dalla lista strutturale, estrazione delle azioni dall'output del modello, scarto degli ID inventati e limiti di variazione.

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
│   ├── App.jsx                   # Dashboard, Consulente AI, navigazione
│   ├── parse.js                  # Parsing JSON/CSV (testabile senza browser)
│   ├── actions.js                # Modello azioni: validazione, limiti, descrizioni
│   ├── ActionsPanel.jsx          # Tab "Azioni": rivedi → anteprima → applica
│   ├── CampaignPlanner.jsx       # Nuova campagna da ASIN
│   ├── github.js                 # OAuth Device Flow, dispatch e stato dei run
│   ├── theme.js                  # Token di colore, tipografia, spaziature
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
