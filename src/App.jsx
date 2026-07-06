import { useState, useCallback, useRef, useEffect } from "react";
import { C } from "./theme";
import ActionsPanel from "./ActionsPanel";

const ENV_KEY = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_ANTHROPIC_API_KEY : '';
const BASE_URL = typeof import.meta !== 'undefined' ? import.meta.env.BASE_URL : '/';

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const sep = lines[0].includes("\t") ? "\t" : ",";
  const parseRow = (line) => {
    const r = []; let cur = "", inQ = false;
    for (const ch of line) { if (ch === '"') inQ = !inQ; else if (ch === sep && !inQ) { r.push(cur.trim()); cur = ""; } else cur += ch; }
    r.push(cur.trim()); return r;
  };
  const headers = parseRow(lines[0]);
  return { headers, rows: lines.slice(1).map(l => { const v = parseRow(l); const o = {}; headers.forEach((h, i) => o[h] = v[i] || ""); return o; }) };
}

function processJSON(json) {
  const m = { totalSpend: 0, totalSales: 0, totalImpress: 0, totalClicks: 0, totalOrders: 0, campaigns: {}, keywords: [], negativeKeywords: [], products: [] };
  const num = v => parseFloat(String(v || 0).replace(/[€$%,]/g, "")) || 0;

  (json.reports?.campaigns || []).forEach(r => {
    const name = r.campaignName || r.campaign_name || "";
    const spend = num(r.cost || r.spend);
    const sales = num(r.sales7d || r.sales14d || r.sales || r.attributedSales7d);
    const impr = num(r.impressions);
    const clicks = num(r.clicks);
    const orders = num(r.purchases7d || r.purchases14d || r.orders || r.unitsSoldClicks7d);
    m.totalSpend += spend; m.totalSales += sales; m.totalImpress += impr; m.totalClicks += clicks; m.totalOrders += orders;
    if (!m.campaigns[name]) m.campaigns[name] = { spend: 0, sales: 0, impressions: 0, clicks: 0, orders: 0, status: "", budget: 0 };
    m.campaigns[name].spend += spend; m.campaigns[name].sales += sales; m.campaigns[name].impressions += impr; m.campaigns[name].clicks += clicks; m.campaigns[name].orders += orders;
  });

  (json.campaigns || []).forEach(c => {
    const name = c.name || "";
    if (m.campaigns[name]) { m.campaigns[name].status = c.state || ""; m.campaigns[name].budget = c.budget || 0; m.campaigns[name].targetingType = c.targetingType || ""; m.campaigns[name].bidding = c.bidding || {}; }
  });

  (json.reports?.keywords || []).forEach(r => {
    const spend = num(r.cost || r.spend);
    const sales = num(r.sales7d || r.sales14d || r.sales);
    const impr = num(r.impressions); const clicks = num(r.clicks);
    const orders = num(r.purchases7d || r.purchases14d || r.orders || r.unitsSoldClicks7d);
    m.keywords.push({
      keyword: r.keyword || r.keywordText || "", campaign: r.campaignName || r.campaign_name || "",
      adGroup: r.adGroupName || r.ad_group_name || "", matchType: r.matchType || r.match_type || "",
      bid: num(r.keywordBid || r.bid), spend, sales, impressions: impr, clicks, orders,
      acos: sales > 0 ? (spend / sales) * 100 : spend > 0 ? 999 : 0,
      ctr: impr > 0 ? (clicks / impr) * 100 : 0, cvr: clicks > 0 ? (orders / clicks) * 100 : 0,
      cpc: clicks > 0 ? spend / clicks : 0,
    });
  });

  const searchTerms = (json.reports?.searchTerms || []).map(r => {
    const spend = num(r.cost || r.spend);
    const sales = num(r.sales7d || r.sales14d || r.sales);
    const impr = num(r.impressions); const clicks = num(r.clicks);
    const orders = num(r.purchases7d || r.unitsSoldClicks7d || r.orders);
    return {
      searchTerm: r.searchTerm || r.query || "", keyword: r.keyword || r.keywordText || "",
      campaign: r.campaignName || "", adGroup: r.adGroupName || "", matchType: r.matchType || "",
      spend, sales, impressions: impr, clicks, orders,
      acos: sales > 0 ? (spend / sales) * 100 : spend > 0 ? 999 : 0,
      ctr: impr > 0 ? (clicks / impr) * 100 : 0, cvr: clicks > 0 ? (orders / clicks) * 100 : 0,
    };
  });

  m.products = (json.reports?.products || []).map(r => ({
    asin: r.advertisedAsin || r.asin || "", sku: r.advertisedSku || r.sku || "", campaign: r.campaignName || "",
    spend: num(r.cost || r.spend), sales: num(r.sales7d || r.sales), clicks: num(r.clicks),
    impressions: num(r.impressions), orders: num(r.purchases7d || r.unitsSoldClicks7d),
  }));

  m.negativeKeywords = json.negativeKeywords || [];
  m.searchTerms = searchTerms;
  m.acos = m.totalSales > 0 ? (m.totalSpend / m.totalSales) * 100 : 0;
  m.ctr = m.totalImpress > 0 ? (m.totalClicks / m.totalImpress) * 100 : 0;
  m.cvr = m.totalClicks > 0 ? (m.totalOrders / m.totalClicks) * 100 : 0;
  m.cpc = m.totalClicks > 0 ? m.totalSpend / m.totalClicks : 0;
  m.meta = json._meta || {};
  // Presenti solo quando il JSON viene dalla pubblicazione automatica (weekly_analysis.py)
  m.weeklyAnalysis = json.analysis || null;
  m.proposedActions = json.actions?.actions || [];
  m.generatedAt = json.generated_at || null;
  return m;
}

