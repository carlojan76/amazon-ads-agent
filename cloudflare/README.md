# Worker Cloudflare + D1

Fa due lavori che prima non aveva nessuno.

**Database.** Registro delle azioni applicate e storico delle metriche. Senza, il
sistema riparte da zero ogni lunedì: ripropone quello che hai già fatto e non sa
dire se una modifica ha funzionato.

**Proxy delle chiavi.** La chiave Anthropic e il PAT GitHub stanno nei secrets
Cloudflare, non nel browser. Prima la pagina su GitHub Pages — che è pubblica
anche con repository privato — teneva il PAT in `localStorage` e chiamava
`api.anthropic.com` direttamente con la chiave dell'utente.

Costo: entro il piano gratuito. D1 dà 5 GB e 5 milioni di letture al giorno, il
Worker 100.000 richieste al giorno. Questo progetto fa qualche decina di
richieste a settimana.

---

## Installazione

### 1. Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Database

```bash
cd cloudflare
wrangler d1 create amazon-ads
```

Stampa un `database_id`: incollalo in `wrangler.toml` al posto del segnaposto.
Poi crea le tabelle:

```bash
wrangler d1 execute amazon-ads --remote --file=./schema.sql
```

Controlla che ci siano:

```bash
wrangler d1 execute amazon-ads --remote \
  --command="SELECT name FROM sqlite_master WHERE type='table'"
```

Attese: `applied_actions`, `metrics_history`, `bid_caps`, `usage_counters`.

### 3. Configurazione

In `wrangler.toml` sistema:

- `ALLOWED_ORIGINS` — l'origine esatta del sito, senza slash finale.
  Per te: `https://carlojan76.github.io`. Se sbagli qui, il browser blocca
  tutto con un errore CORS che sembra un problema di rete.
- `GITHUB_REPO` — il repo su cui il proxy può agire. Uno solo, chiuso.
- `ALLOWED_WORKFLOWS` — i workflow lanciabili. Elenco chiuso.

### 4. Secrets

```bash
# Token che autentica le chiamate al Worker. Generane uno lungo e casuale:
#   openssl rand -hex 32
wrangler secret put API_TOKEN

# La chiave Anthropic (quella che prima stava nel browser)
wrangler secret put ANTHROPIC_API_KEY

# PAT GitHub, fine-grained, SOLO su questo repo, permessi:
#   Actions: Read and write · Contents: Read
wrangler secret put GITHUB_TOKEN
```

### 5. Deploy

```bash
wrangler deploy
```

Ti dà un URL tipo `https://amazon-ads-agent-api.<subdominio>.workers.dev`.
Provalo:

```bash
curl https://amazon-ads-agent-api.<subdominio>.workers.dev/api/health
```

### 6. Collegare le tre parti

**La UI.** Impostazioni (⚙ in alto) → indirizzo del Worker e token → "Prova la
connessione".

**GitHub Actions.** Settings → Secrets and variables → Actions, aggiungi:

| Secret | Valore |
|---|---|
| `AGENT_API_BASE` | l'URL del Worker |
| `AGENT_API_TOKEN` | lo stesso valore di `API_TOKEN` |

**In locale.** Le stesse due variabili nel tuo `.env`.

---

## Il token nel browser, e come toglierlo

Il token del Worker vive in `localStorage` come prima ci viveva il PAT GitHub.
È meglio — raggiunge solo questo Worker, che può lanciare solo i workflow
elencati, su un solo repo, e non espone la chiave Anthropic — ma resta un
segreto dentro una pagina pubblica.

La soluzione pulita è **Cloudflare Access**, che il Worker supporta già:

1. Zero Trust → Access → Applications → Add an application → Self-hosted
2. Dominio: quello del Worker
3. Policy: Emails → il tuo indirizzo
4. Copia l'**Application Audience (AUD) tag**
5. In `wrangler.toml` scommenta e valorizza:

```toml
ACCESS_TEAM_DOMAIN = "iltuoteam.cloudflareaccess.com"
ACCESS_AUD = "il-tag-aud"
```

