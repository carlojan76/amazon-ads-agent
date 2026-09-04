import { useEffect, useMemo, useState } from "react";
import { C, F, T, S, R, button, input, card } from "./theme";
import {
  getUser, checkRepoAccess, dispatchWorkflow,
  latestRunId, waitForNewRun, followRun, getRepoFileContents,
} from "./github";
import { checkFamily } from "./qualityCheck";

/**
 * Genera + applica una FAMIGLIA di variazioni (colore/taglia) end-to-end.
 * Bullet e descrizione sono condivisi: li modifichi una volta qui e valgono
 * per tutti i child. Il titolo resta per-child: si genera da un template con
 * {color}/{size} (es. "Cuccia Squalo - {color}" -> "Cuccia Squalo - Blu" /
 * "Cuccia Squalo - Grigio"), sostituiti da apply-family.yml al momento
 * dell'applicazione — qui non li vedi renderizzati (serve leggere il
 * variation theme via SP-API, cosa che fa solo il workflow).
 *
 * Stesso pattern di sicurezza di ListingPanel/ActionsPanel: account ->
 * genera -> anteprima -> applica, conferma "APPLICA" sbloccata solo dopo
 * un'anteprima riuscita sull'ultima versione modificata.
 *
 * Le modifiche a bullet/descrizione/template le fai qui e le mandi al
 * workflow come input (shared_json): NON riscrivono il file
 * listings/family/ nel repo — quello resta quello generato da "Genera",
 * finche' non lo rigeneri. Se vuoi rendere permanente una modifica,
 * rigenera la copy con "Genera" dopo aver aggiornato il brief, oppure
 * editane il file a mano nel repo.
 */

const MARKETS = ["IT", "FR", "DE", "ES", "UK"];
const isValidRepo = (s) => /^[\w.-]+\/[\w.-]+$/.test((s || "").trim());
const isValidAsin = (s) => /^[A-Z0-9]{10}$/.test((s || "").trim());

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