function processCSV(parsed) {
  const { headers, rows } = parsed;
  const num = v => { if (!v) return 0; return parseFloat(String(v).replace(/[€$%,\s]/g, "").replace(",", ".")) || 0; };
  const findCol = kws => headers.find(h => { const hl = h.toLowerCase(); return kws.some(k => hl.includes(k)); });
  const spendCol = findCol(["spend", "spesa", "cost", "costo"]);
  const salesCol = findCol(["sales", "vendite", "revenue", "7 day", "14 day"]);
  const impressCol = findCol(["impression", "visualizzazioni"]);
  const clickCol = findCol(["click"]);
  const orderCol = findCol(["order", "ordini", "conversion", "purchase", "units"]);
  const campaignCol = findCol(["campaign name", "nome campagna", "campaign"]);
  const keywordCol = findCol(["keyword", "targeting", "search term", "parola chiave"]);
  const matchCol = findCol(["match type", "tipo"]);
  const bidCol = findCol(["bid", "offerta"]);
  const adGroupCol = findCol(["ad group", "gruppo"]);

  const m = { totalSpend: 0, totalSales: 0, totalImpress: 0, totalClicks: 0, totalOrders: 0, campaigns: {}, keywords: [], searchTerms: [], negativeKeywords: [], products: [] };
  rows.forEach(r => {
    const spend = num(r[spendCol]); const sales = num(r[salesCol]); const impr = num(r[impressCol]);
    const clicks = num(r[clickCol]); const orders = num(r[orderCol]); const camp = r[campaignCol] || "N/A";
    m.totalSpend += spend; m.totalSales += sales; m.totalImpress += impr; m.totalClicks += clicks; m.totalOrders += orders;
    if (!m.campaigns[camp]) m.campaigns[camp] = { spend: 0, sales: 0, impressions: 0, clicks: 0, orders: 0 };
    m.campaigns[camp].spend += spend; m.campaigns[camp].sales += sales; m.campaigns[camp].impressions += impr;
    m.campaigns[camp].clicks += clicks; m.campaigns[camp].orders += orders;
    const kw = r[keywordCol] || "";
    if (kw) m.keywords.push({ keyword: kw, campaign: camp, adGroup: r[adGroupCol] || "", matchType: r[matchCol] || "", bid: num(r[bidCol]),
      spend, sales, impressions: impr, clicks, orders, acos: sales > 0 ? (spend / sales) * 100 : spend > 0 ? 999 : 0,
      ctr: impr > 0 ? (clicks / impr) * 100 : 0, cvr: clicks > 0 ? (orders / clicks) * 100 : 0, cpc: clicks > 0 ? spend / clicks : 0 });
  });
  m.acos = m.totalSales > 0 ? (m.totalSpend / m.totalSales) * 100 : 0;
  m.ctr = m.totalImpress > 0 ? (m.totalClicks / m.totalImpress) * 100 : 0;
  m.cvr = m.totalClicks > 0 ? (m.totalOrders / m.totalClicks) * 100 : 0;
  m.cpc = m.totalClicks > 0 ? m.totalSpend / m.totalClicks : 0;
  return m;
}

