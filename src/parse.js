// Parsing dei dati Amazon (JSON dell'API e CSV di Seller Central).
// Estratto da App.jsx: senza JSX si puo' testare da solo con node.

// ---------------------------------------------------------------- parsing

/**
 * Numeri in formato europeo E anglosassone.
 * Il vecchio parser faceva `replace(/[,]/g,"")` PRIMA di gestire la virgola
 * decimale: "12,34" diventava 1234, cioe' 100 volte il valore reale su ogni
 * export italiano/francese/tedesco di Seller Central.
 */
export function parseNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  let s = String(v ?? "").replace(/[€$%\s\u00a0]/g, "").trim();
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s);
  if (neg) s = s.slice(1, -1);
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // Il separatore piu' a destra e' quello decimale.
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma > -1) {
    const decimals = s.length - lastComma - 1;
    s = decimals > 0 && decimals <= 2 ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (lastDot > -1) {
    // "1.234" e' ambiguo. Negli export IT/FR/DE il punto separa le migliaia
    // (impression, click), e gli importi hanno sempre 2 decimali. Quindi:
    // esattamente 3 cifre dopo il punto = migliaia, tranne quando la parte
    // intera e' 0 (es. "0.450" e' un bid, non 450).
    const decimals = s.length - lastDot - 1;
    if (decimals === 3 && s.slice(0, lastDot) !== "0") s = s.replace(/\./g, "");
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}

export function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  // Gli export europei usano spesso il punto e virgola.
  const candidates = ["\t", ";", ","];
  const sep = candidates.reduce((best, c) => (
    (lines[0].split(c).length > lines[0].split(best).length ? c : best)
  ), ",");

  const parseRow = (line) => {
    const out = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }  // "" = virgoletta letterale
        else inQ = !inQ;
      } else if (ch === sep && !inQ) { out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };

  const headers = parseRow(lines[0]);
  const rows = lines.slice(1).map((l) => {
    const v = parseRow(l);
    const o = {};
    headers.forEach((h, i) => { o[h] = v[i] || ""; });
    return o;
  });
  return { headers, rows };
}

