# 🤖 GitHub Actions: Weekly Analysis

Automatizza l'analisi delle campagne Amazon Ads ogni settimana. Lo script:
1. Scarica dati via Amazon Advertising API per ogni marketplace
2. Invia a Claude per analisi
3. Manda email HTML con report dettagliato

## Setup

### 1. Push del repo su GitHub

```bash
cd amazon-ads-agent
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TUO_USERNAME/amazon-ads-agent.git
git push -u origin main
```

### 2. Configura i Secrets

Vai su **Settings → Secrets and variables → Actions → New repository secret** e aggiungi:

| Nome | Valore |
|------|--------|
| `AMAZON_ADS_CLIENT_ID` | `amzn1.application-oa2-client.xxxxx` |
| `AMAZON_ADS_CLIENT_SECRET` | `amzn1.oa2-cs.v1.xxxxx` |
| `AMAZON_ADS_REFRESH_TOKEN` | `Atzr\|xxxxx` |
| `ANTHROPIC_API_KEY` | `sk-ant-xxxxx` |
| `SMTP_USER` | la tua email Gmail (es. `nome@gmail.com`) |
| `SMTP_PASS` | App Password Gmail (vedi sotto) |
| `EMAIL_TO` | dove ricevere il report (può anche essere lo stesso SMTP_USER) |

### 3. Crea Gmail App Password

Le password normali non funzionano con Gmail SMTP. Crea una **App Password**:

1. Vai su [myaccount.google.com/security](https://myaccount.google.com/security)
2. Attiva la **verifica in due passaggi** se non già fatto
3. Cerca "App passwords" → **Generate**
4. Seleziona "Mail" e "Other" → dai un nome (es. "Amazon Ads Agent")
5. Copia i 16 caratteri generati → questa è la `SMTP_PASS`

### 4. Test manuale

Prima di aspettare lunedì, testa che funzioni:

1. Vai sul tab **Actions** del repo GitHub
2. Seleziona **Weekly Amazon Ads Analysis**
3. Clicca **Run workflow** (in alto a destra)
4. Eventualmente cambia i parametri (marketplace, giorni)
5. **Run workflow**

Dopo 2-5 minuti dovresti ricevere l'email.

## Configurazione

### Cambiare l'orario

Modifica la riga `cron` in `.github/workflows/weekly-analysis.yml`:

```yaml
- cron: '0 7 * * 1'  # Lunedì 07:00 UTC = 08:00 IT (inverno) / 09:00 IT (estate)
- cron: '0 6 * * 1'  # Lunedì 06:00 UTC = 07:00 IT (inverno) / 08:00 IT (estate)
- cron: '0 7 * * *'  # OGNI GIORNO alle 07:00 UTC
- cron: '0 7 1 * *'  # PRIMO del MESE alle 07:00 UTC
```

[Cron expression generator](https://crontab.guru/)

### Cambiare i marketplaces

Edit del default in `weekly-analysis.yml`:

```yaml
MARKETPLACES: 'IT,FR,DE,ES'  # Aggiungi/togli marketplace
```

### Cambiare il periodo di analisi

```yaml
ANALYSIS_DAYS: '30'  # Default 14
```

## Cosa fa lo script

Per ogni marketplace:
1. **Auth LWA** → ottiene access token
2. **Profile lookup** → trova l'ID profile per IT/FR/DE
3. **Fetch struttura** → campagne, ad groups, keywords, targets, negative keywords
4. **Fetch reports** → richiede 5 report asincroni (campaigns, keywords, search terms, targeting, products), aspetta che completino e scarica
5. **Summary** → estrae metriche aggregate e top performers/sprechi
6. **Claude analysis** → manda tutto a Claude con prompt strutturato
7. **Email HTML** → costruisce report visivo e invia via Gmail SMTP

I report sono salvati anche come **artifact GitHub** (Actions → Run → Artifacts) per 30 giorni in caso di problemi con l'email.

## Costi stimati

- **GitHub Actions**: gratis per repo privati con piano Free (2.000 minuti/mese). Una run dura ~5 min, quindi sei tranquillo.
- **Anthropic API**: ~€0.05-0.15 per marketplace per analisi (dipende dalla lunghezza). Con 3 marketplace settimanali: ~€2/mese.
- **Amazon Advertising API**: gratis.
- **Gmail SMTP**: gratis.

Totale: ~€2-3/mese.

## Troubleshooting

### ❌ "Auth fallita 400"
Il refresh token è scaduto o sbagliato. Rifare il flusso OAuth (vedi README principale).

### ❌ "Errore Claude API 401"
La `ANTHROPIC_API_KEY` non è valida o non ha crediti. Controlla su [console.anthropic.com](https://console.anthropic.com).

### ❌ "Errore invio email: Authentication failed"
Stai usando la password Gmail normale invece dell'App Password. Crea l'App Password (vedi sopra).

### ❌ Report vuoti (0 righe)
- Il marketplace selezionato non ha campagne attive
- Il periodo è troppo corto (Amazon a volte ha ritardi nei dati)
- Prova `ANALYSIS_DAYS=30`

### Debug locale

Puoi lanciare lo script in locale per testare:

```bash
cd python
export AMAZON_ADS_CLIENT_ID="..."
export AMAZON_ADS_CLIENT_SECRET="..."
export AMAZON_ADS_REFRESH_TOKEN="..."
export ANTHROPIC_API_KEY="..."
export SMTP_USER="..."
export SMTP_PASS="..."
export EMAIL_TO="..."
export MARKETPLACES="IT"
export ANALYSIS_DAYS="14"
python weekly_analysis.py
```