function Metric({ label, value, sub, color, icon }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px", flex: "1 1 140px", minWidth: 130, position: "relative" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, ${color}, transparent)` }} />
      <div style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6, fontFamily: "monospace" }}>{icon} {label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: C.text, fontFamily: "monospace" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function AiAdvisor({ metrics, sourceType, apiKey }) {
  const [advice, setAdvice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState([]);

  const buildContext = () => {
    const campSum = Object.entries(metrics.campaigns).sort((a, b) => b[1].spend - a[1].spend).slice(0, 20)
      .map(([n, d]) => { const acos = d.sales > 0 ? ((d.spend / d.sales) * 100).toFixed(1) : "∞"; return `- ${n}: Spend €${d.spend.toFixed(2)}, Sales €${d.sales.toFixed(2)}, ACoS ${acos}%, Clicks ${d.clicks}, Orders ${d.orders}${d.budget ? `, Budget €${d.budget}` : ""}${d.targetingType ? `, Type: ${d.targetingType}` : ""}${d.status ? `, Status: ${d.status}` : ""}`; }).join("\n");
    const topKw = metrics.keywords.filter(k => k.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, 35)
      .map(k => `- "${k.keyword}" [${k.matchType}] Camp: ${k.campaign} | €${k.spend.toFixed(2)} spend, €${k.sales.toFixed(2)} sales, ACoS ${k.acos.toFixed(1)}%, ${k.clicks} clicks, ${k.orders} orders, CTR ${k.ctr.toFixed(2)}%, CVR ${k.cvr.toFixed(1)}%, CPC €${k.cpc.toFixed(2)}, Bid €${k.bid.toFixed(2)}`).join("\n");
    const waste = metrics.keywords.filter(k => k.spend > 0 && k.orders === 0).sort((a, b) => b.spend - a.spend).slice(0, 20)
      .map(k => `- "${k.keyword}" [${k.matchType}] €${k.spend.toFixed(2)} spesi, ${k.clicks} clicks, 0 ordini`).join("\n");
    const best = metrics.keywords.filter(k => k.orders > 0 && k.acos < 25).sort((a, b) => a.acos - b.acos).slice(0, 15)
      .map(k => `- "${k.keyword}" ACoS ${k.acos.toFixed(1)}%, ${k.orders} ordini, €${k.sales.toFixed(2)} sales, CPC €${k.cpc.toFixed(2)}, Bid €${k.bid.toFixed(2)}`).join("\n");

    let stSection = "";
    if (metrics.searchTerms?.length) {
      const topST = metrics.searchTerms.filter(s => s.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, 25)
        .map(s => `- "${s.searchTerm}" → kw "${s.keyword}" [${s.matchType}] | €${s.spend.toFixed(2)}, ${s.clicks} clicks, ${s.orders} orders, ACoS ${s.acos.toFixed(1)}%`).join("\n");
      stSection = `\n## Search Terms (top 25 per spesa)\n${topST || "N/A"}`;
      const wasteST = metrics.searchTerms.filter(s => s.spend > 1 && s.orders === 0).sort((a, b) => b.spend - a.spend).slice(0, 15)
        .map(s => `- "${s.searchTerm}" €${s.spend.toFixed(2)}, ${s.clicks} clicks — ZERO ordini`).join("\n");
      if (wasteST) stSection += `\n\n## Search Terms Spreconi (spesa > €1, zero ordini)\n${wasteST}`;
    }

    let negSection = "";
    if (metrics.negativeKeywords?.length) {
      negSection = `\n## Negative Keywords Attive (${metrics.negativeKeywords.length})\n` +
        metrics.negativeKeywords.slice(0, 30).map(n => `- "${n.keywordText}" [${n.matchType}]`).join("\n");
    }

    let prodSection = "";
    if (metrics.products?.length) {
      prodSection = `\n## Performance per ASIN\n` +
        metrics.products.filter(p => p.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, 15)
          .map(p => `- ASIN ${p.asin} (${p.sku || "N/A"}): €${p.spend.toFixed(2)} spend, €${p.sales.toFixed(2)} sales, ${p.orders} ordini`).join("\n");
    }

    return `## Metriche Generali
- Spesa: €${metrics.totalSpend.toFixed(2)} | Vendite: €${metrics.totalSales.toFixed(2)} | ACoS: ${metrics.acos.toFixed(1)}% | ROAS: ${(metrics.totalSpend > 0 ? metrics.totalSales / metrics.totalSpend : 0).toFixed(2)}x
- Impression: ${metrics.totalImpress.toLocaleString()} | Click: ${metrics.totalClicks.toLocaleString()} | CTR: ${metrics.ctr.toFixed(2)}% | CVR: ${metrics.cvr.toFixed(1)}% | CPC: €${metrics.cpc.toFixed(2)} | Ordini: ${metrics.totalOrders}
- Fonte dati: ${sourceType}${metrics.meta?.days ? ` | Periodo: ultimi ${metrics.meta.days} giorni` : ""}${metrics.meta?.marketplace ? ` | Marketplace: ${metrics.meta.marketplace}` : ""}

## Campagne (top 20 per spesa)
${campSum || "N/A"}

## Top 35 Keywords per Spesa
${topKw || "N/A"}

## Keywords con Spesa e ZERO Ordini (sprechi, top 20)
${waste || "Nessuno spreco rilevato"}

## Keywords ad Alta Performance (ACoS < 25%)
${best || "Nessuna"}${stSection}${negSection}${prodSection}`;
  };

  const askAI = useCallback(async (customQ) => {
    if (!apiKey) { setError("Inserisci la API key di Anthropic nelle impostazioni"); return; }
    setLoading(true); setError(null);
    const ctx = buildContext();
    const sys = `Sei un consulente senior di Amazon PPC specializzato in marketplace EU (IT, FR, DE, ES).
Analizza i dati e fornisci consigli CONCRETI e AZIONABILI in italiano.

Per ogni consiglio specifica:
• AZIONE ESATTA (es. "Negativizza 'cuccia gatto economica' nella campagna SP-Tiragraffi")
• MOTIVO con riferimento ai dati
• IMPATTO ATTESO (es. "Risparmio stimato €X/settimana")

Categorie:
🔴 NEGATIVIZZARE — keyword/search term con spesa alta e zero conversioni
🟢 SCALARE — keyword con buon ACoS, aumentare bid o budget
🟡 BID OPTIMIZATION — bid troppo alti/bassi rispetto a performance
🔵 MATCH TYPE — passaggi broad→phrase→exact suggeriti
📊 STRUTTURA — riorganizzazione campagne, budget allocation
🔍 SEARCH TERMS — nuove keyword da aggiungere basate sui search term performanti
💡 QUICK WINS — azioni immediate ad alto impatto

Usa tabelle markdown. Sii diretto e operativo, no teoria generica.`;
    const msg = customQ ? `${ctx}\n\n---\nDOMANDA: ${customQ}` : `${ctx}\n\n---\nAnalisi completa con consigli operativi per tutte le categorie.`;

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4000, system: sys,
          messages: [...history.map(h => ({ role: h.role, content: h.content })), { role: "user", content: msg }] }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error.message);
      const text = data.content?.map(b => b.text || "").join("\n") || "Nessuna risposta";
      setAdvice(text);
      setHistory(prev => [...prev, { role: "user", content: msg }, { role: "assistant", content: text }]);
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }, [metrics, history, apiKey]);

  const renderMarkdown = (text) => {
    return text.split("\n").map((line, i) => {
      if (line.startsWith("###")) return <h4 key={i} style={{ color: C.accent, margin: "16px 0 6px", fontSize: 14, fontWeight: 700 }}>{line.replace(/^###\s*/, "")}</h4>;
      if (line.startsWith("##")) return <h3 key={i} style={{ color: C.accent, margin: "18px 0 8px", fontSize: 15, fontWeight: 700 }}>{line.replace(/^##\s*/, "")}</h3>;
      if (line.startsWith("#")) return <h2 key={i} style={{ color: C.text, margin: "20px 0 8px", fontSize: 17, fontWeight: 700 }}>{line.replace(/^#\s*/, "")}</h2>;
      if (line.startsWith("|")) {
        if (line.includes("---")) return null;
        const cells = line.split("|").filter(c => c.trim());
        return <div key={i} style={{ display: "grid", gridTemplateColumns: `repeat(${cells.length}, 1fr)`, gap: 1, fontSize: 12, borderBottom: `1px solid ${C.border}` }}>
          {cells.map((c, j) => <div key={j} style={{ padding: "4px 8px", color: C.textMuted, fontFamily: "monospace" }}>{c.trim()}</div>)}
        </div>;
      }
      const formatted = line.replace(/\*\*(.*?)\*\*/g, "«B»$1«/B»");
      const parts = formatted.split(/(«B».*?«\/B»)/g);
      return <p key={i} style={{ margin: "3px 0", fontSize: 13, lineHeight: 1.7, color: C.text }}>
        {parts.map((p, j) => p.startsWith("«B»") ? <strong key={j} style={{ color: C.accent }}>{p.replace(/«\/?B»/g, "")}</strong> : p)}
      </p>;
    });
  };

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
      <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: `linear-gradient(135deg, ${C.accent}, ${C.accentDim})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>🤖</div>
          <div><div style={{ color: C.text, fontWeight: 600, fontSize: 14 }}>AI Campaign Advisor</div>
            <div style={{ color: C.textDim, fontSize: 10, fontFamily: "monospace" }}>Claude Sonnet • Analisi PPC</div></div>
        </div>
        {!advice && !loading && <button onClick={() => askAI(null)} style={{ background: `linear-gradient(135deg, ${C.accent}, ${C.accentDim})`, color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>▶ Analizza</button>}
      </div>
      {loading && <div style={{ padding: 36, textAlign: "center" }}>
        <div style={{ width: 36, height: 36, border: `3px solid ${C.border}`, borderTopColor: C.accent, borderRadius: "50%", animation: "spin .7s linear infinite", margin: "0 auto 12px" }} />
        <div style={{ color: C.accent, fontWeight: 600, fontSize: 13 }}>Analisi in corso...</div>
        <div style={{ color: C.textDim, fontSize: 11, marginTop: 4 }}>{metrics.keywords.length} keywords • {Object.keys(metrics.campaigns).length} campagne • {(metrics.searchTerms || []).length} search terms</div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>}
      {error && <div style={{ padding: 16, color: C.red, fontSize: 12 }}>⚠️ {error}</div>}
      {advice && <div>
        <div style={{ padding: "16px 20px", maxHeight: 480, overflowY: "auto" }}>{renderMarkdown(advice)}</div>
        <div style={{ padding: "10px 16px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 6 }}>
          <input value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={e => e.key === "Enter" && question.trim() && (askAI(question.trim()), setQuestion(""))}
            placeholder="Domanda specifica... (es. 'Quali search term aggiungo come exact?')"
            style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7, padding: "9px 12px", color: C.text, fontSize: 12, outline: "none", fontFamily: "inherit" }} />
          <button onClick={() => { if (question.trim()) { askAI(question.trim()); setQuestion(""); } }}
            style={{ background: question.trim() ? C.accent : C.border, color: question.trim() ? "#fff" : C.textDim, border: "none", borderRadius: 7, padding: "9px 14px", fontWeight: 700, fontSize: 12, cursor: question.trim() ? "pointer" : "default" }}>
            Chiedi
          </button>
        </div>
      </div>}
    </div>
  );
}

export default function App() {
  const [metrics, setMetrics] = useState(null);
  const [fileName, setFileName] = useState("");
  const [sourceType, setSourceType] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [tab, setTab] = useState("overview");
  const [kwSort, setKwSort] = useState("spend");
  const [kwFilter, setKwFilter] = useState("all");
  const [apiKey, setApiKey] = useState(ENV_KEY || "");
  const [showSettings, setShowSettings] = useState(false);
  const [publishedIndex, setPublishedIndex] = useState(null);
  const [publishedError, setPublishedError] = useState(false);
  const [loadingMp, setLoadingMp] = useState(null);
  const fileRef = useRef();

  // Dati pubblicati automaticamente ogni settimana da weekly_analysis.py (se presenti)
  useEffect(() => {
    fetch(`${BASE_URL}data/index.json`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(setPublishedIndex)
      .catch(() => setPublishedError(true));
  }, []);

  const loadPublished = useCallback(mp => {
    setLoadingMp(mp);
    fetch(`${BASE_URL}data/${mp}.json`)
      .then(r => r.json())
      .then(json => {
        setMetrics(processJSON(json));
        setFileName(`${mp}.json`);
        setSourceType(`Pubblicato • ${mp} • ${json._meta?.days || "?"} giorni`);
        setTab("overview");
      })
      .catch(() => setPublishedError(true))
      .finally(() => setLoadingMp(null));
  }, []);

  const handleFile = useCallback(file => {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target.result;
      try {
        const json = JSON.parse(text);
        if (json._meta || json.reports || json.campaigns) {
          setMetrics(processJSON(json));
          setSourceType(`API • ${json._meta?.marketplace || "auto"} • ${json._meta?.days || "?"} giorni`);
        } else {
          const parsed = parseCSV(text);
          setMetrics(processCSV(parsed));
          setSourceType("CSV Upload");
        }
      } catch {
        const parsed = parseCSV(text);
        setMetrics(processCSV(parsed));
        setSourceType("CSV Upload");
      }
      setTab("overview");
    };
    reader.readAsText(file);
  }, []);

  if (!metrics) {
    return (
      <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'SF Mono', 'Fira Code', monospace" }}>
        <div style={{ maxWidth: 620, width: "100%" }}>
          <div style={{ textAlign: "center", marginBottom: 36 }}>
            <div style={{ fontSize: 14, color: C.accent, fontWeight: 700, letterSpacing: 3, marginBottom: 8 }}>AMAZON ADS</div>
            <h1 style={{ fontSize: 32, fontWeight: 800, color: C.text, margin: "0 0 8px", letterSpacing: -1 }}>Campaign Agent <span style={{ color: C.accent }}>⚡</span></h1>
            <p style={{ color: C.textMuted, fontSize: 13, lineHeight: 1.5 }}>Analisi AI delle tue campagne Sponsored Products.<br/>Supporta JSON da API e CSV da Seller Central.</p>
          </div>

          {/* API Key */}
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>🔑 Anthropic API Key</div>
              <div style={{ fontSize: 10, color: apiKey ? C.green : C.red }}>{apiKey ? "✅ Configurata" : "⚠️ Necessaria per AI Advisor"}</div>
            </div>
            <input value={apiKey} onChange={e => setApiKey(e.target.value)}
              type="password" placeholder="sk-ant-..."
              style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7, padding: "9px 12px", color: C.text, fontSize: 12, outline: "none", fontFamily: "monospace" }} />
            <div style={{ fontSize: 10, color: C.textDim, marginTop: 6 }}>La key resta locale nel browser, non viene salvata. Oppure usa VITE_ANTHROPIC_API_KEY nel .env</div>
          </div>

          {/* Dati pubblicati automaticamente (weekly analysis) */}
          {publishedIndex?.marketplaces?.length > 0 && (
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>🌐 Ultimi dati pubblicati</div>
                <div style={{ fontSize: 10, color: C.textDim }}>
                  {publishedIndex.generated_at ? new Date(publishedIndex.generated_at).toLocaleString("it-IT") : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {publishedIndex.marketplaces.map(mp => (
                  <button key={mp} onClick={() => loadPublished(mp)} disabled={loadingMp === mp}
                    style={{ background: C.accentGlow, border: `1px solid ${C.accent}`, borderRadius: 7, padding: "8px 16px", color: C.accent, fontWeight: 700, fontSize: 12, cursor: loadingMp ? "default" : "pointer" }}>
                    {loadingMp === mp ? "⏳ Carico..." : `📊 ${mp}`}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Upload */}
          <div onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
            onClick={() => fileRef.current?.click()}
            style={{ border: `2px dashed ${dragOver ? C.accent : C.border}`, borderRadius: 14, padding: "44px 28px", cursor: "pointer", background: dragOver ? C.accentGlow : C.surface, transition: "all 0.2s", textAlign: "center", marginBottom: 24 }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>{dragOver ? "📂" : "🚀"}</div>
            <div style={{ color: C.text, fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Trascina file qui</div>
            <div style={{ color: C.textDim, fontSize: 12 }}>JSON (da amazon_ads_api.py) o CSV (da Seller Central)</div>
            <input ref={fileRef} type="file" accept=".json,.csv,.tsv,.txt" hidden onChange={e => handleFile(e.target.files[0])} />
          </div>

          <div style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap" }}>
            {["JSON API", "Bulk Sheet", "Search Term", "SP Report"].map(t => (
              <span key={t} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 5, padding: "3px 9px", fontSize: 10, color: C.textDim }}>{t}</span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const wasteKws = metrics.keywords.filter(k => k.spend > 0 && k.orders === 0).sort((a, b) => b.spend - a.spend);
  const bestKws = metrics.keywords.filter(k => k.orders > 0 && k.acos < 25).sort((a, b) => a.acos - b.acos);
  const sortedKws = [...metrics.keywords].filter(k => {
    if (kwFilter === "waste") return k.spend > 0 && k.orders === 0;
    if (kwFilter === "top") return k.orders > 0 && k.acos < 25;
    if (kwFilter === "active") return k.spend > 0;
    return true;
  }).sort((a, b) => {
    if (kwSort === "spend") return b.spend - a.spend;
    if (kwSort === "acos") return (a.acos || 999) - (b.acos || 999);
    if (kwSort === "sales") return b.sales - a.sales;
    if (kwSort === "clicks") return b.clicks - a.clicks;
    return 0;
  });

  const wasteST = (metrics.searchTerms || []).filter(s => s.spend > 0.5 && s.orders === 0).sort((a, b) => b.spend - a.spend);
  const tabs = [
    { id: "overview", label: "📊 Overview" }, { id: "campaigns", label: "📁 Campagne" },
    { id: "keywords", label: "🔑 Keywords" },
    ...(metrics.searchTerms?.length ? [{ id: "searchterms", label: "🔍 Search Terms" }] : []),
    { id: "ai", label: "🤖 AI Advisor" },
    { id: "actions", label: `✅ Azioni${metrics.proposedActions?.length ? ` (${metrics.proposedActions.length})` : ""}` },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, padding: 14, fontFamily: "'SF Mono', 'Fira Code', monospace" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontSize: 10, color: C.accent, fontWeight: 700, letterSpacing: 2 }}>AMAZON ADS AGENT</div>
            <div style={{ fontSize: 11, color: C.textDim, marginTop: 3 }}>📄 {fileName} • {sourceType} • {metrics.keywords.length} keywords</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setShowSettings(!showSettings)} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 12px", color: C.textMuted, fontSize: 11, cursor: "pointer" }}>⚙️</button>
            <button onClick={() => { setMetrics(null); setTab("overview"); }} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 12px", color: C.textMuted, fontSize: 11, cursor: "pointer" }}>✕ Reset</button>
          </div>
        </div>

        {/* Settings panel */}
        {showSettings && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 8 }}>🔑 API Key</div>
            <input value={apiKey} onChange={e => setApiKey(e.target.value)} type="password" placeholder="sk-ant-..."
              style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7, padding: "8px 12px", color: C.text, fontSize: 12, outline: "none", fontFamily: "monospace" }} />
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: "flex", gap: 3, marginBottom: 16, overflowX: "auto", paddingBottom: 2 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              background: tab === t.id ? C.accentGlow : "transparent", border: `1px solid ${tab === t.id ? C.accent : C.border}`,
              borderRadius: 6, padding: "7px 14px", color: tab === t.id ? C.accent : C.textMuted,
              fontSize: 12, fontWeight: tab === t.id ? 600 : 400, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit",
            }}>{t.label}</button>
          ))}
        </div>

        {/* Overview */}
        {tab === "overview" && <div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
            <Metric label="Spesa" value={`€${metrics.totalSpend.toFixed(2)}`} color={C.red} icon="💸" />
            <Metric label="Vendite" value={`€${metrics.totalSales.toFixed(2)}`} color={C.green} icon="💰" />
            <Metric label="ACoS" value={`${metrics.acos.toFixed(1)}%`} sub={metrics.acos > 30 ? "⚠️ Alto" : "✅ OK"} color={metrics.acos > 30 ? C.red : C.green} icon="📉" />
            <Metric label="ROAS" value={`${(metrics.totalSpend > 0 ? metrics.totalSales / metrics.totalSpend : 0).toFixed(2)}x`} color={C.blue} icon="📈" />
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
            <Metric label="Impressions" value={metrics.totalImpress.toLocaleString()} color={C.textDim} icon="👁" />
            <Metric label="Click" value={metrics.totalClicks.toLocaleString()} color={C.blue} icon="🖱" />
            <Metric label="CTR" value={`${metrics.ctr.toFixed(2)}%`} color={C.blue} icon="🎯" />
            <Metric label="CPC" value={`€${metrics.cpc.toFixed(2)}`} color={C.accent} icon="💶" />
            <Metric label="Ordini" value={metrics.totalOrders} color={C.green} icon="📦" />
            <Metric label="CVR" value={`${metrics.cvr.toFixed(1)}%`} color={C.green} icon="✅" />
          </div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 10 }}>⚡ Alert</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {wasteKws.length > 0 && <div style={{ background: C.redDim, borderRadius: 7, padding: "8px 12px", fontSize: 12, color: C.text }}>🔴 <strong>{wasteKws.length}</strong> keyword con spesa e zero ordini — spreco: €{wasteKws.reduce((s, k) => s + k.spend, 0).toFixed(2)}</div>}
              {wasteST.length > 0 && <div style={{ background: C.redDim, borderRadius: 7, padding: "8px 12px", fontSize: 12, color: C.text }}>🔴 <strong>{wasteST.length}</strong> search terms con spesa e zero ordini</div>}
              {metrics.acos > 35 && <div style={{ background: C.redDim, borderRadius: 7, padding: "8px 12px", fontSize: 12, color: C.text }}>🔴 ACoS al {metrics.acos.toFixed(1)}% — riduci bid o negativizza</div>}
              {bestKws.length > 0 && <div style={{ background: C.greenDim, borderRadius: 7, padding: "8px 12px", fontSize: 12, color: C.text }}>🟢 <strong>{bestKws.length}</strong> keyword con ACoS &lt;25% — scala i bid!</div>}
              {metrics.negativeKeywords?.length > 0 && <div style={{ background: C.blueDim, borderRadius: 7, padding: "8px 12px", fontSize: 12, color: C.text }}>ℹ️ {metrics.negativeKeywords.length} negative keywords attive</div>}
            </div>
          </div>
        </div>}

        {/* Campaigns */}
        {tab === "campaigns" && <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr repeat(5, 1fr)", padding: "10px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: 1.2 }}>
            <div>Campagna</div><div>Spesa</div><div>Vendite</div><div>ACoS</div><div>ROAS</div><div>Ordini</div>
          </div>
          <div style={{ maxHeight: 440, overflowY: "auto" }}>
            {Object.entries(metrics.campaigns).sort((a, b) => b[1].spend - a[1].spend).map(([name, d], i) => {
              const acos = d.sales > 0 ? ((d.spend / d.sales) * 100).toFixed(1) : "∞";
              const roas = d.spend > 0 ? (d.sales / d.spend).toFixed(2) : "0";
              const acosC = parseFloat(acos) > 40 ? C.red : parseFloat(acos) > 25 ? C.accent : C.green;
              return <div key={name} style={{ display: "grid", gridTemplateColumns: "2fr repeat(5, 1fr)", padding: "10px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 12, background: i % 2 ? "rgba(255,255,255,0.01)" : "transparent" }}>
                <div style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{d.status === "PAUSED" ? "⏸ " : ""}{name}</div>
                <div style={{ color: C.textMuted, fontFamily: "monospace" }}>€{d.spend.toFixed(2)}</div>
                <div style={{ color: C.textMuted, fontFamily: "monospace" }}>€{d.sales.toFixed(2)}</div>
                <div style={{ color: acosC, fontWeight: 600, fontFamily: "monospace" }}>{acos}%</div>
                <div style={{ color: C.textMuted, fontFamily: "monospace" }}>{roas}x</div>
                <div style={{ color: C.textMuted, fontFamily: "monospace" }}>{d.orders}</div>
              </div>;
            })}
          </div>
        </div>}

        {/* Keywords */}
        {tab === "keywords" && <div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
            {[["all", "Tutte"], ["waste", "🔴 Sprechi"], ["top", "🟢 Top"], ["active", "Attive"]].map(([v, l]) => (
              <button key={v} onClick={() => setKwFilter(v)} style={{ background: kwFilter === v ? C.accentGlow : C.surface, border: `1px solid ${kwFilter === v ? C.accent : C.border}`, borderRadius: 5, padding: "5px 10px", fontSize: 11, color: kwFilter === v ? C.accent : C.textMuted, cursor: "pointer" }}>{l}</button>
            ))}
            <div style={{ flex: 1 }} />
            <select value={kwSort} onChange={e => setKwSort(e.target.value)} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 5, padding: "5px 8px", fontSize: 11, color: C.textMuted, outline: "none" }}>
              <option value="spend">Sort: Spesa</option><option value="acos">Sort: ACoS</option>
              <option value="sales">Sort: Vendite</option><option value="clicks">Sort: Click</option>
            </select>
          </div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr 1fr", padding: "8px 12px", borderBottom: `1px solid ${C.border}`, fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: 1 }}>
              <div>Keyword</div><div>Spesa</div><div>Vendite</div><div>ACoS</div><div>Click</div><div>CVR</div><div>Match</div>
            </div>
            <div style={{ maxHeight: 420, overflowY: "auto" }}>
              {sortedKws.slice(0, 50).map((k, i) => {
                const acosC = k.orders === 0 && k.spend > 0 ? C.red : k.acos < 25 ? C.green : k.acos < 40 ? C.accent : C.red;
                return <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr 1fr", padding: "8px 12px", borderBottom: `1px solid ${C.border}`, fontSize: 11, background: i % 2 ? "rgba(255,255,255,0.01)" : "transparent" }}>
                  <div style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.keyword}</div>
                  <div style={{ color: C.textMuted, fontFamily: "monospace" }}>€{k.spend.toFixed(2)}</div>
                  <div style={{ color: C.textMuted, fontFamily: "monospace" }}>€{k.sales.toFixed(2)}</div>
                  <div style={{ color: acosC, fontWeight: 600, fontFamily: "monospace" }}>{k.acos > 900 ? "∞" : k.acos.toFixed(1) + "%"}</div>
                  <div style={{ color: C.textMuted, fontFamily: "monospace" }}>{k.clicks}</div>
                  <div style={{ color: C.textMuted, fontFamily: "monospace" }}>{k.cvr.toFixed(1)}%</div>
                  <div style={{ color: C.textDim, fontSize: 10 }}>{k.matchType}</div>
                </div>;
              })}
            </div>
            <div style={{ padding: "8px 12px", borderTop: `1px solid ${C.border}`, fontSize: 11, color: C.textDim }}>
              Mostrando {Math.min(50, sortedKws.length)} di {sortedKws.length} keywords
            </div>
          </div>
        </div>}

        {/* Search Terms */}
        {tab === "searchterms" && metrics.searchTerms?.length > 0 && <div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1.5fr 1fr 1fr 1fr 1fr", padding: "8px 12px", borderBottom: `1px solid ${C.border}`, fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: 1 }}>
              <div>Search Term</div><div>Keyword</div><div>Spesa</div><div>Ordini</div><div>ACoS</div><div>Match</div>
            </div>
            <div style={{ maxHeight: 440, overflowY: "auto" }}>
              {metrics.searchTerms.filter(s => s.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, 60).map((s, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 1.5fr 1fr 1fr 1fr 1fr", padding: "8px 12px", borderBottom: `1px solid ${C.border}`, fontSize: 11, background: s.orders === 0 ? C.redDim : i % 2 ? "rgba(255,255,255,0.01)" : "transparent" }}>
                  <div style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.searchTerm}</div>
                  <div style={{ color: C.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10 }}>{s.keyword}</div>
                  <div style={{ color: C.textMuted, fontFamily: "monospace" }}>€{s.spend.toFixed(2)}</div>
                  <div style={{ color: s.orders > 0 ? C.green : C.red, fontWeight: 600, fontFamily: "monospace" }}>{s.orders}</div>
                  <div style={{ color: s.orders === 0 ? C.red : s.acos < 25 ? C.green : C.accent, fontFamily: "monospace" }}>{s.acos > 900 ? "∞" : s.acos.toFixed(1) + "%"}</div>
                  <div style={{ color: C.textDim, fontSize: 10 }}>{s.matchType}</div>
                </div>
              ))}
            </div>
          </div>
        </div>}

        {/* AI */}
        {tab === "ai" && <AiAdvisor metrics={metrics} sourceType={sourceType} apiKey={apiKey} />}

        {/* Azioni: revisione, conferma, aggiunta e apply */}
        {tab === "actions" && <div>
          {metrics.weeklyAnalysis && (
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 8 }}>📋 Report Claude ({metrics.generatedAt ? new Date(metrics.generatedAt).toLocaleString("it-IT") : "settimanale"})</div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.6, color: C.textMuted, maxHeight: 260, overflowY: "auto" }}>{metrics.weeklyAnalysis}</div>
            </div>
          )}
          <ActionsPanel initialActions={metrics.proposedActions || []} marketplace={metrics.meta?.marketplace || ""} />
        </div>}
      </div>
    </div>
  );
}