export function processJSON(json) {
  const num = parseNumber;

  // --- indici strutturali: qui stanno bid, stato e nomi veri ---------------
  const campById = new Map();
  (json.campaigns || []).forEach((c) => {
    const id = String(c.campaignId || "");
    if (!id) return;
    campById.set(id, {
      campaignId: id, name: c.name || "", state: c.state || "",
      budget: typeof c.budget === "object" ? num(c.budget?.budget) : num(c.budget),
      targetingType: c.targetingType || "", bidding: c.bidding || {},
    });
  });
  const kwById = new Map();
  (json.keywords || []).forEach((k) => {
    const id = String(k.keywordId || "");
    if (id) kwById.set(id, { bid: num(k.bid), state: k.state || "", campaignId: String(k.campaignId || ""), adGroupId: String(k.adGroupId || "") });
  });
  const agById = new Map();
  (json.adGroups || []).forEach((g) => {
    const id = String(g.adGroupId || "");
    if (id) agById.set(id, { name: g.name || "", state: g.state || "", campaignId: String(g.campaignId || ""), defaultBid: num(g.defaultBid) });
  });
  const campName = (id, fallback = "") => campById.get(String(id))?.name || fallback;

  const m = {
    totalSpend: 0, totalSales: 0, totalImpress: 0, totalClicks: 0, totalOrders: 0,
    campaigns: {}, keywords: [], negativeKeywords: [], products: [], searchTerms: [],
    adGroupIds: [...agById.keys()],
  };

  (json.reports?.campaigns || []).forEach((r) => {
    const id = String(r.campaignId || "");
    const name = r.campaignName || r.campaign_name || campName(id) || "N/A";
    const key = id || name;
    const spend = num(r.cost ?? r.spend);
    const sales = num(r.sales7d ?? r.sales14d ?? r.sales ?? r.attributedSales7d);
    const impr = num(r.impressions);
    const clicks = num(r.clicks);
    const orders = num(r.purchases7d ?? r.purchases14d ?? r.orders ?? r.unitsSoldClicks7d);
    m.totalSpend += spend; m.totalSales += sales; m.totalImpress += impr;
    m.totalClicks += clicks; m.totalOrders += orders;

    const known = campById.get(id) || {};
    const c = m.campaigns[key] || (m.campaigns[key] = {
      campaignId: id, name, spend: 0, sales: 0, impressions: 0, clicks: 0, orders: 0,
      status: known.state || r.campaignStatus || "", budget: known.budget || num(r.campaignBudgetAmount),
      targetingType: known.targetingType || "",
    });
    c.spend += spend; c.sales += sales; c.impressions += impr; c.clicks += clicks; c.orders += orders;
  });

  // Campagne senza righe di report: mostrarle comunque evita di farle sparire.
  campById.forEach((c, id) => {
    if (!m.campaigns[id]) {
      m.campaigns[id] = {
        campaignId: id, name: c.name, spend: 0, sales: 0, impressions: 0, clicks: 0,
        orders: 0, status: c.state, budget: c.budget, targetingType: c.targetingType,
      };
    }
  });

  (json.reports?.keywords || []).forEach((r) => {
    const kid = String(r.keywordId || "");
    const meta = kwById.get(kid) || {};
    const spend = num(r.cost ?? r.spend);
    const sales = num(r.sales7d ?? r.sales14d ?? r.sales);
    const impr = num(r.impressions);
    const clicks = num(r.clicks);
    const orders = num(r.purchases7d ?? r.purchases14d ?? r.orders ?? r.unitsSoldClicks7d);
    const cid = String(r.campaignId || meta.campaignId || "");
    m.keywords.push({
      keywordId: kid,
      campaignId: cid,
      adGroupId: String(r.adGroupId || meta.adGroupId || ""),
      keyword: r.keyword || r.keywordText || "",
      campaign: r.campaignName || campName(cid),
      adGroup: r.adGroupName || r.ad_group_name || "",
      matchType: r.matchType || r.match_type || "",
      // Il report NON contiene il bid: si prende dalla lista keyword.
      bid: meta.bid ?? num(r.keywordBid ?? r.bid),
      state: meta.state || "",
      spend, sales, impressions: impr, clicks, orders,
      acos: sales > 0 ? (spend / sales) * 100 : spend > 0 ? 999 : 0,
      ctr: impr > 0 ? (clicks / impr) * 100 : 0,
      cvr: clicks > 0 ? (orders / clicks) * 100 : 0,
      cpc: clicks > 0 ? spend / clicks : 0,
    });
  });

  m.searchTerms = (json.reports?.searchTerms || []).map((r) => {
    const spend = num(r.cost ?? r.spend);
    const sales = num(r.sales7d ?? r.sales14d ?? r.sales);
    const impr = num(r.impressions);
    const clicks = num(r.clicks);
    const orders = num(r.purchases7d ?? r.unitsSoldClicks7d ?? r.orders);
    const cid = String(r.campaignId || "");
    return {
      searchTerm: r.searchTerm || r.query || "",
      keyword: r.keyword || r.keywordText || "",
      campaignId: cid, adGroupId: String(r.adGroupId || ""),
      campaign: r.campaignName || campName(cid),
      adGroup: r.adGroupName || "", matchType: r.matchType || "",
      spend, sales, impressions: impr, clicks, orders,
      acos: sales > 0 ? (spend / sales) * 100 : spend > 0 ? 999 : 0,
      ctr: impr > 0 ? (clicks / impr) * 100 : 0,
      cvr: clicks > 0 ? (orders / clicks) * 100 : 0,
    };
  });

  m.products = (json.reports?.products || []).map((r) => ({
    asin: r.advertisedAsin || r.asin || "", sku: r.advertisedSku || r.sku || "",
    campaign: r.campaignName || campName(r.campaignId), adGroupId: String(r.adGroupId || ""),
    spend: num(r.cost ?? r.spend), sales: num(r.sales7d ?? r.sales), clicks: num(r.clicks),
    impressions: num(r.impressions), orders: num(r.purchases7d ?? r.unitsSoldClicks7d),
  }));

  m.negativeKeywords = json.negativeKeywords || [];
  m.acos = m.totalSales > 0 ? (m.totalSpend / m.totalSales) * 100 : 0;
  m.ctr = m.totalImpress > 0 ? (m.totalClicks / m.totalImpress) * 100 : 0;
  m.cvr = m.totalClicks > 0 ? (m.totalOrders / m.totalClicks) * 100 : 0;
  m.cpc = m.totalClicks > 0 ? m.totalSpend / m.totalClicks : 0;
  m.meta = json._meta || {};
  m.weeklyAnalysis = json.analysis || null;
  m.proposedActions = json.actions?.actions || [];
  m.generatedAt = json.generated_at || null;
  // Distinzione importante per i messaggi in interfaccia:
  //  - hasPerformance: ci sono righe di report? Se no, il file ha la struttura
  //    delle campagne ma nessun numero (tipico di un report rifiutato da Amazon).
  //  - hasIds: le keyword hanno un ID? Se no, le azioni non sono applicabili.
  const reportRows = ["campaigns", "keywords", "searchTerms", "targeting", "products"]
    .reduce((n, k) => n + (json.reports?.[k]?.length || 0), 0);
  m.hasPerformance = reportRows > 0;
  m.hasIds = m.keywords.some((k) => k.keywordId)
    || (json.keywords || []).some((k) => k.keywordId);
  m.structuralKeywords = (json.keywords || []).length;
  return m;
}