6. `wrangler deploy`

Da quel momento il browser si autentica con il cookie di Access e il campo token
nella UI può restare vuoto. `API_TOKEN` continua a servire per GitHub Actions,
che non può passare da Access.

---

## Rotte

Tutte sotto `/api`, tutte autenticate tranne `/api/health`.

| Metodo | Rotta | Cosa fa |
|---|---|---|
| GET | `/api/health` | Stato del servizio |
| POST | `/api/applied` | Registra azioni confermate dall'API Amazon |
| GET | `/api/applied?marketplace=IT&since_days=28` | Azioni applicate di recente, con le firme |
| POST | `/api/applied/rollback` | Marca come annullate le firme indicate |
| POST | `/api/history` | Salva un punto dello storico (upsert su marketplace + finestra) |
| GET | `/api/history?marketplace=IT&limit=52` | Serie storica, ordine cronologico crescente |
| GET | `/api/bid-caps?marketplace=IT` | Tetti di mercato e per campagna |
| PUT | `/api/bid-caps` | Crea o aggiorna un tetto |
| DELETE | `/api/bid-caps?marketplace=IT&scope=campaign&scope_id=77` | Rimuove un tetto |
| POST | `/api/anthropic` | Proxy verso l'API Messages |
| POST | `/api/github/dispatch` | Lancia un workflow dell'elenco |
| GET | `/api/github?kind=runs\|run\|file` | Legge run e file del repo |

Sul proxy Anthropic il Worker decide lui modello e `max_tokens`: il client può
mandare solo la conversazione, così una pagina compromessa non può chiedere run
costosi. C'è anche un tetto giornaliero (`DAILY_LIMIT_ANTHROPIC`, default 120).

---

## Test

```bash
node cloudflare/test/worker.test.mjs
```

Gira senza wrangler e senza rete: D1 è rimpiazzato da `node:sqlite` con lo
schema vero, quindi le query testate sono quelle che girano in produzione.

---

## Interrogare il database a mano

```bash
# Cosa ho applicato su IT nell'ultimo mese
wrangler d1 execute amazon-ads --remote --command="
  SELECT applied_at, action_type, keyword_text, old_value, new_value
  FROM applied_actions WHERE marketplace='IT' ORDER BY applied_at DESC LIMIT 20"

# Andamento settimanale
wrangler d1 execute amazon-ads --remote --command="
  SELECT period_end, spend, sales, acos FROM metrics_history
  WHERE marketplace='IT' ORDER BY period_end DESC LIMIT 12"

# Tetti attivi
wrangler d1 execute amazon-ads --remote --command="SELECT * FROM bid_caps"

# Tetto per una campagna, da riga di comando
wrangler d1 execute amazon-ads --remote --command="
  INSERT INTO bid_caps (marketplace,scope,scope_id,max_bid,updated_at)
  VALUES ('IT','campaign','123456789',0.35,datetime('now'))
  ON CONFLICT(marketplace,scope,scope_id) DO UPDATE SET max_bid=excluded.max_bid"
```

---

## Se qualcosa non va

**"Non riesco a contattare il Worker"** nella UI — quasi sempre `ALLOWED_ORIGINS`
che non combacia esattamente con l'origine della pagina. Deve essere
`https://carlojan76.github.io`, senza path e senza slash finale.

**401 dalla UI** — token diverso da `API_TOKEN`, oppure Access configurato a metà
(`ACCESS_AUD` valorizzato ma la policy non applicata al dominio del Worker).

**`apply_changes.py` si ferma con "non riesco a leggere i tetti"** — è voluto: i
tetti falliscono chiuso. Se il Worker è irraggiungibile lo script non applica
bid non verificati. Con `--ignore-cap-errors` procede, consapevolmente.

**Il registro non si popola** — controlla che `AGENT_API_BASE` e
`AGENT_API_TOKEN` siano fra i secrets di GitHub Actions, non solo nel tuo `.env`.
Nel log del workflow compare `Registro sincronizzato sul Worker: N righe`.
