import { useEffect, useMemo, useRef, useState } from "react";
import { C, F, T, S, R, button, input, card } from "./theme";
import {
  ACTION_TYPES, GROUP_ORDER, KW_MATCH, NEG_MATCH, GUARDRAILS,
  normalizeAction, validateAction, isValidAction, describeAction,
  editableField, estimatedSaving, toPayload,
} from "./actions";
import {
  startDeviceFlow, pollForToken, getUser, checkRepoAccess, dispatchWorkflow,
  latestRunId, waitForNewRun, followRun,
} from "./github";

/**
 * Su GitHub Pages l'URL contiene gia' owner e repo:
 * https://carlojan76.github.io/amazon-ads-agent/ -> carlojan76/amazon-ads-agent
 * Meglio dedurlo che chiederlo: era il campo piu' facile da lasciare vuoto.
 */
function guessRepoFromUrl() {
  try {
    const host = window.location.hostname;
    const m = /^([\w-]+)\.github\.io$/.exec(host);
    if (!m) return "";
    const seg = window.location.pathname.split("/").filter(Boolean)[0];
    return seg ? `${m[1]}/${seg}` : "";
  } catch {
    return "";
  }
}

const isValidRepo = (s) => /^[\w.-]+\/[\w.-]+$/.test((s || "").trim());

let uid = 0;
const nextId = () => `a${Date.now()}_${uid++}`;

/** Firma stabile di un'azione: serve a riconoscerla tra un caricamento e l'altro. */
const signature = (a) =>
  [a.type, a.keywordId || "", a.campaignId || "", a.adGroupId || "",
    (a.keywordText || "").toLowerCase(), a.matchType || ""].join("|");

const TONE = { red: C.red, green: C.green, yellow: C.yellow, blue: C.blue };

// GitHub rifiuta gli input di workflow_dispatch oltre ~64 KB.
const MAX_INPUT_BYTES = 60000;

const ls = {
  get(k, fallback) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } },
};

// ---------------------------------------------------------------- pezzi UI

function Chip({ children, color = C.textMuted, bg = "transparent", title }) {
  return (
    <span title={title} style={{
      background: bg, color, border: `1px solid ${bg === "transparent" ? C.border : "transparent"}`,
      borderRadius: R.pill, padding: "2px 8px", fontSize: T.micro, fontWeight: 600,
      whiteSpace: "nowrap", fontFamily: F.ui,
    }}>{children}</span>
  );
}

function Stat({ label, value, color = C.text }) {
  return (
    <div style={{ minWidth: 96 }}>
      <div style={{ fontSize: T.micro, color: C.textDim, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: T.lead, fontWeight: 700, color, fontFamily: F.mono }}>{value}</div>
    </div>
  );
}

function Row({ action, onToggle, onEdit, onRemove }) {
  const { errors, warnings } = validateAction(action);
  const valid = errors.length === 0;
  const meta = ACTION_TYPES[action.type] || {};
  const d = describeAction(action);
  const ed = editableField(action);
  const saving = estimatedSaving(action);
  const tone = TONE[meta.tone] || C.textMuted;

  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: S.md, padding: `${S.md}px ${S.lg}px`,
      borderBottom: `1px solid ${C.border}`,
      background: !valid ? C.redDim : action.included ? "transparent" : "rgba(255,255,255,0.015)",
      opacity: valid && !action.included ? 0.55 : 1,
    }}>
      <input
        type="checkbox" checked={!!action.included} disabled={!valid}
        onChange={() => onToggle(action.id)}
        aria-label={`Includi: ${d.title} ${d.detail}`}
        style={{ width: 17, height: 17, marginTop: 2, flexShrink: 0, cursor: valid ? "pointer" : "not-allowed" }}
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: S.sm, flexWrap: "wrap" }}>
          <span aria-hidden style={{ fontSize: T.body }}>{meta.icon}</span>
          <span style={{ fontFamily: F.mono, fontSize: T.body, color: C.text, fontWeight: 600 }}>{d.title}</span>
          {d.delta && (
            <Chip color={d.deltaUp ? C.green : C.yellow} bg={d.deltaUp ? C.greenDim : C.yellowDim}>{d.delta}</Chip>
          )}
          {action.source === "ai" && <Chip color={C.purple} bg={C.purpleDim} title="Proposta dal Consulente in questa sessione">AI</Chip>}
          {action.source === "manual" && <Chip color={C.blue} bg={C.blueDim}>manuale</Chip>}
        </div>

        <div style={{ fontSize: T.small, color: C.textMuted, marginTop: 3, fontFamily: F.ui }}>{d.detail}</div>

        {action.reason && (
          <div style={{ fontSize: T.small, color: C.textDim, marginTop: 4, lineHeight: 1.5 }}>
            {action.reason}
          </div>
        )}

        {errors.map((e, i) => (
          <div key={`e${i}`} style={{ fontSize: T.micro, color: C.red, marginTop: 4 }}>⚠ {e}</div>
        ))}
        {warnings.map((w, i) => (
          <div key={`w${i}`} style={{ fontSize: T.micro, color: C.yellow, marginTop: 4 }}>⚠ {w}</div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: S.sm, flexShrink: 0 }}>
        {typeof saving === "number" && (
          <Chip color={C.green} bg={C.greenDim} title="Impatto stimato sul periodo analizzato">
            ≈ €{saving.toFixed(2)}
          </Chip>
        )}
        {ed && (
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: T.micro, color: C.textDim }}>{ed.prefix}</span>
            <input
              type="number" step={ed.step} min={0} value={action[ed.field] ?? ""}
              aria-label={ed.label}
              onChange={(e) => onEdit(action.id, ed.field, e.target.value === "" ? "" : parseFloat(e.target.value))}
              style={{ ...input, width: 78, padding: "5px 7px", fontFamily: F.mono, color: C.accent, fontSize: T.small }}
            />
          </label>
        )}
        <button onClick={() => onRemove(action.id)} title="Rimuovi dall'elenco" aria-label="Rimuovi"
          style={{ ...button("quiet", { small: true }), padding: "4px 7px", fontSize: T.body }}>✕</button>
      </div>
    </div>
  );
}