export function processCSV(parsed) {
  const { headers, rows } = parsed;
  const num = parseNumber;
  const findCol = (kws) => headers.find((h) => {
    const hl = h.toLowerCase();
    return kws.some((k) => hl.includes(k));
  });
  const cols = {
    spend: findCol(["spend", "spesa", "cost", "costo", "ausgaben"]),
    sales: findCol(["sales", "vendite", "revenue", "umsatz", "7 day", "14 day"]),
    impressions: findCol(["impression", "visualizzazioni", "anzeigen"]),
    clicks: findCol(["click", "klick"]),
    orders: findCol(["order", "ordini", "conversion", "purchase", "units", "bestellungen"]),
    campaign: findCol(["campaign name", "nome campagna", "campaign", "kampagne"]),
    keyword: findCol(["keyword", "targeting", "search term", "parola chiave"]),
    match: findCol(["match type", "tipo di corrispondenza", "tipo"]),
    bid: findCol(["bid", "offerta", "gebot"]),
    adGroup: findCol(["ad group", "gruppo", "anzeigengruppe"]),
  };

  const m = {
    totalSpend: 0, totalSales: 0, totalImpress: 0, totalClicks: 0, totalOrders: 0,
    campaigns: {}, keywords: [], searchTerms: [], negativeKeywords: [], products: [],
    adGroupIds: [], hasIds: false,
  };

  rows.forEach((r) => {
    const spend = num(r[cols.spend]), sales = num(r[cols.sales]);
    const impr = num(r[cols.impressions]), clicks = num(r[cols.clicks]), orders = num(r[cols.orders]);
    const camp = r[cols.campaign] || "N/A";
    m.totalSpend += spend; m.totalSales += sales; m.totalImpress += impr;
    m.totalClicks += clicks; m.totalOrders += orders;
    const c = m.campaigns[camp] || (m.campaigns[camp] = {
      campaignId: "", name: camp, spend: 0, sales: 0, impressions: 0, clicks: 0, orders: 0, status: "", budget: 0,
    });
    c.spend += spend; c.sales += sales; c.impressions += impr; c.clicks += clicks; c.orders += orders;

    const kw = r[cols.keyword] || "";
    if (kw) {
      m.keywords.push({
        keywordId: "", campaignId: "", adGroupId: "",
        keyword: kw, campaign: camp, adGroup: r[cols.adGroup] || "",
        matchType: r[cols.match] || "", bid: num(r[cols.bid]), state: "",
        spend, sales, impressions: impr, clicks, orders,
        acos: sales > 0 ? (spend / sales) * 100 : spend > 0 ? 999 : 0,
        ctr: impr > 0 ? (clicks / impr) * 100 : 0,
        cvr: clicks > 0 ? (orders / clicks) * 100 : 0,
        cpc: clicks > 0 ? spend / clicks : 0,
      });
    }
  });

  m.acos = m.totalSales > 0 ? (m.totalSpend / m.totalSales) * 100 : 0;
  m.ctr = m.totalImpress > 0 ? (m.totalClicks / m.totalImpress) * 100 : 0;
  m.cvr = m.totalClicks > 0 ? (m.totalOrders / m.totalClicks) * 100 : 0;
  m.cpc = m.totalClicks > 0 ? m.totalSpend / m.totalClicks : 0;
  m.meta = {};
  m.proposedActions = [];
  return m;
}