function Chip({ children, color = C.textMuted, bg = "transparent" }) {
  return (
    <span style={{
      background: bg, color, border: `1px solid ${bg === "transparent" ? C.border : "transparent"}`,
      borderRadius: R.pill, padding: "2px 8px", fontSize: T.micro, fontWeight: 600,
      whiteSpace: "nowrap", fontFamily: F.ui,
    }}>{children}</span>
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

const SEV_TONE = {
  ERROR: { color: C.red, bg: C.redDim, label: "✕" },
  WARNING: { color: C.yellow, bg: C.yellowDim, label: "⚠" },
  INFO: { color: C.textMuted, bg: "transparent", label: "ⓘ" },
};

function QualityList({ problems }) {
  if (!problems?.length) {
    return <div style={{ fontSize: T.small, color: C.green, padding: `${S.sm}px 0` }}>✓ Nessun problema rilevato.</div>;
  }
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {problems.map((p, i) => {
        const tone = SEV_TONE[p.severity] || SEV_TONE.INFO;
        return (
          <div key={i} style={{
            display: "flex", gap: S.sm, alignItems: "flex-start", fontSize: T.small,
            padding: `6px ${S.sm}px`, borderRadius: R.sm, background: tone.bg,
          }}>
            <span style={{ color: tone.color, fontWeight: 700, flexShrink: 0 }}>{tone.label}</span>
            <span style={{ color: C.text, lineHeight: 1.5 }}>{p.message}</span>
          </div>
        );
      })}
    </div>
  );
}

const textareaStyle = { ...input, width: "100%", minHeight: 96, resize: "vertical", lineHeight: 1.5, fontFamily: F.ui };

export default function FamilyPanel({ marketplace = "" }) {
  // ---- connessione GitHub (condivisa con ActionsPanel/ListingPanel) ----
  const [ghRepo, setGhRepo] = useState(() => localStorage.getItem("gh_repo") || guessRepoFromUrl());
  const [ghToken, setGhToken] = useState(() => localStorage.getItem("gh_token") || "");
  const [ghUser, setGhUser] = useState(null);
  const [buildWorkflow, setBuildWorkflow] = useState(() => localStorage.getItem("gh_build_workflow") || "build-listing.yml");
  const [familyWorkflow, setFamilyWorkflow] = useState(() => localStorage.getItem("gh_family_workflow") || "apply-family.yml");
  const [showSettings, setShowSettings] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [accessNote, setAccessNote] = useState(null);

  useEffect(() => { localStorage.setItem("gh_repo", ghRepo); }, [ghRepo]);
  useEffect(() => { localStorage.setItem("gh_build_workflow", buildWorkflow); }, [buildWorkflow]);
  useEffect(() => { localStorage.setItem("gh_family_workflow", familyWorkflow); }, [familyWorkflow]);
  useEffect(() => {
    if (ghToken) {
      localStorage.setItem("gh_token", ghToken);
      getUser(ghToken).then(setGhUser).catch(() => { setGhToken(""); setGhUser(null); });
    } else { localStorage.removeItem("gh_token"); setGhUser(null); }
  }, [ghToken]);

  useEffect(() => {
    const [owner, repo] = ghRepo.split("/").map((s) => s.trim());
    if (!ghUser || !owner || !repo) { setAccessNote(null); return; }
    let alive = true;
    checkRepoAccess({ token: ghToken, owner, repo, workflow: buildWorkflow })
      .then((r) => { if (alive) setAccessNote(r); });
    return () => { alive = false; };
  }, [ghUser, ghToken, ghRepo, buildWorkflow]);

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

  // ---- ASIN parent / marketplace / child singolo (opzionale) ----
  const [asin, setAsin] = useState(() => localStorage.getItem("gh_family_asin") || "");
  const [mkt, setMkt] = useState(marketplace && MARKETS.includes(marketplace) ? marketplace : "IT");
  const [onlySku, setOnlySku] = useState("");
  useEffect(() => { localStorage.setItem("gh_family_asin", asin); }, [asin]);
  useEffect(() => { if (marketplace && MARKETS.includes(marketplace)) setMkt(marketplace); }, [marketplace]);

  // ---- stato del flusso ----
  const [busy, setBusy] = useState(null); // "build" | "load" | "preview" | "apply"
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [context, setContext] = useState(null);
  const [family, setFamily] = useState(null);
  const [previewedJson, setPreviewedJson] = useState(null);
  const [confirmText, setConfirmText] = useState("");
  const [appliedInfo, setAppliedInfo] = useState(null);

  // ---- campi modificabili (shared + template) ----
  const [bulletText, setBulletText] = useState("");
  const [descriptionText, setDescriptionText] = useState("");
  const [titleTemplate, setTitleTemplate] = useState("");

  const repoOk = isValidRepo(ghRepo);
  const asinOk = isValidAsin(asin);
  const [owner, repo] = ghRepo.split("/").map((s) => (s || "").trim());

  useEffect(() => {
    setContext(null); setFamily(null); setPreviewedJson(null); setConfirmText("");
    setAppliedInfo(null); setRun(null); setError(null);
    setBulletText(""); setDescriptionText(""); setTitleTemplate("");
  }, [asin, mkt]);

  const populateEditableFields = (fam) => {
    const shared = fam?.shared || {};
    const bp = Array.isArray(shared.bullet_point) ? shared.bullet_point
      : (typeof shared.bullet_point === "string" ? [shared.bullet_point] : []);
    setBulletText(bp.join("\n"));
    setDescriptionText(shared.product_description || "");
    setTitleTemplate(fam?.title_template || "");
  };

  const payload = useMemo(() => ({
    shared: {
      bullet_point: bulletText.split("\n").map((s) => s.trim()).filter(Boolean),
      product_description: descriptionText.trim(),
    },
    title_template: titleTemplate.trim(),
  }), [bulletText, descriptionText, titleTemplate]);
  const payloadJson = useMemo(() => JSON.stringify(payload), [payload]);

  const checkResult = useMemo(() => {
    if (!family) return null;
    return checkFamily({ ...family, ...payload }, context);
  }, [family, context, payload]);

  const previewValid = previewedJson !== null && previewedJson === payloadJson;
  useEffect(() => { if (!previewValid) setConfirmText(""); }, [previewValid]);

  const loadFiles = async () => {
    const ctxRes = await getRepoFileContents({ token: ghToken, owner, repo, path: `listings/context/${asin}_${mkt}.json` });
    const famRes = await getRepoFileContents({ token: ghToken, owner, repo, path: `listings/family/${asin}_${mkt}.json` });
    setContext(ctxRes?.json || null);
    setFamily(famRes?.json || null);
    if (famRes?.json) populateEditableFields(famRes.json);
    return { ctxRes, famRes };
  };

  const runWorkflow = async (workflow, inputs) => {
    const before = await latestRunId({ token: ghToken, owner, repo, workflow }).catch(() => null);
    await dispatchWorkflow({ token: ghToken, owner, repo, workflow, inputs });
    setRun({ status: "queued" });
    const fresh = await waitForNewRun({ token: ghToken, owner, repo, workflow, afterId: before });
    if (!fresh) {
      setRun({ status: "queued", html_url: `https://github.com/${owner}/${repo}/actions` });
      return null;
    }
    setRun({ status: fresh.status, conclusion: fresh.conclusion, html_url: fresh.html_url });
    return followRun({ token: ghToken, owner, repo, runId: fresh.id, onUpdate: setRun });
  };

  const doBuild = async () => {
    if (!repoOk || !asinOk) return;
    setBusy("build"); setError(null); setRun(null); setAppliedInfo(null);
    try {
      const final = await runWorkflow(buildWorkflow, {
        marketplace: mkt, asin, sku: "", generate: "true", family: "true",
        source_marketplace: "", reviews_sort: "MENTIONS", search_terms_top: "20",
        no_image: "false", no_search_terms: "false", no_sqp: "false",
      });
      if (final?.conclusion === "success") await loadFiles();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const doLoadExisting = async () => {
    if (!repoOk || !asinOk) return;
    setBusy("load"); setError(null);
    try {
      const { famRes } = await loadFiles();
      if (!famRes) setError(`Nessuna famiglia trovata in listings/family/${asin}_${mkt}.json. Genera prima la copy (passo 2).`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  // Rilancia build-listing.yml con generate:"false": aggiorna SOLO il context
  // pack (termini di ricerca/SQP, ora aggregati dai child) senza chiedere a
  // Claude una nuova copy — se listings/family/... esiste gia', il workflow lo
  // lascia intatto. Aggiorniamo qui SOLO lo stato "context", mai i campi
  // modificabili (bullet/descrizione/template): non vogliamo perdere modifiche
  // che stai ancora scrivendo nei campi qui sotto.
  const doRefreshTerms = async () => {
    if (!repoOk || !asinOk) return;
    setBusy("refresh"); setError(null); setRun(null);
    try {
      const final = await runWorkflow(buildWorkflow, {
        marketplace: mkt, asin, sku: "", generate: "false", family: "true",
        source_marketplace: "", reviews_sort: "MENTIONS", search_terms_top: "20",
        no_image: "false", no_search_terms: "false", no_sqp: "false",
      });
      if (final?.conclusion === "success") {
        const ctxRes = await getRepoFileContents({ token: ghToken, owner, repo, path: `listings/context/${asin}_${mkt}.json` });
        setContext(ctxRes?.json || null);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const doPreview = async () => {
    if (!repoOk || !asinOk || !family) return;
    setBusy("preview"); setError(null); setRun(null);
    try {
      const final = await runWorkflow(familyWorkflow, {
        marketplace: mkt, asin, confirm: "NO", dry_run: "true",
        only: onlySku.trim(), shared_json: payloadJson,
      });
      if (final?.conclusion === "success") setPreviewedJson(payloadJson);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const doApply = async () => {
    if (!canApply) return;
    setBusy("apply"); setError(null); setRun(null);
    try {
      const final = await runWorkflow(familyWorkflow, {
        marketplace: mkt, asin, confirm: "APPLICA", dry_run: "false",
        only: onlySku.trim(), shared_json: payloadJson,
      });
      if (final?.conclusion === "success") {
        setPreviewedJson(null); setConfirmText("");
        const res = await getRepoFileContents({ token: ghToken, owner, repo, path: `listings/applied/family/${asin}_${mkt}.json` });
        setAppliedInfo(res?.json || null);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const canBuild = repoOk && asinOk && ghUser && !busy;
  const canRefreshTerms = repoOk && asinOk && ghUser && !busy;
  const canPreview = repoOk && asinOk && ghUser && !!family && !busy;
  const hasErrors = (checkResult?.nError || 0) > 0;
  const canApply = previewValid && confirmText === "APPLICA" && !hasErrors && !busy;

  return (
    <div style={{ fontFamily: F.ui }}>
      <div style={{ ...card, padding: S.lg, marginBottom: S.md }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: S.md, flexWrap: "wrap", gap: S.sm }}>
          <div>
            <div style={{ fontSize: T.lead, fontWeight: 700, color: C.text }}>Famiglia di variazioni</div>
            <div style={{ fontSize: T.micro, color: C.textDim, marginTop: 2 }}>
              Bullet e descrizione condivisi per tutti i child; il titolo resta per-child (template).
            </div>
          </div>
          <button onClick={() => setShowSettings((v) => !v)} style={button("quiet", { small: true })}>⚙ Configurazione</button>
        </div>

        {showSettings && (
          <div style={{ background: C.surface2, borderRadius: R.md, padding: S.md, marginBottom: S.md, display: "grid", gap: S.sm }}>
            <label>
              <span style={{ fontSize: T.micro, color: C.textDim }}>Repository</span>
              <input value={ghRepo} onChange={(e) => setGhRepo(e.target.value)} placeholder="tuo-utente/amazon-ads-agent"
                style={{ ...input, width: "100%", fontFamily: F.mono, borderColor: ghRepo && !repoOk ? C.red : C.borderStrong }} />
            </label>
            <label>
              <span style={{ fontSize: T.micro, color: C.textDim }}>Workflow "Build Listing Copy"</span>
              <input value={buildWorkflow} onChange={(e) => setBuildWorkflow(e.target.value)} style={{ ...input, width: "100%", fontFamily: F.mono }} />
            </label>
            <label>
              <span style={{ fontSize: T.micro, color: C.textDim }}>Workflow "Apply Family Listing"</span>
              <input value={familyWorkflow} onChange={(e) => setFamilyWorkflow(e.target.value)} style={{ ...input, width: "100%", fontFamily: F.mono }} />
            </label>
            <div style={{ fontSize: T.micro, color: C.textDim, lineHeight: 1.6 }}>
              Repository e token sono condivisi con "Azioni" e "Scheda prodotto": connettendoti li' non serve rifarlo qui.
            </div>
          </div>
        )}

        {/* Account */}
        <div style={{ display: "flex", alignItems: "center", gap: S.md, flexWrap: "wrap", marginBottom: S.md }}>
          <Chip color={ghUser ? C.green : C.textMuted} bg={ghUser ? C.greenDim : "transparent"}>1. Account</Chip>
          {ghUser ? (
            <>
              <span style={{ fontSize: T.small, color: C.text }}>Connesso come <strong>@{ghUser.login}</strong></span>
              <button onClick={() => { setGhToken(""); setAccessNote(null); }} style={button("quiet", { small: true })}>Disconnetti</button>
            </>
          ) : (
            <div style={{ display: "flex", gap: S.sm, flexWrap: "wrap", alignItems: "center", flex: 1 }}>
              <input type="password" value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") connectWithToken(); }}
                placeholder="github_pat_… oppure ghp_…" aria-label="Token GitHub" autoComplete="off" spellCheck={false}
                style={{ ...input, flex: "1 1 240px", fontFamily: F.mono }} />
              <button onClick={connectWithToken} disabled={!tokenDraft.trim() || connecting}
                style={button("primary", { disabled: !tokenDraft.trim() || connecting })}>
                {connecting ? "Verifico…" : "Connetti"}
              </button>
            </div>
          )}
        </div>
        {accessNote && !accessNote.ok && (
          <div style={{ marginBottom: S.md, padding: `${S.sm}px ${S.md}px`, borderRadius: R.md, background: C.yellowDim, fontSize: T.small, color: C.text }}>
            {accessNote.message}
          </div>
        )}

        {/* ASIN parent + mercato + child singolo */}
        <div style={{ display: "flex", gap: S.md, flexWrap: "wrap", alignItems: "flex-end", marginBottom: S.md }}>
          <label>
            <div style={{ fontSize: T.micro, color: C.textDim, marginBottom: 4 }}>ASIN del parent</div>
            <input value={asin} onChange={(e) => setAsin(e.target.value.toUpperCase().trim())}
              placeholder="B0XXXXXXXX" aria-label="ASIN del parent"
              style={{ ...input, width: 150, fontFamily: F.mono, borderColor: asin && !asinOk ? C.red : C.borderStrong }} />
          </label>
          <label>
            <div style={{ fontSize: T.micro, color: C.textDim, marginBottom: 4 }}>Marketplace</div>
            <select value={mkt} onChange={(e) => setMkt(e.target.value)} style={{ ...input, width: 90 }}>
              {MARKETS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label>
            <div style={{ fontSize: T.micro, color: C.textDim, marginBottom: 4 }}>Solo un child (opzionale)</div>
            <input value={onlySku} onChange={(e) => setOnlySku(e.target.value)} placeholder="SKU per testare"
              aria-label="Elabora solo questo child SKU"
              style={{ ...input, width: 170, fontFamily: F.mono }} />
          </label>
          <button onClick={doLoadExisting} disabled={!repoOk || !asinOk || !ghUser || !!busy}
            style={button("ghost", { small: true, disabled: !repoOk || !asinOk || !ghUser || !!busy })}>
            {busy === "load" ? "Carico…" : "Carica famiglia gia' generata"}
          </button>
        </div>

        {/* Passo 2: genera */}
        <div style={{ display: "flex", alignItems: "center", gap: S.md, flexWrap: "wrap", marginBottom: S.sm }}>
          <Chip color={family ? C.green : C.textMuted} bg={family ? C.greenDim : "transparent"}>2. Genera</Chip>
          <button onClick={doBuild} disabled={!canBuild} style={button("ghost", { disabled: !canBuild })}>
            {busy === "build" ? "Genero…" : "Genera brief + copy famiglia con Claude"}
          </button>
          <span style={{ fontSize: T.micro, color: C.textDim, flex: "1 1 240px", lineHeight: 1.5 }}>
            Lancia "{buildWorkflow}" con family=true sull'ASIN del parent: scopre i child, genera
            bullet/descrizione condivisi e un titolo con placeholder ({"{color}"}/{"{size}"}).
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: S.md, flexWrap: "wrap" }}>
          <div style={{ width: 78, flexShrink: 0 }} />
          <button onClick={doRefreshTerms} disabled={!canRefreshTerms} style={button("quiet", { small: true, disabled: !canRefreshTerms })}>
            {busy === "refresh" ? "Aggiorno…" : "↻ Aggiorna solo termini di ricerca"}
          </button>
          <span style={{ fontSize: T.micro, color: C.textDim, flex: "1 1 240px", lineHeight: 1.5 }}>
            Rilancia "{buildWorkflow}" senza chiedere copy nuova a Claude: aggiorna solo i termini di
            ricerca/SQP (utile dopo che i child hanno accumulato dati ads) senza toccare bullet/descrizione
            che hai gia' approvato qui sotto.
          </span>
        </div>
        {!ghUser && <div style={{ fontSize: T.micro, color: C.textDim, marginTop: S.sm }}>Connetti prima un token GitHub (passo 1).</div>}
      </div>

      {context && (
        <div style={{ ...card, padding: S.lg, marginBottom: S.md }}>
          <div style={{ fontSize: T.lead, fontWeight: 700, color: C.text, marginBottom: S.sm }}>Termini di ricerca usati</div>
          {(() => {
            const meta = context.search_terms_meta || {};
            const sqpMeta = context.sqp_meta || {};
            const scopeLabel = {
              asin: "di questo ASIN (ha una sua campagna)",
              family: "aggregati dai child con dati propri",
            }[meta.scope] || "dell'intero account (nessun ASIN della famiglia ha dati propri — verifica se sono pertinenti)";
            return (
              <>
                {meta.available ? (
                  <>
                    <div style={{ fontSize: T.micro, color: C.textDim, marginBottom: S.sm }}>
                      Ambito: <strong style={{ color: meta.scope === "asin" || meta.scope === "family" ? C.green : C.yellow }}>{scopeLabel}</strong>
                      {meta.contributing_asins?.length ? ` — ${meta.contributing_asins.join(", ")}` : ""}
                    </div>
                    {!!meta.top_terms?.length && (
                      <div style={{ marginBottom: S.sm }}>
                        <div style={{ fontSize: T.micro, color: C.textDim, marginBottom: 4 }}>Termini che convertono (devono comparire nel testo):</div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {meta.top_terms.map((t) => <Chip key={t} color={C.green} bg={C.greenDim}>{t}</Chip>)}
                        </div>
                      </div>
                    )}
                    {!!meta.avoid_terms?.length && (
                      <div>
                        <div style={{ fontSize: T.micro, color: C.textDim, marginBottom: 4 }}>Termini che NON convertono (mai nel titolo):</div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {meta.avoid_terms.map((t) => <Chip key={t} color={C.yellow} bg={C.yellowDim}>{t}</Chip>)}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: T.small, color: C.textMuted }}>Nessun termine di ricerca disponibile ({meta.reason || "motivo non specificato"}).</div>
                )}
                {sqpMeta.available && !!sqpMeta.purchase_confirmed_terms?.length && (
                  <div style={{ marginTop: S.md, paddingTop: S.md, borderTop: `1px solid ${C.border}` }}>
                    <div style={{ fontSize: T.micro, color: C.textDim, marginBottom: 4 }}>
                      Query Search Query Performance con acquisti reali{sqpMeta.scope === "family" ? " (sommati sui child)" : ""}:
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {sqpMeta.purchase_confirmed_terms.map((t) => (
                        <Chip key={t.query} color={C.blue} bg={C.blueDim}>{t.query} ({t.purchases})</Chip>
                      ))}
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {family && (
        <div style={{ ...card, padding: S.lg, marginBottom: S.md }}>
          <div style={{ fontSize: T.lead, fontWeight: 700, color: C.text, marginBottom: S.sm }}>Copy condivisa (modificabile)</div>
          <div style={{ fontSize: T.micro, color: C.textDim, marginBottom: S.md, lineHeight: 1.6 }}>
            Le modifiche qui sotto valgono per <strong>tutti i child</strong> della famiglia. Il titolo resta
            per-child: usa <code style={{ fontFamily: F.mono }}>{"{color}"}</code> e/o{" "}
            <code style={{ fontFamily: F.mono }}>{"{size}"}</code> (o il nome esatto dell'attributo del
            variation theme, es. <code style={{ fontFamily: F.mono }}>{"{color_name}"}</code>) nel template: al
            momento dell'applicazione ogni child riceve il proprio titolo (es. "Cuccia Squalo - Blu" invece di
            "Cuccia Squalo - Grigio"). Queste modifiche NON riscrivono il file nel repo: valgono solo per
            l'anteprima/applicazione che lanci da qui.
          </div>

          <div style={{ marginBottom: S.md }}>
            <div style={{ fontSize: T.micro, color: C.textDim, fontWeight: 600, marginBottom: 4 }}>Template titolo</div>
            <input value={titleTemplate} onChange={(e) => setTitleTemplate(e.target.value)}
              placeholder="es. Cuccia Squalo - {color}"
              style={{ ...input, width: "100%", fontFamily: F.mono, borderColor: !titleTemplate.trim() ? C.yellow : C.borderStrong }} />
            {!titleTemplate.trim() && (
              <div style={{ fontSize: T.micro, color: C.yellow, marginTop: 4, lineHeight: 1.5 }}>
                ⚠ Nessun template caricato: senza, "{familyWorkflow}" NON tocca il titolo dei child su Amazon
                (lo lascia com'e' ora). Se il file era stato generato senza "Genera" (scheletro), o e' un
                file vecchio salvato prima che il titolo diventasse obbligatorio, scrivine uno qui a mano
                (es. "Cuccia Squalo - {"{color}"}") o rilancia "Genera brief + copy famiglia con Claude".
              </div>
            )}
          </div>

          <div style={{ marginBottom: S.md }}>
            <div style={{ fontSize: T.micro, color: C.textDim, fontWeight: 600, marginBottom: 4 }}>Bullet point (uno per riga)</div>
            <textarea value={bulletText} onChange={(e) => setBulletText(e.target.value)} style={textareaStyle} />
          </div>

          <div>
            <div style={{ fontSize: T.micro, color: C.textDim, fontWeight: 600, marginBottom: 4 }}>Descrizione</div>
            <textarea value={descriptionText} onChange={(e) => setDescriptionText(e.target.value)} style={{ ...textareaStyle, minHeight: 140 }} />
          </div>
        </div>
      )}

      {family && (
        <div style={{ ...card, padding: S.lg, marginBottom: S.md }}>
          <div style={{ fontSize: T.lead, fontWeight: 700, color: C.text, marginBottom: S.md }}>Controllo qualita' (copy condivisa)</div>
          {checkResult ? (
            <>
              <div style={{ display: "flex", gap: S.md, marginBottom: S.md }}>
                <Chip color={checkResult.nError ? C.red : C.textMuted} bg={checkResult.nError ? C.redDim : "transparent"}>
                  {checkResult.nError} errori
                </Chip>
                <Chip color={checkResult.nWarning ? C.yellow : C.textMuted} bg={checkResult.nWarning ? C.yellowDim : "transparent"}>
                  {checkResult.nWarning} avvisi
                </Chip>
              </div>
              <QualityList problems={checkResult.problems} />
            </>
          ) : (
            <div style={{ fontSize: T.small, color: C.textMuted }}>Nessuna famiglia caricata.</div>
          )}
          <div style={{ fontSize: T.micro, color: C.textDim, marginTop: S.md, lineHeight: 1.6 }}>
            Questo controllo e' sulla copy condivisa (bullet/descrizione) e usa i limiti carattere del parent
            come proxy. Il titolo per-child (dal template) lo valida davvero "{familyWorkflow}" con una
            VALIDATION_PREVIEW per ogni child, prima di applicare — apri il log dell'anteprima per vederlo.
          </div>
        </div>
      )}

      {family && (
        <div style={{ ...card, padding: S.lg }}>
          {/* Passo 3: anteprima */}
          <div style={{ display: "flex", alignItems: "center", gap: S.md, flexWrap: "wrap", marginBottom: S.md }}>
            <Chip color={previewValid ? C.green : C.textMuted} bg={previewValid ? C.greenDim : "transparent"}>3. Anteprima</Chip>
            <button onClick={doPreview} disabled={!canPreview} style={button("ghost", { disabled: !canPreview })}>
              {busy === "preview" ? "Anteprima in corso…" : "Genera anteprima"}
            </button>
            <span style={{ fontSize: T.micro, color: C.textDim, flex: "1 1 240px", lineHeight: 1.5 }}>
              Esegue il controllo qualita', un diff testuale e una VALIDATION_PREVIEW reale per ogni child, senza
              scrivere nulla. Apri il log del run per vedere il diff completo per-child.
            </span>
          </div>

          {/* Passo 4: applica */}
          <div style={{ display: "flex", alignItems: "center", gap: S.md, flexWrap: "wrap" }}>
            <Chip color={canApply ? C.red : C.textMuted} bg={canApply ? C.redDim : "transparent"}>4. Applica</Chip>
            <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
              placeholder="scrivi APPLICA" disabled={!previewValid || hasErrors} aria-label="Conferma digitando APPLICA"
              style={{ ...input, width: 150, fontFamily: F.mono, opacity: previewValid && !hasErrors ? 1 : 0.5 }} />
            <button onClick={doApply} disabled={!canApply} style={button("danger", { disabled: !canApply })}>
              {busy === "apply" ? "Applicazione…" : `Applica su ${mkt}${onlySku.trim() ? ` (solo ${onlySku.trim()})` : " (tutti i child)"}`}
            </button>
          </div>

          {!previewValid && (
            <div style={{ fontSize: T.micro, color: C.textDim, marginTop: S.sm, lineHeight: 1.6 }}>
              {hasErrors
                ? "Il controllo qualita' ha trovato errori: correggi bullet/descrizione qui sopra prima di poter applicare."
                : previewedJson !== null
                  ? "Hai modificato il testo dopo l'ultima anteprima: rigenerala prima di applicare."
                  : "Genera prima l'anteprima (passo 3). Solo dopo si sblocca la conferma."}
            </div>
          )}
          {hasErrors && previewValid && (
            <div style={{ fontSize: T.micro, color: C.red, marginTop: S.sm }}>
              Il controllo qualita' ha trovato errori: la conferma resta bloccata finche' non li risolvi.
            </div>
          )}

          <RunStatus run={run} />

          {appliedInfo && (
            <div style={{ marginTop: S.md, padding: S.md, borderRadius: R.md, background: appliedInfo.tally?.error ? C.yellowDim : C.greenDim }}>
              <div style={{ fontSize: T.small, fontWeight: 700, color: C.text, marginBottom: S.sm }}>
                Applicato su Amazon {appliedInfo.tally && `— ${appliedInfo.tally.ok} ok, ${appliedInfo.tally.error} errori, ${appliedInfo.tally.skip} saltati`}
              </div>
              {appliedInfo.children?.map((c) => (
                <div key={c.sku} style={{ display: "flex", gap: S.sm, fontSize: T.micro, color: C.textMuted, padding: "3px 0" }}>
                  <span style={{ fontFamily: F.mono, color: C.text, minWidth: 160 }}>{c.sku}</span>
                  <span style={{ color: c.status === "error" ? C.red : c.status === "skip" ? C.textDim : C.green }}>
                    {c.status || "?"}
                  </span>
                  {c.submissionId && <span style={{ fontFamily: F.mono }}>submissionId={c.submissionId}</span>}
                </div>
              ))}
              <div style={{ fontSize: T.micro, color: C.textDim, marginTop: S.sm }}>
                {appliedInfo.appliedAt}
                {appliedInfo.runUrl && <> · <a href={appliedInfo.runUrl} target="_blank" rel="noreferrer" style={{ color: C.accent }}>log del run →</a></>}
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div style={{ marginTop: S.md, padding: `${S.sm}px ${S.md}px`, borderRadius: R.md, background: C.redDim, fontSize: T.small, color: C.text }}>
          {error}
        </div>
      )}
    </div>
  );
}