function AddActionForm({ onAdd, onCancel }) {
  const [type, setType] = useState("add_negative");
  const [f, setF] = useState({});
  const [err, setErr] = useState([]);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const submit = () => {
    const a = normalizeAction({ type, ...f });
    const { errors } = validateAction(a);
    if (errors.length) { setErr(errors); return; }
    onAdd(a);
    setF({}); setErr([]);
  };

  const label = { fontSize: T.micro, color: C.textDim, marginBottom: 3, display: "block" };
  const field = (k, text, numeric = false, ph = "") => (
    <label key={k} style={{ flex: "1 1 150px", minWidth: 140 }}>
      <span style={label}>{text}</span>
      <input value={f[k] ?? ""} onChange={(e) => set(k, e.target.value)} placeholder={ph}
        type={numeric ? "number" : "text"} step={numeric ? "0.01" : undefined}
        style={{ ...input, width: "100%", fontFamily: numeric ? F.mono : F.ui }} />
    </label>
  );

  const needs = {
    add_negative: [field("campaignId", "ID campagna", false, "es. 123456789"),
      field("campaign", "Nome campagna (facoltativo)"),
      field("adGroupId", "ID ad group (vuoto = tutta la campagna)"),
      field("keywordText", "Testo da escludere", false, "es. gratis")],
    add_keyword: [field("campaignId", "ID campagna"), field("adGroupId", "ID ad group"),
      field("keywordText", "Testo della keyword"), field("bid", "Bid €", true)],
    update_bid: [field("keywordId", "ID keyword"), field("keyword", "Nome keyword (facoltativo)"),
      field("old_bid", "Bid attuale €", true), field("new_bid", "Nuovo bid €", true)],
    pause_keyword: [field("keywordId", "ID keyword"), field("keyword", "Nome keyword (facoltativo)")],
    enable_keyword: [field("keywordId", "ID keyword"), field("keyword", "Nome keyword (facoltativo)")],
    update_budget: [field("campaignId", "ID campagna"), field("campaign", "Nome campagna (facoltativo)"),
      field("old_budget", "Budget attuale €", true), field("new_budget", "Nuovo budget €", true)],
  }[type] || [];

  return (
    <div style={{ ...card, background: C.surface2, padding: S.lg, marginBottom: S.md }}>
      <div style={{ display: "flex", gap: S.md, flexWrap: "wrap", marginBottom: S.md }}>
        <label style={{ flex: "1 1 220px" }}>
          <span style={label}>Cosa vuoi fare</span>
          <select value={type} onChange={(e) => { setType(e.target.value); setF({}); setErr([]); }}
            style={{ ...input, width: "100%" }}>
            {Object.entries(ACTION_TYPES).filter(([, m]) => !m.risky).map(([v, m]) => (
              <option key={v} value={v}>{m.icon} {m.label}</option>
            ))}
          </select>
        </label>
        {type === "add_negative" && (
          <label style={{ flex: "1 1 160px" }}>
            <span style={label}>Corrispondenza</span>
            <select value={f.matchType || "NEGATIVE_EXACT"} onChange={(e) => set("matchType", e.target.value)}
              style={{ ...input, width: "100%" }}>
              <option value="NEGATIVE_EXACT">Esatta</option>
              <option value="NEGATIVE_PHRASE">Frase</option>
            </select>
          </label>
        )}
        {type === "add_keyword" && (
          <label style={{ flex: "1 1 160px" }}>
            <span style={label}>Corrispondenza</span>
            <select value={f.matchType || "EXACT"} onChange={(e) => set("matchType", e.target.value)}
              style={{ ...input, width: "100%" }}>
              {KW_MATCH.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        )}
      </div>

      <div style={{ fontSize: T.micro, color: C.textDim, marginBottom: S.sm }}>
        {ACTION_TYPES[type]?.blurb} Gli ID si trovano nelle schede Campagne e Keywords.
      </div>

      <div style={{ display: "flex", gap: S.md, flexWrap: "wrap", marginBottom: S.md }}>{needs}</div>

      {err.map((e, i) => <div key={i} style={{ fontSize: T.micro, color: C.red, marginBottom: 4 }}>⚠ {e}</div>)}

      <div style={{ display: "flex", gap: S.sm, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={button("ghost", { small: true })}>Annulla</button>
        <button onClick={submit} style={button("primary", { small: true })}>Aggiungi all'elenco</button>
      </div>
    </div>
  );
}

function RunStatus({ run }) {
  if (!run) return null;
  const map = {
    queued: { label: "In coda su GitHub…", color: C.blue },
    in_progress: { label: "In esecuzione…", color: C.blue },
    completed: run.conclusion === "success"
      ? { label: "Completato con successo", color: C.green }
      : { label: `Terminato: ${run.conclusion || "errore"}`, color: C.red },
  };
  const s = map[run.status] || { label: run.status, color: C.textMuted };
  const spinning = run.status !== "completed";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: S.sm, marginTop: S.md,
      padding: `${S.sm}px ${S.md}px`, borderRadius: R.md,
      background: s.color === C.red ? C.redDim : s.color === C.green ? C.greenDim : C.blueDim,
    }}>
      {spinning && <span style={{
        width: 13, height: 13, border: `2px solid ${C.border}`, borderTopColor: s.color,
        borderRadius: "50%", animation: "spin .7s linear infinite", display: "inline-block",
      }} />}
      <span style={{ fontSize: T.small, color: s.color, fontWeight: 600 }}>{s.label}</span>
      {run.html_url && (
        <a href={run.html_url} target="_blank" rel="noreferrer"
          style={{ fontSize: T.small, color: C.accent, marginLeft: "auto" }}>apri il log →</a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- pannello

export default function ActionsPanel({ initialActions = [], marketplace = "", onSelectionChange }) {
  const storeKey = `aa_review_${marketplace || "default"}`;

  // ---- elenco azioni ----
  const [actions, setActions] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState({});

  // Ricostruisce l'elenco quando arrivano nuove proposte, conservando le tue
  // scelte (spunte e valori modificati) tramite la firma dell'azione.
  const incomingKey = useMemo(() => JSON.stringify(toPayload(initialActions)), [initialActions]);
  useEffect(() => {
    const saved = ls.get(storeKey, { overrides: {}, manual: [] });
    setActions((prev) => {
      const prevBySig = new Map(prev.filter((a) => a.source !== "manual").map((a) => [signature(a), a]));
      const rebuilt = initialActions.map((raw) => {
        const a = normalizeAction(raw);
        const sig = signature(a);
        const keep = prevBySig.get(sig);
        const ov = saved.overrides?.[sig];
        const merged = {
          ...a,
          id: keep?.id || nextId(),
          source: a.source || "weekly",
          included: keep ? keep.included : ov?.included ?? isValidAction(a),
        };
        for (const f of ["new_bid", "new_budget", "bid"]) {
          if (keep && f in keep) merged[f] = keep[f];
          else if (ov && f in ov) merged[f] = ov[f];
        }
        return merged;
      });
      const manual = prev.filter((a) => a.source === "manual");
      const restored = manual.length
        ? manual
        : (saved.manual || []).map((a) => ({ ...normalizeAction(a), id: nextId(), source: "manual", included: true }));
      return [...rebuilt, ...restored];
    });
  }, [incomingKey, storeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persiste le scelte, cosi' un refresh non cancella mezz'ora di revisione.
  useEffect(() => {
    if (!actions.length) return;
    const overrides = {};
    for (const a of actions) {
      if (a.source === "manual") continue;
      const o = { included: a.included };
      for (const f of ["new_bid", "new_budget", "bid"]) if (f in a) o[f] = a[f];
      overrides[signature(a)] = o;
    }
    ls.set(storeKey, { overrides, manual: toPayload(actions.filter((a) => a.source === "manual")) });
  }, [actions, storeKey]);

  const selected = useMemo(() => actions.filter((a) => a.included && isValidAction(a)), [actions]);
  const payload = useMemo(() => ({ actions: toPayload(selected) }), [selected]);
  const payloadJson = useMemo(() => JSON.stringify(payload), [payload]);

  useEffect(() => { onSelectionChange?.(selected.length); }, [selected.length]); // eslint-disable-line

  const toggle = (id) => setActions((p) => p.map((a) => (a.id === id ? { ...a, included: !a.included } : a)));
  const edit = (id, field, value) => setActions((p) => p.map((a) => (a.id === id ? { ...a, [field]: value } : a)));
  const remove = (id) => setActions((p) => p.filter((a) => a.id !== id));
  const addAction = (a) => {
    setActions((p) => [...p, { ...a, id: nextId(), included: true, source: "manual" }]);
    setShowAdd(false);
  };
  const setAll = (value, subset = null) => setActions((p) => p.map((a) => (
    (subset ? subset.has(a.id) : true) && isValidAction(a) ? { ...a, included: value } : a
  )));

  // ---- filtro + raggruppamento ----
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return actions.filter((a) => {
      if (filter !== "all" && (ACTION_TYPES[a.type]?.group || "") !== filter) return false;
      if (!q) return true;
      const d = describeAction(a);
      return `${d.title} ${d.detail} ${a.reason || ""}`.toLowerCase().includes(q);
    });
  }, [actions, filter, query]);

  const groups = useMemo(() => {
    const g = new Map();
    for (const a of visible) {
      const name = ACTION_TYPES[a.type]?.group || "Altro";
      if (!g.has(name)) g.set(name, []);
      g.get(name).push(a);
    }
    return [...g.entries()].sort(
      (x, y) => (GROUP_ORDER.indexOf(x[0]) + 99) % 99 - (GROUP_ORDER.indexOf(y[0]) + 99) % 99
    );
  }, [visible]);

  const totalSaving = useMemo(
    () => selected.reduce((s, a) => s + (estimatedSaving(a) || 0), 0), [selected]
  );
  const invalidCount = actions.filter((a) => !isValidAction(a)).length;

  // ---- connessione GitHub ----
  const [ghClientId, setGhClientId] = useState(() => localStorage.getItem("gh_client_id") || import.meta.env?.VITE_GITHUB_CLIENT_ID || "");
  const [ghRepo, setGhRepo] = useState(() =>
    localStorage.getItem("gh_repo") || import.meta.env?.VITE_GITHUB_REPO || guessRepoFromUrl());
  const [ghWorkflow, setGhWorkflow] = useState(() => localStorage.getItem("gh_workflow") || "apply-actions.yml");
  const [ghProxy, setGhProxy] = useState(() => localStorage.getItem("gh_device_proxy") || "");
  const [ghToken, setGhToken] = useState(() => localStorage.getItem("gh_token") || "");
  const [ghUser, setGhUser] = useState(null);
  const [ghMarketplace, setGhMarketplace] = useState(marketplace || "IT");
  const [showGhSettings, setShowGhSettings] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [showDeviceFlow, setShowDeviceFlow] = useState(false);
  const [accessNote, setAccessNote] = useState(null);

  useEffect(() => { localStorage.setItem("gh_client_id", ghClientId); }, [ghClientId]);
  useEffect(() => { localStorage.setItem("gh_repo", ghRepo); }, [ghRepo]);
  useEffect(() => { localStorage.setItem("gh_workflow", ghWorkflow); }, [ghWorkflow]);
  useEffect(() => { localStorage.setItem("gh_device_proxy", ghProxy); }, [ghProxy]);
  useEffect(() => { if (marketplace) setGhMarketplace(marketplace); }, [marketplace]);
  useEffect(() => {
    if (ghToken) {
      localStorage.setItem("gh_token", ghToken);
      getUser(ghToken).then(setGhUser).catch(() => { setGhToken(""); setGhUser(null); });
    } else { localStorage.removeItem("gh_token"); setGhUser(null); }
  }, [ghToken]);

  // Appena c'e' un token e un repo, verifica di poter davvero lanciare il
  // workflow: meglio saperlo ora che con un 403 al momento di applicare.
  useEffect(() => {
    const [owner, repo] = ghRepo.split("/").map((s) => s.trim());
    if (!ghUser || !owner || !repo) { setAccessNote(null); return; }
    let alive = true;
    checkRepoAccess({ token: ghToken, owner, repo, workflow: ghWorkflow })
      .then((r) => { if (alive) setAccessNote(r); });
    return () => { alive = false; };
  }, [ghUser, ghToken, ghRepo, ghWorkflow]);

  // ---- flusso applicazione ----
  const [busy, setBusy] = useState(null);          // "preview" | "apply"
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [previewedJson, setPreviewedJson] = useState(null);
  const [confirmText, setConfirmText] = useState("");
  const followRef = useRef(0);

  // Se cambi la selezione dopo l'anteprima, l'anteprima non vale piu'.
  const previewValid = previewedJson !== null && previewedJson === payloadJson;
  useEffect(() => { if (!previewValid) setConfirmText(""); }, [previewValid]);

  const tooBig = new Blob([payloadJson]).size > MAX_INPUT_BYTES;

  const connectWithToken = async () => {
    const t = tokenDraft.trim();
    if (!t) return;
    setConnecting(true); setError(null);
    try {
      const u = await getUser(t);
      setGhToken(t);
      setGhUser(u);
      setTokenDraft("");
    } catch (err) {
      setError(err.message);
    } finally { setConnecting(false); }
  };

  const connectGithub = async () => {
    if (!ghClientId) { setShowGhSettings(true); setError("Serve il Client ID dell'OAuth App: vedi il README."); return; }
    setConnecting(true); setError(null);
    try {
      const d = await startDeviceFlow(ghClientId, "repo", ghProxy);
      setDeviceInfo({ user_code: d.user_code, verification_uri: d.verification_uri, secondsLeft: d.expires_in });
      const token = await pollForToken(ghClientId, d.device_code, d.interval, d.expires_in,
        (s) => setDeviceInfo((p) => p && { ...p, secondsLeft: s }), ghProxy);
      setGhToken(token);
      setDeviceInfo(null);
    } catch (err) {
      setError(err.message); setDeviceInfo(null);
    } finally { setConnecting(false); }
  };

  const launch = async (dryRun) => {
    const [owner, repo] = ghRepo.split("/").map((s) => s.trim());
    if (!isValidRepo(ghRepo)) {
      setError('Manca il repository di destinazione: scrivilo come "owner/repo" '
        + '(es. carlojan76/amazon-ads-agent) nel pannello Configurazione, che ho appena aperto.');
      setShowGhSettings(true);
      return;
    }
    setBusy(dryRun ? "preview" : "apply");
    setError(null); setRun(null);

    const token = ghToken;
    const myFollow = ++followRef.current;
    try {
      const before = await latestRunId({ token, owner, repo, workflow: ghWorkflow }).catch(() => null);
      await dispatchWorkflow({
        token, owner, repo, workflow: ghWorkflow,
        inputs: {
          marketplace: ghMarketplace,
          actions_json: payloadJson,
          confirm: dryRun ? "NO" : "APPLICA",
          dry_run: String(dryRun),
        },
      });
      setRun({ status: "queued" });
      const fresh = await waitForNewRun({ token, owner, repo, workflow: ghWorkflow, afterId: before });
      if (!fresh) { setRun({ status: "queued", html_url: `https://github.com/${owner}/${repo}/actions` }); return; }
      setRun({ status: fresh.status, conclusion: fresh.conclusion, html_url: fresh.html_url });
      const final = await followRun({
        token, owner, repo, runId: fresh.id,
        onUpdate: (info) => { if (followRef.current === myFollow) setRun(info); },
      });
      if (followRef.current !== myFollow) return;
      if (dryRun && final?.conclusion === "success") {
        setPreviewedJson(payloadJson);      // sblocca il pulsante "Applica"
      }
      if (!dryRun && final?.conclusion === "success") {
        setPreviewedJson(null);
        setConfirmText("");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `actions_${ghMarketplace || "confirmed"}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const repoOk = isValidRepo(ghRepo);
  const canPreview = selected.length > 0 && ghUser && repoOk && !busy && !tooBig;
  const canApply = canPreview && previewValid && confirmText === "APPLICA";

  // ---------------------------------------------------------------- render
  return (
    <div style={{ fontFamily: F.ui }}>
      {/* Riepilogo */}
      <div style={{ ...card, padding: S.lg, marginBottom: S.md, display: "flex", gap: S.xl, flexWrap: "wrap", alignItems: "center" }}>
        <Stat label="Proposte" value={actions.length} />
        <Stat label="Selezionate" value={selected.length} color={selected.length ? C.accent : C.textDim} />
        {totalSaving > 0 && <Stat label="Impatto stimato" value={`€${totalSaving.toFixed(2)}`} color={C.green} />}
        {invalidCount > 0 && <Stat label="Non applicabili" value={invalidCount} color={C.red} />}
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowAdd((v) => !v)} style={button("accentGhost", { small: true })}>
          {showAdd ? "✕ Chiudi" : "+ Azione manuale"}
        </button>
      </div>

      {showAdd && <AddActionForm onAdd={addAction} onCancel={() => setShowAdd(false)} />}

      {/* Barra strumenti */}
      {actions.length > 0 && (
        <div style={{ display: "flex", gap: S.sm, flexWrap: "wrap", alignItems: "center", marginBottom: S.md }}>
          <button onClick={() => setAll(true)} style={button("ghost", { small: true })}>Seleziona tutto</button>
          <button onClick={() => setAll(false)} style={button("ghost", { small: true })}>Deseleziona</button>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}
            aria-label="Filtra per categoria" style={{ ...input, padding: "6px 9px", fontSize: T.small }}>
            <option value="all">Tutte le categorie</option>
            {GROUP_ORDER.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cerca keyword o campagna…"
            aria-label="Cerca tra le azioni"
            style={{ ...input, flex: "1 1 200px", padding: "6px 10px", fontSize: T.small }} />
        </div>
      )}

      {/* Elenco */}
      <div style={{ ...card, overflow: "hidden", marginBottom: S.lg }}>
        {actions.length === 0 ? (
          <div style={{ padding: S.xxl, textAlign: "center" }}>
            <div style={{ fontSize: 26, marginBottom: S.sm }}>📭</div>
            <div style={{ fontSize: T.body, color: C.text, fontWeight: 600, marginBottom: 4 }}>
              Nessuna azione da rivedere
            </div>
            <div style={{ fontSize: T.small, color: C.textMuted, lineHeight: 1.6, maxWidth: 420, margin: "0 auto" }}>
              Apri la scheda <strong style={{ color: C.accent }}>Consulente</strong> e premi
              “Analizza le campagne”: i consigli con un ID valido compaiono qui, pronti da rivedere.
              Oppure creane una tu con “+ Azione manuale”.
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div style={{ padding: S.xl, textAlign: "center", fontSize: T.small, color: C.textMuted }}>
            Nessuna azione corrisponde al filtro.
          </div>
        ) : (
          groups.map(([name, rows]) => {
            const ids = new Set(rows.map((r) => r.id));
            const on = rows.filter((r) => r.included).length;
            const isCollapsed = collapsed[name];
            return (
              <div key={name}>
                <div style={{
                  display: "flex", alignItems: "center", gap: S.sm, padding: `${S.sm}px ${S.lg}px`,
                  background: C.surface2, borderBottom: `1px solid ${C.border}`,
                }}>
                  <button onClick={() => setCollapsed((c) => ({ ...c, [name]: !c[name] }))}
                    aria-expanded={!isCollapsed}
                    style={{ ...button("quiet", { small: true }), padding: 2, color: C.textMuted }}>
                    {isCollapsed ? "▸" : "▾"}
                  </button>
                  <span style={{ fontSize: T.small, fontWeight: 700, color: C.text }}>{name}</span>
                  <Chip>{on}/{rows.length}</Chip>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => setAll(on < rows.length, ids)} style={{ ...button("quiet", { small: true }), color: C.accent }}>
                    {on < rows.length ? "seleziona gruppo" : "deseleziona gruppo"}
                  </button>
                </div>
                {!isCollapsed && rows.map((a) => (
                  <Row key={a.id} action={a} onToggle={toggle} onEdit={edit} onRemove={remove} />
                ))}
              </div>
            );
          })
        )}
      </div>

      {/* Applicazione */}
      <div style={{ ...card, padding: S.lg }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: S.md, flexWrap: "wrap", gap: S.sm }}>
          <div style={{ fontSize: T.lead, fontWeight: 700, color: C.text }}>Applica le modifiche</div>
          <div style={{ display: "flex", gap: S.sm }}>
            <button onClick={downloadJson} disabled={!selected.length}
              style={button("ghost", { small: true, disabled: !selected.length })}>⬇ Scarica JSON</button>
            <button onClick={() => setShowGhSettings((v) => !v)} style={button("quiet", { small: true })}>⚙ Configurazione</button>
          </div>
        </div>

        {showGhSettings && (
          <div style={{ background: C.surface2, borderRadius: R.md, padding: S.md, marginBottom: S.md, display: "grid", gap: S.sm }}>
            <label>
              <span style={{ fontSize: T.micro, color: C.textDim }}>Client ID OAuth App (serve solo per il Device Flow con proxy)</span>
              <input value={ghClientId} onChange={(e) => setGhClientId(e.target.value)} placeholder="Iv1.xxxxxxxxxxxx"
                style={{ ...input, width: "100%", fontFamily: F.mono }} />
            </label>
            <label>
              <span style={{ fontSize: T.micro, color: C.textDim }}>Repository</span>
              <input value={ghRepo} onChange={(e) => setGhRepo(e.target.value)} placeholder="tuo-utente/amazon-ads-agent"
                style={{ ...input, width: "100%", fontFamily: F.mono,
                  borderColor: ghRepo && !isValidRepo(ghRepo) ? C.red : C.borderStrong }} />
              {ghRepo && !isValidRepo(ghRepo) && (
                <span style={{ fontSize: T.micro, color: C.red }}>
                  Formato atteso: owner/repo, senza https:// e senza .git
                </span>
              )}
            </label>
            <label>
              <span style={{ fontSize: T.micro, color: C.textDim }}>File del workflow</span>
              <input value={ghWorkflow} onChange={(e) => setGhWorkflow(e.target.value)}
                style={{ ...input, width: "100%", fontFamily: F.mono }} />
            </label>
            <div style={{ fontSize: T.micro, color: C.textDim, lineHeight: 1.6 }}>
              Il token resta nel browser (localStorage) e serve solo a lanciare il workflow.
              Puoi revocarlo da GitHub → Settings → Applications.
            </div>
          </div>
        )}

        {/* Passo 1: connessione */}
        <div style={{ marginBottom: S.md }}>
          <div style={{ display: "flex", alignItems: "center", gap: S.md, flexWrap: "wrap", marginBottom: S.sm }}>
            <Chip color={ghUser ? C.green : C.textMuted} bg={ghUser ? C.greenDim : "transparent"}>1. Account</Chip>
            {ghUser ? (
              <>
                <span style={{ fontSize: T.small, color: C.text }}>Connesso come <strong>@{ghUser.login}</strong></span>
                <button onClick={() => { setGhToken(""); setPreviewedJson(null); setAccessNote(null); }}
                  style={button("quiet", { small: true })}>Disconnetti</button>
              </>
            ) : (
              <span style={{ fontSize: T.small, color: C.textMuted }}>
                Serve un token per lanciare il workflow dal browser.
              </span>
            )}
            <div style={{ flex: 1 }} />
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: T.micro, color: C.textDim }}>Marketplace</span>
              <input value={ghMarketplace} onChange={(e) => setGhMarketplace(e.target.value.toUpperCase().slice(0, 2))}
                aria-label="Marketplace"
                style={{ ...input, width: 58, textAlign: "center", fontFamily: F.mono, padding: "6px 4px" }} />
            </label>
          </div>

          {!ghUser && (
            <div style={{ background: C.surface2, borderRadius: R.md, padding: S.md }}>
              <div style={{ display: "flex", gap: S.sm, flexWrap: "wrap", alignItems: "center" }}>
                <input type="password" value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") connectWithToken(); }}
                  placeholder="github_pat_… oppure ghp_…" aria-label="Token GitHub"
                  autoComplete="off" spellCheck={false}
                  style={{ ...input, flex: "1 1 260px", fontFamily: F.mono }} />
                <button onClick={connectWithToken} disabled={!tokenDraft.trim() || connecting}
                  style={button("primary", { disabled: !tokenDraft.trim() || connecting })}>
                  {connecting ? "Verifico…" : "Connetti"}
                </button>
              </div>
              <div style={{ fontSize: T.micro, color: C.textDim, marginTop: S.sm, lineHeight: 1.6 }}>
                Crea un <strong>fine-grained token</strong> su GitHub → Settings → Developer settings →
                Personal access tokens → Fine-grained tokens. Dagli accesso <em>solo</em> a questo repository,
                con permesso <strong>Actions: Read and write</strong>. Resta nel browser (localStorage) e
                serve solo a lanciare il workflow; puoi revocarlo quando vuoi.
              </div>
              <button onClick={() => setShowDeviceFlow((v) => !v)}
                style={{ ...button("quiet", { small: true }), padding: "4px 0", marginTop: S.xs, color: C.textMuted }}>
                {showDeviceFlow ? "▾" : "▸"} Accesso senza token (richiede un proxy)
              </button>
              {showDeviceFlow && (
                <div style={{ marginTop: S.sm, paddingTop: S.sm, borderTop: `1px solid ${C.border}` }}>
                  <div style={{ fontSize: T.micro, color: C.textDim, lineHeight: 1.6, marginBottom: S.sm }}>
                    Gli endpoint di login di GitHub non inviano header CORS: da un'app senza backend la
                    richiesta viene bloccata dal browser. Funziona solo passando da un proxy che li aggiunga
                    (es. un Cloudflare Worker che inoltra a github.com).
                  </div>
                  <div style={{ display: "flex", gap: S.sm, flexWrap: "wrap" }}>
                    <input value={ghProxy} onChange={(e) => setGhProxy(e.target.value)}
                      placeholder="https://tuo-proxy.workers.dev" aria-label="URL del proxy"
                      style={{ ...input, flex: "1 1 220px", fontFamily: F.mono }} />
                    <button onClick={connectGithub} disabled={connecting || !ghProxy}
                      style={button("ghost", { small: true, disabled: connecting || !ghProxy })}>
                      {connecting ? "Attendo…" : "Avvia Device Flow"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {accessNote && !accessNote.ok && (
            <div style={{ marginTop: S.sm, padding: `${S.sm}px ${S.md}px`, borderRadius: R.md, background: C.yellowDim, fontSize: T.small, color: C.text }}>
              {accessNote.message}
            </div>
          )}
        </div>

        {deviceInfo && (
          <div style={{
            background: C.accentGlow, border: `1px solid ${C.accent}`, borderRadius: R.md,
            padding: S.lg, marginBottom: S.md, textAlign: "center",
          }}>
            <div style={{ fontSize: T.small, color: C.text, marginBottom: S.sm }}>
              Apri <a href={deviceInfo.verification_uri} target="_blank" rel="noreferrer" style={{ color: C.accent }}>
                {deviceInfo.verification_uri}</a> e inserisci questo codice:
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: 5, color: C.accent, fontFamily: F.mono }}>
              {deviceInfo.user_code}
            </div>
            <div style={{ fontSize: T.micro, color: C.textDim, marginTop: 6 }}>Scade tra {deviceInfo.secondsLeft ?? "…"}s</div>
          </div>
        )}

        {/* Passo 2: anteprima */}
        <div style={{ display: "flex", alignItems: "center", gap: S.md, flexWrap: "wrap", marginBottom: S.md }}>
          <Chip color={previewValid ? C.green : C.textMuted} bg={previewValid ? C.greenDim : "transparent"}>2. Anteprima</Chip>
          <button onClick={() => launch(true)} disabled={!canPreview} style={button("ghost", { disabled: !canPreview })}>
            {busy === "preview" ? "Anteprima in corso…" : "Genera anteprima"}
          </button>
          <span style={{ fontSize: T.micro, color: C.textDim, flex: "1 1 240px", lineHeight: 1.5 }}>
            Esegue il workflow in sola lettura: mostra i valori attuali sull'account e cosa cambierebbe,
            senza toccare nulla. Destinazione:{" "}
            {repoOk
              ? <code style={{ fontFamily: F.mono, color: C.textMuted }}>{ghRepo}</code>
              : <button onClick={() => setShowGhSettings(true)}
                  style={{ ...button("quiet", { small: true }), padding: 0, color: C.yellow }}>
                  repository non impostato — aprilo in Configurazione
                </button>}
          </span>
        </div>

        {/* Passo 3: applicazione */}
        <div style={{ display: "flex", alignItems: "center", gap: S.md, flexWrap: "wrap" }}>
          <Chip color={canApply ? C.red : C.textMuted} bg={canApply ? C.redDim : "transparent"}>3. Applica</Chip>
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
            placeholder="scrivi APPLICA" disabled={!previewValid} aria-label="Conferma digitando APPLICA"
            style={{ ...input, width: 150, fontFamily: F.mono, opacity: previewValid ? 1 : 0.5 }} />
          <button onClick={() => launch(false)} disabled={!canApply} style={button("danger", { disabled: !canApply })}>
            {busy === "apply" ? "Applicazione…" : `Applica ${selected.length} modifiche su ${ghMarketplace}`}
          </button>
        </div>

        {!previewValid && previewedJson !== null && (
          <div style={{ fontSize: T.micro, color: C.yellow, marginTop: S.sm }}>
            Hai cambiato la selezione dopo l'anteprima: rigenerala prima di applicare.
          </div>
        )}
        {tooBig && (
          <div style={{ fontSize: T.micro, color: C.red, marginTop: S.sm }}>
            Troppe azioni per un solo invio (limite di GitHub ~64 KB). Applicane un gruppo alla volta,
            oppure scarica il JSON e lancialo con lo script.
          </div>
        )}
        {!ghUser && selected.length > 0 && (
          <div style={{ fontSize: T.micro, color: C.textDim, marginTop: S.sm }}>
            Senza connettere GitHub puoi comunque scaricare il JSON e incollarlo nel workflow, come prima.
          </div>
        )}

        <RunStatus run={run} />

        {error && (
          <div style={{ marginTop: S.md, padding: `${S.sm}px ${S.md}px`, borderRadius: R.md, background: C.redDim, fontSize: T.small, color: C.text }}>
            {error}
          </div>
        )}

        {run?.status === "completed" && run.conclusion === "success" && !previewValid && (
          <div style={{ marginTop: S.sm, fontSize: T.micro, color: C.textMuted, lineHeight: 1.6 }}>
            Il workflow salva anche un file di rollback tra gli artefatti del run: se qualcosa non convince,
            scaricalo e rilancialo per riportare bid, budget e stati com'erano.
          </div>
        )}
      </div>
    </div>
  );
}
