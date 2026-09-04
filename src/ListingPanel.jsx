import { useEffect, useMemo, useState } from "react";
import { C, F, T, S, R, button, input, card } from "./theme";
import {
  getUser, checkRepoAccess, dispatchWorkflow,
  latestRunId, waitForNewRun, followRun, getRepoFileContents,
} from "./github";
import { checkContent } from "./qualityCheck";

/**
 * Genera + applica una scheda prodotto (listing copy) direttamente dalla UI,
 * end-to-end: lancia build-listing.yml (brief + copy generata da Claude),
 * mostra il controllo qualita' e il prima/dopo, poi lancia apply-listing.yml
 * (anteprima obbligatoria, poi applicazione vera solo dopo conferma scritta
 * "APPLICA"). Stesso pattern di sicurezza di ActionsPanel: account -> anteprima
 * -> applica, nessuna scorciatoia sul dry-run.
 *
 * Titolo/bullet/descrizione sono modificabili qui prima di anteprima/applica
 * (sezione "Prima / dopo"): le modifiche le mandi al workflow come input
 * (content_json), NON riscrivono il file listings/content/ nel repo — quello
 * resta quello generato da "Genera", finche' non lo rigeneri. Stesso pattern
 * di FamilyPanel (shared_json).
 *
 * Riusa la connessione GitHub di ActionsPanel (stesse chiavi localStorage
 * gh_repo/gh_token): se sei gia' connesso li', qui non serve rifarlo.
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
    return (
      <div style={{ fontSize: T.small, color: C.green, padding: `${S.sm}px 0` }}>
        ✓ Nessun problema rilevato.
      </div>
    );
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

function bulletsText(v) {
  if (Array.isArray(v)) return v.filter(Boolean).join("\n");
  return v || "";
}

const textareaStyle = { ...input, width: "100%", minHeight: 96, resize: "vertical", lineHeight: 1.5, fontFamily: F.ui };

// Sinistra: sola lettura (cosa c'e' ora sul listing Amazon, da context.current_copy).
// Destra: campo modificabile — parte precompilato con la copy generata, ma puoi
// riscriverlo prima di anteprima/applica. "modificato" confronta col prima, non
// con la copy generata in origine.
function EditableFieldDiff({ label, before, value, onChange, multiline }) {
  const changed = (before || "") !== (value || "");
  const fieldStyle = {
    ...(multiline ? textareaStyle : input),
    width: "100%", fontFamily: F.ui,
    background: changed ? C.accentGlow : C.surface2,
  };
  return (
    <div style={{ marginBottom: S.md }}>
      <div style={{ fontSize: T.micro, color: C.textDim, fontWeight: 600, marginBottom: 4 }}>
        {label} {changed && <span style={{ color: C.accent }}>· modificato rispetto al listing attuale</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: S.sm }}>
        <div style={{
          fontSize: T.small, color: C.textMuted, whiteSpace: "pre-wrap", lineHeight: 1.5,
          background: C.surface2, borderRadius: R.sm, padding: S.sm, minHeight: 28,
        }}>{before || <em style={{ color: C.textDim }}>vuoto</em>}</div>
        {multiline
          ? <textarea value={value} onChange={onChange} style={fieldStyle} />
          : <input value={value} onChange={onChange} style={fieldStyle} />}
      </div>
    </div>
  );
}

export default function ListingPanel({ marketplace = "" }) {
  // ---- connessione GitHub (condivisa con ActionsPanel via localStorage) ----
  const [ghRepo, setGhRepo] = useState(() => localStorage.getItem("gh_repo") || guessRepoFromUrl());
  const [ghToken, setGhToken] = useState(() => localStorage.getItem("gh_token") || "");
  const [ghUser, setGhUser] = useState(null);
  const [buildWorkflow, setBuildWorkflow] = useState(() => localStorage.getItem("gh_build_workflow") || "build-listing.yml");
  const [applyWorkflow, setApplyWorkflow] = useState(() => localStorage.getItem("gh_apply_workflow") || "apply-listing.yml");
  const [showSettings, setShowSettings] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [accessNote, setAccessNote] = useState(null);

  useEffect(() => { localStorage.setItem("gh_repo", ghRepo); }, [ghRepo]);
  useEffect(() => { localStorage.setItem("gh_build_workflow", buildWorkflow); }, [buildWorkflow]);
  useEffect(() => { localStorage.setItem("gh_apply_workflow", applyWorkflow); }, [applyWorkflow]);
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

  // ---- ASIN / marketplace ----
  const [asin, setAsin] = useState(() => localStorage.getItem("gh_listing_asin") || "");
  const [mkt, setMkt] = useState(marketplace && MARKETS.includes(marketplace) ? marketplace : "IT");
  useEffect(() => { localStorage.setItem("gh_listing_asin", asin); }, [asin]);
  useEffect(() => { if (marketplace && MARKETS.includes(marketplace)) setMkt(marketplace); }, [marketplace]);

  // ---- stato del flusso ----
  const [busy, setBusy] = useState(null); // "build" | "load" | "preview" | "apply"
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [context, setContext] = useState(null);
  const [content, setContent] = useState(null);
  const [previewedJson, setPreviewedJson] = useState(null);
  const [confirmText, setConfirmText] = useState("");
  const [appliedInfo, setAppliedInfo] = useState(null);

  // ---- campi modificabili (titolo/bullet/descrizione) ----
  const [titleText, setTitleText] = useState("");
  const [bulletText, setBulletText] = useState("");
  const [descriptionText, setDescriptionText] = useState("");

  // Istruzione libera per Claude, valida solo per il prossimo "Genera" su
  // questo ASIN/mercato (es. "niente emoji", "e' MDF non legno"): la manda
  // al workflow come input extra_instructions, build_context.py la accoda
  // allo user message con priorita' sulle regole generiche del contratto.
  const [extraInstructions, setExtraInstructions] = useState("");

  const repoOk = isValidRepo(ghRepo);
  const asinOk = isValidAsin(asin);
  const [owner, repo] = ghRepo.split("/").map((s) => (s || "").trim());

  // Cambiando ASIN/mercato tutto quello che avevi caricato prima non e' piu' valido.
  useEffect(() => {
    setContext(null); setContent(null); setPreviewedJson(null); setConfirmText("");
    setAppliedInfo(null); setRun(null); setError(null);
    setTitleText(""); setBulletText(""); setDescriptionText(""); setExtraInstructions("");
  }, [asin, mkt]);

  const populateEditableFields = (cont) => {
    const attrs = cont?.attributes || {};
    const bp = Array.isArray(attrs.bullet_point) ? attrs.bullet_point
      : (typeof attrs.bullet_point === "string" ? [attrs.bullet_point] : []);
    setTitleText(attrs.item_name || "");
    setBulletText(bp.join("\n"));
    setDescriptionText(attrs.product_description || "");
  };

  const payload = useMemo(() => ({
    attributes: {
      item_name: titleText.trim(),
      bullet_point: bulletText.split("\n").map((s) => s.trim()).filter(Boolean),
      product_description: descriptionText.trim(),
    },
  }), [titleText, bulletText, descriptionText]);
  const payloadJson = useMemo(() => JSON.stringify(payload), [payload]);

  const checkResult = useMemo(() => {
    if (!content) return null;
    return checkContent(payload.attributes, context);
  }, [content, context, payload]);

  const previewValid = previewedJson !== null && previewedJson === payloadJson;
  useEffect(() => { if (!previewValid) setConfirmText(""); }, [previewValid]);

  const loadFiles = async () => {
    const ctxRes = await getRepoFileContents({ token: ghToken, owner, repo, path: `listings/context/${asin}_${mkt}.json` });
    const contRes = await getRepoFileContents({ token: ghToken, owner, repo, path: `listings/content/${asin}_${mkt}.json` });
    setContext(ctxRes?.json || null);
    setContent(contRes?.json || null);
    if (contRes?.json) populateEditableFields(contRes.json);
    return { ctxRes, contRes };
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
    const final = await followRun({ token: ghToken, owner, repo, runId: fresh.id, onUpdate: setRun });
    return final;
  };

  const doBuild = async () => {
    if (!repoOk || !asinOk) return;
    setBusy("build"); setError(null); setRun(null); setAppliedInfo(null);
    try {
      const final = await runWorkflow(buildWorkflow, {
        marketplace: mkt, asin, sku: "", generate: "true", family: "false",
        source_marketplace: "", reviews_sort: "MENTIONS", search_terms_top: "20",
        no_image: "false", no_search_terms: "false", no_sqp: "false",
        extra_instructions: extraInstructions.trim(),
      });
      if (final?.conclusion === "success") {
        await loadFiles();
      }
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
      const { contRes } = await loadFiles();
      if (!contRes) setError(`Nessuna copy trovata in listings/content/${asin}_${mkt}.json. Genera prima la copy (passo 1).`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const doPreview = async () => {
    if (!repoOk || !asinOk || !content) return;
    setBusy("preview"); setError(null); setRun(null);
    try {
      const final = await runWorkflow(applyWorkflow, {
        marketplace: mkt, asin, confirm: "NO", dry_run: "true", content_json: payloadJson,
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
      const final = await runWorkflow(applyWorkflow, {
        marketplace: mkt, asin, confirm: "APPLICA", dry_run: "false", content_json: payloadJson,
      });
      if (final?.conclusion === "success") {
        setPreviewedJson(null); setConfirmText("");
        const res = await getRepoFileContents({ token: ghToken, owner, repo, path: `listings/applied/${asin}_${mkt}.json` });
        setAppliedInfo(res?.json || null);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const canBuild = repoOk && asinOk && ghUser && !busy;
  const canPreview = repoOk && asinOk && ghUser && !!content && !busy;
  const hasErrors = (checkResult?.nError || 0) > 0;
  const canApply = previewValid && confirmText === "APPLICA" && !hasErrors && !busy;

  const cur = context?.current_copy || {};

  return (
    <div style={{ fontFamily: F.ui }}>
      <div style={{ ...card, padding: S.lg, marginBottom: S.md }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: S.md, flexWrap: "wrap", gap: S.sm }}>
          <div style={{ fontSize: T.lead, fontWeight: 700, color: C.text }}>Scheda prodotto (listing copy)</div>
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
              <span style={{ fontSize: T.micro, color: C.textDim }}>Workflow "Apply Listing Copy"</span>
              <input value={applyWorkflow} onChange={(e) => setApplyWorkflow(e.target.value)} style={{ ...input, width: "100%", fontFamily: F.mono }} />
            </label>
            <div style={{ fontSize: T.micro, color: C.textDim, lineHeight: 1.6 }}>
              Repository e token sono condivisi con la scheda "Azioni": connettendoti qui o li' non serve rifarlo due volte.
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

        {/* ASIN + mercato */}
        <div style={{ display: "flex", gap: S.md, flexWrap: "wrap", alignItems: "flex-end", marginBottom: S.md }}>
          <label>
            <div style={{ fontSize: T.micro, color: C.textDim, marginBottom: 4 }}>ASIN</div>
            <input value={asin} onChange={(e) => setAsin(e.target.value.toUpperCase().trim())}
              placeholder="B0XXXXXXXX" aria-label="ASIN"
              style={{ ...input, width: 150, fontFamily: F.mono, borderColor: asin && !asinOk ? C.red : C.borderStrong }} />
          </label>
          <label>
            <div style={{ fontSize: T.micro, color: C.textDim, marginBottom: 4 }}>Marketplace</div>
            <select value={mkt} onChange={(e) => setMkt(e.target.value)} style={{ ...input, width: 90 }}>
              {MARKETS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <button onClick={doLoadExisting} disabled={!repoOk || !asinOk || !ghUser || !!busy}
            style={button("ghost", { small: true, disabled: !repoOk || !asinOk || !ghUser || !!busy })}>
            {busy === "load" ? "Carico…" : "Carica copy gia' generata"}
          </button>
        </div>

        {/* Passo 1: genera */}
        <div style={{ display: "flex", alignItems: "center", gap: S.md, flexWrap: "wrap", marginBottom: S.sm }}>
          <Chip color={content ? C.green : C.textMuted} bg={content ? C.greenDim : "transparent"}>2. Genera</Chip>
          <button onClick={doBuild} disabled={!canBuild} style={button("ghost", { disabled: !canBuild })}>
            {busy === "build" ? "Genero…" : "Genera brief + copy con Claude"}
          </button>
          <span style={{ fontSize: T.micro, color: C.textDim, flex: "1 1 240px", lineHeight: 1.5 }}>
            Lancia "{buildWorkflow}": costruisce il brief (recensioni, A+, termini di ricerca, Search Query
            Performance) e genera la copy. Non scrive nulla su Amazon.
          </span>
        </div>
        <div style={{ marginBottom: S.sm }}>
          <div style={{ fontSize: T.micro, color: C.textDim, marginBottom: 4 }}>
            Istruzioni particolari per Claude (opzionale)
          </div>
          <textarea value={extraInstructions} onChange={(e) => setExtraInstructions(e.target.value)}
            placeholder='es. "niente emoji nel testo" oppure "e&apos; MDF, non legno: correggi ovunque"'
            aria-label="Istruzioni particolari per Claude"
            style={{ ...input, width: "100%", minHeight: 56, resize: "vertical", lineHeight: 1.5, fontFamily: F.ui }} />
          <div style={{ fontSize: T.micro, color: C.textDim, marginTop: 4, lineHeight: 1.5 }}>
            Vale solo per il prossimo "Genera" su questo ASIN/mercato: ha priorita' sulle regole generiche
            del contratto se in conflitto. Si azzera cambiando ASIN o mercato.
          </div>
        </div>
        {!ghUser && <div style={{ fontSize: T.micro, color: C.textDim, marginBottom: S.sm }}>Connetti prima un token GitHub (passo 1).</div>}
      </div>

      {(context || content) && (
        <div style={{ ...card, padding: S.lg, marginBottom: S.md }}>
          <div style={{ fontSize: T.lead, fontWeight: 700, color: C.text, marginBottom: S.md }}>Controllo qualita'</div>
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
            <div style={{ fontSize: T.small, color: C.textMuted }}>Nessuna copy caricata.</div>
          )}

          {content && (
            <div style={{ marginTop: S.lg, paddingTop: S.lg, borderTop: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: S.sm }}>
                <div style={{ fontSize: T.body, fontWeight: 700, color: C.text }}>Prima / dopo (modificabile)</div>
                <div style={{ fontSize: T.micro, color: C.textDim }}>sinistra: sul listing ora — destra: modifica qui prima di applicare</div>
              </div>
              <div style={{ fontSize: T.micro, color: C.textDim, marginBottom: S.md, lineHeight: 1.6 }}>
                I campi a destra partono precompilati con la copy generata, ma puoi riscriverli liberamente.
                Le modifiche NON riscrivono listings/content/ nel repo: valgono solo per l'anteprima/applicazione
                che lanci da qui. Per renderle permanenti, rigenera la copy dopo aver aggiornato il brief, oppure
                editane il file a mano nel repo.
              </div>
              <EditableFieldDiff label="Titolo" before={cur.item_name} value={titleText}
                onChange={(e) => setTitleText(e.target.value)} />
              <EditableFieldDiff label="Bullet point (uno per riga)" before={bulletsText(cur.bullet_point)} value={bulletText}
                onChange={(e) => setBulletText(e.target.value)} multiline />
              <EditableFieldDiff label="Descrizione" before={cur.product_description} value={descriptionText}
                onChange={(e) => setDescriptionText(e.target.value)} multiline />
            </div>
          )}
        </div>
      )}

      {content && (
        <div style={{ ...card, padding: S.lg }}>
          {/* Passo 2: anteprima */}
          <div style={{ display: "flex", alignItems: "center", gap: S.md, flexWrap: "wrap", marginBottom: S.md }}>
            <Chip color={previewValid ? C.green : C.textMuted} bg={previewValid ? C.greenDim : "transparent"}>3. Anteprima</Chip>
            <button onClick={doPreview} disabled={!canPreview} style={button("ghost", { disabled: !canPreview })}>
              {busy === "preview" ? "Anteprima in corso…" : "Genera anteprima"}
            </button>
            <span style={{ fontSize: T.micro, color: C.textDim, flex: "1 1 240px", lineHeight: 1.5 }}>
              Esegue il controllo qualita' e una VALIDATION_PREVIEW su Amazon sulla copy modificata qui sopra,
              senza scrivere nulla.
            </span>
          </div>

          {/* Passo 3: applica */}
          <div style={{ display: "flex", alignItems: "center", gap: S.md, flexWrap: "wrap" }}>
            <Chip color={canApply ? C.red : C.textMuted} bg={canApply ? C.redDim : "transparent"}>4. Applica</Chip>
            <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
              placeholder="scrivi APPLICA" disabled={!previewValid || hasErrors} aria-label="Conferma digitando APPLICA"
              style={{ ...input, width: 150, fontFamily: F.mono, opacity: previewValid && !hasErrors ? 1 : 0.5 }} />
            <button onClick={doApply} disabled={!canApply} style={button("danger", { disabled: !canApply })}>
              {busy === "apply" ? "Applicazione…" : `Applica su ${mkt}`}
            </button>
          </div>

          {!previewValid && (
            <div style={{ fontSize: T.micro, color: C.textDim, marginTop: S.sm, lineHeight: 1.6 }}>
              {hasErrors
                ? "Il controllo qualita' ha trovato errori: correggi i campi qui sopra (o rigenera la copy) prima di poter applicare."
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
            <div style={{ marginTop: S.md, padding: S.md, borderRadius: R.md, background: C.greenDim }}>
              <div style={{ fontSize: T.small, fontWeight: 700, color: C.text, marginBottom: 4 }}>Applicato su Amazon</div>
              <div style={{ fontSize: T.micro, color: C.textMuted, lineHeight: 1.6 }}>
                stato: {appliedInfo.status || "?"} · submissionId: {appliedInfo.submissionId || "?"}<br />
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
