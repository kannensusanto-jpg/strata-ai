import { useState, useRef, useEffect, useCallback } from "react";
import { RadarChart, Radar, PolarGrid, PolarAngleAxis, ResponsiveContainer } from "recharts";
import * as Papa from "papaparse";
import { Upload, AlertCircle, RefreshCw } from "lucide-react";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const SEV_COLOR = { high: "#ef4444", medium: "#f59e0b", low: "#6b7280" };
const SEV_BG    = { high: "rgba(239,68,68,0.12)", medium: "rgba(245,158,11,0.12)", low: "rgba(107,114,128,0.12)" };
const TYPE_COLOR = { info: "#38bdf8", warn: "#f59e0b", error: "#ef4444" };

const riskColor = (s) => s >= 75 ? "#ef4444" : s >= 50 ? "#f59e0b" : s >= 30 ? "#38bdf8" : "#34d399";
const riskLabel = (s) => s >= 75 ? "Critical" : s >= 50 ? "High" : s >= 30 ? "Moderate" : "Low";

const fmt = (n) => {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs/1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs/1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs/1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};

// ─── SAMPLE CSVs ─────────────────────────────────────────────────────────────

const SAMPLE_HIERARCHY_CSV = `EntityID,EntityName,ParentID,EntityType,Region,Currency
GC,Global Corp,,Holding,Global,USD
AM,Americas,GC,Regional,Americas,USD
EM,EMEA,GC,Regional,EMEA,EUR
AP,APAC,GC,Regional,APAC,USD
USS,US Sales Co,AM,Operating,Americas,USD
UST,US Tech Inc,AM,Operating,Americas,USD
USS2,US Sales Co II,AM,Operating,Americas,USD
UKL,UK Ltd,EM,Operating,EMEA,GBP
DEG,Germany GmbH,EM,Operating,EMEA,EUR
JPN,Japan KK,EM,Operating,APAC,JPY
SGP,Singapore Pte,AP,Operating,APAC,SGD
AUP,Australia Pty,AP,Operating,APAC,AUD`;

const SAMPLE_TB_CSV = `Entity,CounterpartyEntity,AccountCode,AccountDescription,AccountType,Currency,Amount
USS,UKL,1100,IC Receivable - Revenue,IC_Receivable,USD,2400000
UKL,USS,2100,IC Payable - Revenue,IC_Payable,GBP,2400000
UST,DEG,1101,IC Receivable - Services,IC_Receivable,USD,1850000
DEG,UST,2101,IC Payable - Services,IC_Payable,EUR,1802500
USS,SGP,1102,IC Receivable - Royalties,IC_Receivable,USD,620000
SGP,USS,2102,IC Payable - Royalties,IC_Payable,SGD,620000
UKL,AUP,1103,IC Receivable - Management Fee,IC_Receivable,GBP,380000
UST,JPN,1104,IC Receivable - Revenue,IC_Receivable,USD,910000
JPN,UST,2103,IC Payable - Revenue,IC_Payable,JPY,889000
DEG,SGP,1105,IC Receivable - Procurement,IC_Receivable,EUR,275000
SGP,DEG,2104,IC Payable - Procurement,IC_Payable,SGD,275000`;

// ─── CSV PARSERS ──────────────────────────────────────────────────────────────

const parseHierarchyCSV = (text) => {
  const result = Papa.parse(text, { header: true, skipEmptyLines: true });
  const rows = result.data;
  if (!rows.length) throw new Error("No data found in CSV");
  const h = Object.keys(rows[0]);
  const findCol = (aliases) => h.find(k => aliases.includes(k.toLowerCase().trim())) || null;
  const idCol       = findCol(["entityid","id","entity id","entity_id","code","entitycode"]);
  const nameCol     = findCol(["entityname","name","entity name","entity_name","description"]);
  const parentCol   = findCol(["parentid","parent id","parent_id","parent","parentcode","parent code"]);
  const typeCol     = findCol(["entitytype","type","entity type","entity_type"]);
  const regionCol   = findCol(["region"]);
  const currencyCol = findCol(["currency","ccy","functional currency"]);
  if (!idCol || !nameCol) throw new Error("CSV must have EntityID and EntityName columns");
  return rows.map(row => ({
    id:       String(row[idCol] || "").trim(),
    name:     String(row[nameCol] || "").trim(),
    parent:   parentCol ? (String(row[parentCol] || "").trim() || null) : null,
    type:     typeCol ? String(row[typeCol] || "Operating").trim() : "Operating",
    region:   regionCol ? String(row[regionCol] || "").trim() : "",
    currency: currencyCol ? String(row[currencyCol] || "USD").trim() : "USD",
  })).filter(e => e.id && e.name);
};

const parseTBCSV = (text) => {
  const result = Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const rows = result.data;
  if (!rows.length) throw new Error("No data found in CSV");
  const h = Object.keys(rows[0]);
  const findCol = (aliases) => h.find(k => aliases.includes(k.toLowerCase().trim())) || null;
  const entityCol       = findCol(["entity","entity id","entityid"]);
  const counterpartyCol = findCol(["counterpartyentity","counterparty","counterparty entity","ic counterparty","icpartner"]);
  const descCol         = findCol(["accountdescription","description","account description","accountname","account name"]);
  const typeCol         = findCol(["accounttype","type","account type","account_type"]);
  const amountCol       = findCol(["amount","balance","value","net amount"]);
  const currencyCol     = findCol(["currency","ccy"]);
  if (!entityCol || !amountCol) throw new Error("CSV must have Entity and Amount columns");
  return rows.map(row => ({
    entity:       String(row[entityCol] || "").trim(),
    counterparty: counterpartyCol ? String(row[counterpartyCol] || "").trim() : "",
    description:  descCol ? String(row[descCol] || "").trim() : "",
    type:         typeCol ? String(row[typeCol] || "").trim() : "",
    amount:       typeof row[amountCol] === "number" ? row[amountCol] : parseFloat(String(row[amountCol] || "0").replace(/[$,]/g, "")) || 0,
    currency:     currencyCol ? String(row[currencyCol] || "").trim() : "",
  })).filter(r => r.entity);
};

// ─── ANALYSIS ENGINES ─────────────────────────────────────────────────────────

const analyseHierarchy = (entities) => {
  const issues = [];
  const nameCounts = {};
  entities.forEach(e => {
    const key = e.name.toLowerCase().replace(/\s+/g, " ").trim();
    if (!nameCounts[key]) nameCounts[key] = [];
    nameCounts[key].push(e.id);
  });
  Object.entries(nameCounts).forEach(([name, ids]) => {
    if (ids.length > 1) issues.push({ id: `DUP-${ids.join("-")}`, type: "redundant_rollup", severity: "high", entity: ids[1], title: "Potential Duplicate Entity", desc: `"${name}" appears ${ids.length} times (${ids.join(", ")}). This may cause double-counting in IC eliminations.`, fix: `Review ${ids.join(" and ")} — archive the redundant entity and remap its transactions.` });
  });
  entities.forEach(e => {
    if (!e.parent) return;
    const parent = entities.find(p => p.id === e.parent);
    if (!parent) {
      issues.push({ id: `INV-${e.id}`, type: "invalid_parent", severity: "high", entity: e.id, title: "Invalid Parent Reference", desc: `"${e.name}" references parent "${e.parent}" which does not exist in the hierarchy.`, fix: `Assign a valid parent to ${e.name} or add the missing parent entity.` });
      return;
    }
    if (e.region && parent.region && parent.region !== "Global" && e.region !== parent.region && parent.type === "Regional") {
      issues.push({ id: `RGN-${e.id}`, type: "wrong_parent", severity: "high", entity: e.id, title: "Region / Parent Mismatch", desc: `"${e.name}" is in region ${e.region} but sits under "${parent.name}" (${parent.region}). This misclassifies revenue and costs in the wrong regional P&L.`, fix: `Re-parent ${e.name} to the correct regional entity for ${e.region}.` });
    }
  });
  return issues;
};

const reconcileIC = (tbRows) => {
  const icReceivables = tbRows.filter(r => r.type === "IC_Receivable" && r.counterparty);
  const icPayables    = tbRows.filter(r => r.type === "IC_Payable"    && r.counterparty);
  const pairs = [];
  const matched = new Set();
  icReceivables.forEach(rec => {
    const key = `${rec.entity}-${rec.counterparty}`;
    if (matched.has(key)) return;
    matched.add(key);
    const payable = icPayables.find(p => p.entity === rec.counterparty && p.counterparty === rec.entity);
    const recAmt = Math.abs(rec.amount);
    const payAmt = payable ? Math.abs(payable.amount) : 0;
    const gap = Math.abs(recAmt - payAmt);
    const reconciled = gap < recAmt * 0.001;
    pairs.push({ id: key, from: rec.entity, to: rec.counterparty, type: rec.description.replace(/IC Receivable - |IC Payable - /gi, ""), senderAmt: recAmt, receiverAmt: payAmt, gap, reconciled, missing: !payable, senderCcy: rec.currency, receiverCcy: payable?.currency || "?" });
  });
  icPayables.forEach(pay => {
    const key = `${pay.counterparty}-${pay.entity}`;
    if (matched.has(key)) return;
    const hasRec = icReceivables.find(r => r.entity === pay.counterparty && r.counterparty === pay.entity);
    if (!hasRec) {
      pairs.push({ id: `ORPHAN-${pay.entity}-${pay.counterparty}`, from: pay.counterparty, to: pay.entity, type: pay.description.replace(/IC Payable - /gi, ""), senderAmt: 0, receiverAmt: Math.abs(pay.amount), gap: Math.abs(pay.amount), reconciled: false, missing: false, orphanPayable: true, senderCcy: "?", receiverCcy: pay.currency });
    }
  });
  return pairs;
};

const computeRiskScores = (entities, tbRows, icPairs) => {
  return entities.filter(e => ["operating","Operating"].includes(e.type)).map(e => {
    const entityPairs   = icPairs.filter(p => p.from === e.id || p.to === e.id);
    const icMismatches  = entityPairs.filter(p => !p.reconciled).length;
    const icComplexity  = Math.min(5, entityPairs.length);
    const multiCcy      = entityPairs.filter(p => p.senderCcy !== p.receiverCcy).length;
    const fxRisk        = Math.min(5, multiCcy + (e.currency !== "USD" ? 1 : 0));
    const churn         = entityPairs.filter(p => p.missing || p.orphanPayable).length;
    const totalGap      = entityPairs.reduce((s, p) => s + (p.gap || 0), 0);
    const score         = Math.min(100, Math.round((icMismatches * 18) + (fxRisk * 8) + (icComplexity * 5) + (churn * 15) + (totalGap > 500000 ? 15 : totalGap > 100000 ? 8 : 0)));
    return { id: e.id, entity: e.name, score, churn, fxRisk, icComplexity, icMismatches, totalGap };
  }).sort((a, b) => b.score - a.score);
};

const buildAuditLog = (entities, icPairs, issues) => {
  const t = new Date().toTimeString().slice(0,8);
  const log = [{ time: t, action: "Hierarchy scan completed", detail: `${entities.length} entities scanned`, type: "info" }];
  issues.forEach(i => log.push({ time: t, action: `Issue: ${i.title}`, detail: i.entity, type: i.severity === "high" ? "error" : "warn" }));
  icPairs.forEach(p => {
    if (p.reconciled) log.push({ time: t, action: `IC reconciled: ${p.from} → ${p.to}`, detail: fmt(p.senderAmt), type: "info" });
    else log.push({ time: t, action: `IC gap: ${p.from} → ${p.to}`, detail: `Gap: ${fmt(p.gap)}${p.missing ? " (MISSING)" : ""}`, type: "error" });
  });
  return log;
};

// ─── UPLOAD ZONE ──────────────────────────────────────────────────────────────

function UploadZone({ onFile, label, hint, sample, sampleName }) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(null);
  const handle = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => { try { onFile(e.target.result); setError(null); } catch (err) { setError(err.message); } };
    reader.readAsText(file);
  }, [onFile]);
  const downloadSample = () => {
    const blob = new Blob([sample], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = sampleName; a.click();
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: 40 }}>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); handle(e.dataTransfer.files[0]); }}
        onClick={() => document.getElementById(`upload-${sampleName}`).click()}
        style={{ border: `2px dashed ${dragging ? "#38bdf8" : "rgba(255,255,255,0.1)"}`, borderRadius: 16, padding: "40px 48px", cursor: "pointer", background: dragging ? "rgba(56,189,248,0.05)" : "rgba(255,255,255,0.02)", transition: "all 0.2s", textAlign: "center", maxWidth: 440, width: "100%" }}
      >
        <Upload size={32} color={dragging ? "#38bdf8" : "#334155"} style={{ margin: "0 auto 12px" }} />
        <p style={{ fontSize: 14, fontWeight: 700, color: "#94a3b8", marginBottom: 6 }}>{label}</p>
        <p style={{ fontSize: 11, color: "#475569", lineHeight: 1.6 }}>{hint}</p>
        <input id={`upload-${sampleName}`} type="file" accept=".csv" style={{ display: "none" }} onChange={(e) => handle(e.target.files[0])} />
      </div>
      {error && <div style={{ display: "flex", gap: 8, alignItems: "center", color: "#f87171", fontSize: 12 }}><AlertCircle size={13} /> {error}</div>}
      <button onClick={downloadSample} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, color: "#64748b", fontSize: 12, padding: "7px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit" }}>
        <RefreshCw size={11} /> Download sample CSV
      </button>
    </div>
  );
}

// ─── HIERARCHY TREE ───────────────────────────────────────────────────────────

function HierarchyNode({ entity, entities, issues, depth = 0 }) {
  const [open, setOpen] = useState(depth < 2);
  const children = entities.filter(e => e.parent === entity.id);
  const entityIssues = issues.filter(i => i.entity === entity.id);
  const typeColor = entity.type === "Holding" ? "#38bdf8" : entity.type === "Regional" ? "#a78bfa" : "#64748b";
  return (
    <div style={{ marginLeft: depth > 0 ? 22 : 0 }}>
      <div onClick={() => children.length && setOpen(o => !o)} className="tree-node"
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 8, cursor: children.length ? "pointer" : "default", marginBottom: 3, transition: "background 0.12s" }}>
        <span style={{ fontSize: 10, color: "#374151", width: 10, flexShrink: 0 }}>{children.length ? (open ? "▼" : "▶") : "·"}</span>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", color: typeColor, background: `${typeColor}18`, padding: "2px 6px", borderRadius: 4, flexShrink: 0 }}>{(entity.type || "").toUpperCase()}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0", flex: 1 }}>{entity.name}</span>
        <span style={{ fontSize: 10, color: "#334155", fontFamily: "monospace" }}>{entity.id}</span>
        <span style={{ fontSize: 10, color: "#334155" }}>{entity.currency}</span>
        {entity.region && <span style={{ fontSize: 10, color: "#1e3a4a", background: "rgba(56,189,248,0.06)", padding: "1px 5px", borderRadius: 3 }}>{entity.region}</span>}
        {entityIssues.map(issue => (
          <span key={issue.id} style={{ fontSize: 9, fontWeight: 700, padding: "2px 5px", borderRadius: 3, background: SEV_BG[issue.severity], color: SEV_COLOR[issue.severity], letterSpacing: "0.05em", flexShrink: 0 }}>
            {issue.type === "redundant_rollup" ? "DUPLICATE" : issue.type === "wrong_parent" ? "WRONG PARENT" : issue.type === "invalid_parent" ? "BAD PARENT" : "ISSUE"}
          </span>
        ))}
      </div>
      {open && children.map(child => <HierarchyNode key={child.id} entity={child} entities={entities} issues={issues} depth={depth + 1} />)}
    </div>
  );
}

// ─── RECON GRAPH ─────────────────────────────────────────────────────────────

function ReconGraph({ pair }) {
  const gap = pair.gap || 0;
  return (
    <div style={{ padding: "20px 0" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.25)", borderRadius: 12, padding: "16px 20px", minWidth: 160, textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "#38bdf8", fontWeight: 700, marginBottom: 4 }}>SENDER</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#f1f5f9" }}>{pair.from}</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>{pair.type}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#38bdf8", marginTop: 8, fontFamily: "monospace" }}>{fmt(pair.senderAmt)}</div>
          <div style={{ fontSize: 10, color: pair.senderAmt > 0 ? "#34d399" : "#ef4444", marginTop: 4 }}>{pair.orphanPayable ? "✗ No IC Receivable" : pair.senderAmt > 0 ? "✓ IC Receivable posted" : "✗ Not posted"}</div>
          <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>{pair.senderCcy}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 120 }}>
          <div style={{ fontSize: 9, color: "#64748b", marginBottom: 6 }}>{pair.reconciled ? "✓ MATCHED" : "✗ GAP DETECTED"}</div>
          <div style={{ height: 2, width: "100%", background: pair.reconciled ? "#34d399" : "#ef4444", position: "relative" }}>
            {!pair.reconciled && gap > 0 && (
              <div style={{ position: "absolute", top: -14, left: "50%", transform: "translateX(-50%)", background: "#ef4444", color: "white", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, whiteSpace: "nowrap" }}>{fmt(gap)} GAP</div>
            )}
          </div>
          <div style={{ fontSize: 18, color: pair.reconciled ? "#34d399" : "#ef4444", marginTop: 4 }}>→</div>
        </div>
        <div style={{ background: pair.missing || pair.orphanPayable ? "rgba(239,68,68,0.05)" : "rgba(167,139,250,0.08)", border: `1px solid ${pair.missing || pair.orphanPayable ? "rgba(239,68,68,0.3)" : "rgba(167,139,250,0.25)"}`, borderRadius: 12, padding: "16px 20px", minWidth: 160, textAlign: "center" }}>
          <div style={{ fontSize: 10, color: pair.missing ? "#ef4444" : "#a78bfa", fontWeight: 700, marginBottom: 4 }}>RECEIVER</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#f1f5f9" }}>{pair.to}</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>{pair.type}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: pair.missing ? "#ef4444" : "#a78bfa", marginTop: 8, fontFamily: "monospace" }}>{pair.missing ? "NOT FOUND" : fmt(pair.receiverAmt)}</div>
          <div style={{ fontSize: 10, color: pair.missing ? "#ef4444" : pair.reconciled ? "#34d399" : "#f59e0b", marginTop: 4 }}>{pair.missing ? "✗ No IC Payable entry" : pair.reconciled ? "✓ IC Payable posted" : `✗ ${fmt(gap)} short`}</div>
          <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>{pair.receiverCcy}</div>
        </div>
      </div>
      {!pair.reconciled && (
        <div style={{ marginTop: 20, background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 10, padding: "14px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#ef4444", marginBottom: 8, letterSpacing: "0.08em" }}>ROOT CAUSE ANALYSIS</div>
          {pair.missing && <p style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.6 }}>IC payable entry is completely absent in {pair.to}. The {pair.type} was recorded by {pair.from} but {pair.to} has no corresponding payable. Full {fmt(gap)} will appear as an elimination difference at consolidation.</p>}
          {pair.orphanPayable && <p style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.6 }}>IC payable exists in {pair.to} but no corresponding IC receivable was found in {pair.from}. This is an orphan payable — likely a posting in only one entity.</p>}
          {!pair.missing && !pair.orphanPayable && pair.senderCcy !== pair.receiverCcy && <p style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.6 }}>Gap of {fmt(gap)} detected between {pair.from} ({pair.senderCcy}) and {pair.to} ({pair.receiverCcy}). Likely cause: FX translation difference — the IC balance was recorded at different exchange rates in each entity.</p>}
          {!pair.missing && !pair.orphanPayable && pair.senderCcy === pair.receiverCcy && <p style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.6 }}>Balance mismatch of {fmt(gap)} detected. Possible causes: timing difference on late postings, different ownership percentages, or a partial reversal in one entity.</p>}
          <div style={{ marginTop: 12, padding: "10px 14px", background: "rgba(52,211,153,0.08)", borderRadius: 8, border: "1px solid rgba(52,211,153,0.2)" }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#34d399", marginRight: 6 }}>RECOMMENDED FIX</span>
            <span style={{ fontSize: 12, color: "#94a3b8" }}>
              {pair.missing ? `Post IC payable in ${pair.to} for ${fmt(pair.senderAmt)} ${pair.receiverCcy} matching the ${pair.from} receivable.`
                : pair.orphanPayable ? `Post IC receivable in ${pair.from} or reverse the orphan payable in ${pair.to}.`
                : `Agree a standard exchange rate between ${pair.from} and ${pair.to} and book a correction entry for the ${fmt(gap)} difference.`}
            </span>
          </div>
        </div>
      )}
      {pair.reconciled && (
        <div style={{ marginTop: 16, background: "rgba(52,211,153,0.06)", border: "1px solid rgba(52,211,153,0.2)", borderRadius: 10, padding: "12px 18px", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 18, color: "#34d399" }}>✓</span>
          <span style={{ fontSize: 12, color: "#34d399" }}>Fully reconciled — {pair.from} and {pair.to} balances match within tolerance.</span>
        </div>
      )}
    </div>
  );
}

// ─── CHATBOT ─────────────────────────────────────────────────────────────────

function Chatbot({ entities, icPairs, issues, riskScores }) {
  const systemPrompt = `You are Strata AI, an expert AI assistant for Enterprise Performance Management (EPM) and financial consolidation.

CURRENT HIERARCHY (${entities.length} entities):
${entities.map(e => `- ${e.name} (${e.id}): ${e.type}, parent: ${e.parent || "ROOT"}, region: ${e.region}, currency: ${e.currency}`).join("\n")}

DETECTED HIERARCHY ISSUES (${issues.length}):
${issues.length ? issues.map(i => `- ${i.title} [${i.severity}]: ${i.desc} FIX: ${i.fix}`).join("\n") : "None"}

IC RECONCILIATION (${icPairs.length} pairs):
${icPairs.length ? icPairs.map(p => `- ${p.from} → ${p.to}: ${p.type}, Sender: ${fmt(p.senderAmt)}, Receiver: ${fmt(p.receiverAmt)}, Gap: ${fmt(p.gap)}, Status: ${p.reconciled ? "RECONCILED" : p.missing ? "MISSING PAYABLE" : "GAP"}`).join("\n") : "No IC data uploaded"}

RISK SCORES:
${riskScores.length ? riskScores.map(r => `- ${r.entity} (${r.id}): ${r.score}/100 [${riskLabel(r.score)}] — IC mismatches: ${r.icMismatches}, FX risk: ${r.fxRisk}/5, IC complexity: ${r.icComplexity}/5, churn: ${r.churn}`).join("\n") : "No risk data"}

Answer questions about hierarchy issues, reconciliation failures, IC pairs, risk scores, and recommended fixes. Be specific, concise and use CFO-level finance language. Use entity names and amounts where relevant.`;

  const [messages, setMessages] = useState([
    { role: "assistant", content: entities.length
      ? `Hello. I'm Strata AI. I've scanned your data — **${entities.length} entities**, **${icPairs.length} IC pairs**, **${issues.length} hierarchy issues** detected.\n\nAsk me anything about your consolidation structure, reconciliation gaps, or entity risk.`
      : `Hello. I'm Strata AI. No data has been uploaded yet — head to the Hierarchy or Reconciliation tabs to upload your CSVs first, then come back for a full analysis.` }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);
  const SUGGESTED = ["Which entity is highest risk and why?", "What IC pairs have unreconciled gaps?", "Are there any hierarchy structure issues?", "What should I prioritise before close?"];
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const send = async (text) => {
    const msg = text || input.trim();
    if (!msg || loading) return;
    setInput("");
    const next = [...messages, { role: "user", content: msg }];
    setMessages(next);
    setLoading(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system: systemPrompt, messages: next.map(m => ({ role: m.role, content: m.content })) }),
      });
      const data = await res.json();
      setMessages(m => [...m, { role: "assistant", content: data.content?.[0]?.text || "I couldn't process that." }]);
    } catch { setMessages(m => [...m, { role: "assistant", content: "Connection error. Please try again." }]); }
    setLoading(false);
  };

  const renderMsg = (content) => content.split("\n").map((line, i) => {
    const html = line.replace(/\*\*(.+?)\*\*/g, (_, t) => `<strong style="color:#f1f5f9">${t}</strong>`);
    return <p key={i} style={{ margin: "2px 0", lineHeight: 1.65 }} dangerouslySetInnerHTML={{ __html: html || "&nbsp;" }} />;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", flexDirection: m.role === "user" ? "row-reverse" : "row" }}>
            <div style={{ width: 30, height: 30, borderRadius: "50%", flexShrink: 0, background: m.role === "assistant" ? "linear-gradient(135deg,#38bdf8,#a78bfa)" : "rgba(255,255,255,0.1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: m.role === "assistant" ? "white" : "#94a3b8" }}>
              {m.role === "assistant" ? "S" : "U"}
            </div>
            <div style={{ maxWidth: "75%", fontSize: 13, lineHeight: 1.6, color: "#94a3b8", background: m.role === "assistant" ? "rgba(56,189,248,0.05)" : "rgba(255,255,255,0.04)", border: `1px solid ${m.role === "assistant" ? "rgba(56,189,248,0.15)" : "rgba(255,255,255,0.07)"}`, borderRadius: m.role === "assistant" ? "4px 12px 12px 12px" : "12px 4px 12px 12px", padding: "12px 16px" }}>
              {renderMsg(m.content)}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div style={{ width: 30, height: 30, borderRadius: "50%", background: "linear-gradient(135deg,#38bdf8,#a78bfa)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "white" }}>S</div>
            <div style={{ background: "rgba(56,189,248,0.05)", border: "1px solid rgba(56,189,248,0.15)", borderRadius: "4px 12px 12px 12px", padding: "14px 18px" }}>
              <div style={{ display: "flex", gap: 5 }}>{[0,1,2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#38bdf8", animation: `pulse 1.2s ${i*0.2}s infinite` }} />)}</div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {messages.length <= 2 && (
        <div style={{ padding: "0 24px 12px", display: "flex", flexWrap: "wrap", gap: 8 }}>
          {SUGGESTED.map((s, i) => <button key={i} onClick={() => send(s)} style={{ background: "rgba(56,189,248,0.06)", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 20, padding: "6px 12px", fontSize: 11, color: "#38bdf8", cursor: "pointer", fontFamily: "inherit" }}>{s}</button>)}
        </div>
      )}
      <div style={{ padding: "12px 24px 20px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", gap: 10, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "8px 12px 8px 16px", alignItems: "center" }}>
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} placeholder="Ask about reconciliation, hierarchy, risk…" style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "#f1f5f9", fontSize: 13, fontFamily: "inherit" }} />
          <button onClick={() => send()} disabled={!input.trim() || loading} style={{ background: input.trim() ? "linear-gradient(135deg,#38bdf8,#a78bfa)" : "rgba(255,255,255,0.08)", border: "none", borderRadius: 8, padding: "7px 14px", color: input.trim() ? "white" : "#475569", fontSize: 12, fontWeight: 700, cursor: input.trim() ? "pointer" : "default", transition: "all 0.15s", fontFamily: "inherit" }}>Ask →</button>
        </div>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

export default function StrataAI() {
  const [tab, setTab] = useState("hierarchy");
  const [entities, setEntities] = useState([]);
  const [tbRows, setTbRows] = useState([]);
  const [selectedPair, setSelectedPair] = useState(null);
  const [selectedIssue, setSelectedIssue] = useState(null);

  const issues     = analyseHierarchy(entities);
  const icPairs    = reconcileIC(tbRows);
  const riskScores = computeRiskScores(entities, tbRows, icPairs);
  const auditLog   = buildAuditLog(entities, icPairs, issues);
  const reconGap   = icPairs.filter(p => !p.reconciled).length;
  const topRisk    = riskScores[0];

  const handleHierarchyUpload = useCallback((text) => { setEntities(parseHierarchyCSV(text)); }, []);
  const handleTBUpload = useCallback((text) => { setTbRows(parseTBCSV(text)); }, []);
  const loadSampleAll = () => { setEntities(parseHierarchyCSV(SAMPLE_HIERARCHY_CSV)); setTbRows(parseTBCSV(SAMPLE_TB_CSV)); };

  const TABS = [
    { id: "hierarchy",      label: "Hierarchy",      icon: "⬡" },
    { id: "reconciliation", label: "Reconciliation", icon: "⊕" },
    { id: "risk",           label: "Risk",           icon: "◈" },
    { id: "chat",           label: "AI Assistant",   icon: "✦" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#060b16", color: "#e2e8f0", fontFamily: "'Syne', system-ui, sans-serif", display: "flex", flexDirection: "column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }
        .tab-btn:hover { background: rgba(56,189,248,0.06) !important; }
        .tree-node:hover { background: rgba(255,255,255,0.03) !important; }
        .ic-row:hover { background: rgba(56,189,248,0.05) !important; }
        .issue-card:hover { border-color: rgba(255,255,255,0.12) !important; }
        @keyframes pulse { 0%,80%,100% { opacity:0.2; transform:scale(0.8); } 40% { opacity:1; transform:scale(1); } }
        @keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
        .fade-in { animation: fadeIn 0.3s ease; }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 28px", borderBottom: "1px solid rgba(56,189,248,0.1)", background: "rgba(6,11,22,0.95)", backdropFilter: "blur(16px)", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ position: "relative" }}>
            <div style={{ width: 34, height: 34, background: "linear-gradient(135deg,#38bdf8,#a78bfa)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ fontSize: 14, fontWeight: 800, color: "white" }}>S</span>
            </div>
            <div style={{ position: "absolute", top: -2, right: -2, width: 8, height: 8, background: "#34d399", borderRadius: "50%", border: "2px solid #060b16" }} />
          </div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-0.03em", background: "linear-gradient(90deg,#38bdf8,#a78bfa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Strata AI</div>
            <div style={{ fontSize: 10, color: "#475569", letterSpacing: "0.12em", fontWeight: 600 }}>EPM INTELLIGENCE PLATFORM</div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} className="tab-btn" style={{ background: tab === t.id ? "rgba(56,189,248,0.12)" : "transparent", border: `1px solid ${tab === t.id ? "rgba(56,189,248,0.35)" : "rgba(255,255,255,0.06)"}`, borderRadius: 8, padding: "6px 14px", color: tab === t.id ? "#38bdf8" : "#64748b", fontSize: 12, fontWeight: 700, cursor: "pointer", transition: "all 0.15s", display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit" }}>
              <span style={{ fontSize: 11 }}>{t.icon}</span> {t.label}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          {entities.length > 0 && <div style={{ textAlign: "right" }}><div style={{ fontSize: 10, color: "#475569" }}>ENTITIES</div><div style={{ fontSize: 11, color: "#38bdf8", fontWeight: 700, fontFamily: "monospace" }}>{entities.length}</div></div>}
          {icPairs.length > 0 && <div style={{ textAlign: "right" }}><div style={{ fontSize: 10, color: "#475569" }}>IC GAPS</div><div style={{ fontSize: 11, color: reconGap > 0 ? "#ef4444" : "#34d399", fontWeight: 700, fontFamily: "monospace" }}>{reconGap}</div></div>}
          {issues.length > 0 && <div style={{ textAlign: "right" }}><div style={{ fontSize: 10, color: "#475569" }}>ISSUES</div><div style={{ fontSize: 11, color: "#ef4444", fontWeight: 700, fontFamily: "monospace" }}>{issues.length}</div></div>}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "hidden" }}>

        {/* ── HIERARCHY ── */}
        {tab === "hierarchy" && (
          <div className="fade-in" style={{ height: "calc(100vh - 65px)", display: "grid", gridTemplateColumns: entities.length ? "1fr 360px" : "1fr" }}>
            {!entities.length ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
                <UploadZone label="Upload Entity Hierarchy CSV" hint="Required: EntityID, EntityName, ParentID · Optional: EntityType, Region, Currency" sample={SAMPLE_HIERARCHY_CSV} sampleName="sample-hierarchy.csv" onFile={handleHierarchyUpload} />
                <button onClick={loadSampleAll} style={{ background: "rgba(56,189,248,0.1)", border: "1px solid rgba(56,189,248,0.25)", borderRadius: 8, color: "#38bdf8", fontSize: 12, padding: "8px 16px", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>▶ Load sample data instead</button>
              </div>
            ) : (
              <>
                <div style={{ padding: "24px 28px", overflowY: "auto", borderRight: "1px solid rgba(255,255,255,0.05)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
                    <div>
                      <h2 style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 4 }}>Entity Hierarchy</h2>
                      <p style={{ fontSize: 12, color: "#475569" }}>{entities.length} entities · {issues.length} issues detected</p>
                    </div>
                    <button onClick={() => setEntities([])} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 7, padding: "5px 10px", color: "#475569", fontSize: 11, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}>
                      <Upload size={11} /> Replace CSV
                    </button>
                  </div>
                  <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "16px" }}>
                    {entities.filter(e => !e.parent).map(root => <HierarchyNode key={root.id} entity={root} entities={entities} issues={issues} />)}
                  </div>
                </div>
                <div style={{ padding: "24px 20px", overflowY: "auto" }}>
                  <h3 style={{ fontSize: 12, fontWeight: 700, color: "#64748b", letterSpacing: "0.1em", marginBottom: 14 }}>DETECTED ISSUES</h3>
                  {issues.length === 0 ? (
                    <div style={{ background: "rgba(52,211,153,0.06)", border: "1px solid rgba(52,211,153,0.2)", borderRadius: 10, padding: "16px", textAlign: "center" }}>
                      <div style={{ fontSize: 20, marginBottom: 6 }}>✓</div>
                      <p style={{ fontSize: 12, color: "#34d399", fontWeight: 700 }}>No issues detected</p>
                      <p style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>Hierarchy structure looks clean</p>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {issues.map(issue => (
                        <div key={issue.id} className="issue-card" onClick={() => setSelectedIssue(selectedIssue?.id === issue.id ? null : issue)}
                          style={{ background: selectedIssue?.id === issue.id ? SEV_BG[issue.severity] : "rgba(255,255,255,0.02)", border: `1px solid ${selectedIssue?.id === issue.id ? SEV_COLOR[issue.severity] + "50" : "rgba(255,255,255,0.06)"}`, borderLeft: `3px solid ${SEV_COLOR[issue.severity]}`, borderRadius: 10, padding: "12px 14px", cursor: "pointer", transition: "all 0.15s" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0" }}>{issue.title}</span>
                            <span style={{ fontSize: 9, fontWeight: 700, color: SEV_COLOR[issue.severity], background: SEV_BG[issue.severity], padding: "2px 6px", borderRadius: 3, letterSpacing: "0.08em", flexShrink: 0, marginLeft: 8 }}>{issue.severity.toUpperCase()}</span>
                          </div>
                          <div style={{ fontSize: 11, color: "#64748b" }}>{issue.desc.substring(0, 80)}...</div>
                          {selectedIssue?.id === issue.id && (
                            <div style={{ marginTop: 10 }}>
                              <p style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.6, marginBottom: 8 }}>{issue.desc}</p>
                              <div style={{ background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.2)", borderRadius: 6, padding: "8px 10px" }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: "#34d399" }}>FIX: </span>
                                <span style={{ fontSize: 11, color: "#94a3b8" }}>{issue.fix}</span>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <h3 style={{ fontSize: 12, fontWeight: 700, color: "#64748b", letterSpacing: "0.1em", margin: "24px 0 12px" }}>AUDIT LOG</h3>
                  <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 10, padding: "12px", fontFamily: "JetBrains Mono, monospace" }}>
                    {auditLog.map((log, i) => (
                      <div key={i} style={{ display: "flex", gap: 10, fontSize: 10, marginBottom: 5, alignItems: "flex-start" }}>
                        <span style={{ color: "#334155", flexShrink: 0 }}>{log.time}</span>
                        <span style={{ color: TYPE_COLOR[log.type], flexShrink: 0 }}>{log.type === "error" ? "ERR" : log.type === "warn" ? "WRN" : "INF"}</span>
                        <span style={{ color: "#64748b" }}>{log.action}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── RECONCILIATION ── */}
        {tab === "reconciliation" && (
          <div className="fade-in" style={{ height: "calc(100vh - 65px)", display: "grid", gridTemplateColumns: icPairs.length ? "280px 1fr" : "1fr" }}>
            {!icPairs.length ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
                <UploadZone label="Upload GL Trial Balance CSV" hint="Required: Entity, CounterpartyEntity, AccountDescription, AccountType (IC_Receivable / IC_Payable), Currency, Amount" sample={SAMPLE_TB_CSV} sampleName="sample-trial-balance.csv" onFile={handleTBUpload} />
                <button onClick={loadSampleAll} style={{ background: "rgba(56,189,248,0.1)", border: "1px solid rgba(56,189,248,0.25)", borderRadius: 8, color: "#38bdf8", fontSize: 12, padding: "8px 16px", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>▶ Load sample data instead</button>
              </div>
            ) : (
              <>
                <div style={{ padding: "24px 16px", borderRight: "1px solid rgba(255,255,255,0.05)", overflowY: "auto" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                    <h3 style={{ fontSize: 12, fontWeight: 700, color: "#64748b", letterSpacing: "0.1em" }}>IC PAIRS</h3>
                    <button onClick={() => setTbRows([])} style={{ background: "transparent", border: "none", color: "#475569", fontSize: 10, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}><Upload size={10} /> Replace</button>
                  </div>
                  {icPairs.map(pair => (
                    <div key={pair.id} className="ic-row" onClick={() => setSelectedPair(pair)}
                      style={{ padding: "10px 12px", borderRadius: 8, cursor: "pointer", marginBottom: 6, transition: "all 0.12s", background: selectedPair?.id === pair.id ? "rgba(56,189,248,0.1)" : "rgba(255,255,255,0.02)", border: `1px solid ${selectedPair?.id === pair.id ? "rgba(56,189,248,0.3)" : "rgba(255,255,255,0.05)"}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0" }}>{pair.from} → {pair.to}</span>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: pair.reconciled ? "#34d399" : "#ef4444", display: "inline-block", flexShrink: 0, marginTop: 3 }} />
                      </div>
                      <div style={{ fontSize: 10, color: "#475569" }}>{pair.type} · {fmt(pair.senderAmt)}</div>
                      {!pair.reconciled && <div style={{ fontSize: 10, color: "#ef4444", marginTop: 2 }}>Gap: {fmt(pair.gap)}{pair.missing ? " (MISSING)" : pair.orphanPayable ? " (ORPHAN)" : ""}</div>}
                    </div>
                  ))}
                  <div style={{ marginTop: 16, padding: "12px", background: "rgba(0,0,0,0.2)", borderRadius: 10 }}>
                    <div style={{ fontSize: 10, color: "#475569", marginBottom: 8 }}>SUMMARY</div>
                    {[
                      { label: "Reconciled", count: icPairs.filter(p => p.reconciled).length, color: "#34d399" },
                      { label: "Gaps", count: icPairs.filter(p => !p.reconciled && !p.missing && !p.orphanPayable).length, color: "#f59e0b" },
                      { label: "Missing", count: icPairs.filter(p => p.missing).length, color: "#ef4444" },
                      { label: "Orphan", count: icPairs.filter(p => p.orphanPayable).length, color: "#a78bfa" },
                    ].map(s => (
                      <div key={s.label} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
                        <span style={{ color: "#64748b" }}>{s.label}</span>
                        <span style={{ color: s.color, fontWeight: 700, fontFamily: "monospace" }}>{s.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ padding: "24px 28px", overflowY: "auto" }}>
                  <h2 style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 4 }}>Reconciliation Root Cause Graph</h2>
                  <p style={{ fontSize: 12, color: "#475569", marginBottom: 20 }}>Select an IC pair to visualise the mismatch and get AI-recommended fixes</p>
                  {selectedPair ? <ReconGraph pair={selectedPair} /> : <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "60%", color: "#334155", fontSize: 13 }}>← Select an IC pair to analyse</div>}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── RISK ── */}
        {tab === "risk" && (
          <div className="fade-in" style={{ padding: "28px", overflowY: "auto", height: "calc(100vh - 65px)" }}>
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 4 }}>Risk</h2>
              <p style={{ fontSize: 12, color: "#475569" }}>Entity risk scored on IC mismatches, FX exposure, IC complexity, and hierarchy churn</p>
            </div>
            {!riskScores.length ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "60%", gap: 16 }}>
                <p style={{ color: "#475569", fontSize: 14 }}>Upload hierarchy and GL trial balance data to compute risk scores</p>
                <button onClick={loadSampleAll} style={{ background: "rgba(56,189,248,0.1)", border: "1px solid rgba(56,189,248,0.25)", borderRadius: 8, color: "#38bdf8", fontSize: 12, padding: "8px 16px", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>▶ Load sample data</button>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16, alignItems: "start" }}>
                {riskScores.map(entity => (
                  <div key={entity.id} style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderTop: `3px solid ${riskColor(entity.score)}`, borderRadius: 12, padding: "18px 20px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", marginBottom: 2 }}>{entity.entity}</div>
                        <div style={{ fontSize: 10, color: "#475569", fontFamily: "monospace" }}>{entity.id}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 28, fontWeight: 800, color: riskColor(entity.score), lineHeight: 1, fontFamily: "JetBrains Mono, monospace" }}>{entity.score}</div>
                        <div style={{ fontSize: 9, fontWeight: 700, color: riskColor(entity.score), letterSpacing: "0.08em" }}>{riskLabel(entity.score)}</div>
                      </div>
                    </div>
                    <div style={{ height: 4, background: "rgba(255,255,255,0.05)", borderRadius: 2, marginBottom: 12 }}>
                      <div style={{ height: "100%", width: `${entity.score}%`, background: riskColor(entity.score), borderRadius: 2, transition: "width 0.6s ease" }} />
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                      {[
                        { label: "IC Mismatches", value: entity.icMismatches },
                        { label: "FX Risk",        value: `${entity.fxRisk}/5` },
                        { label: "IC Complexity",  value: `${entity.icComplexity}/5` },
                        { label: "Churn",          value: `${entity.churn}x` },
                      ].map(m => (
                        <div key={m.label} style={{ background: "rgba(255,255,255,0.02)", borderRadius: 6, padding: "6px 8px" }}>
                          <div style={{ fontSize: 9, color: "#475569", marginBottom: 2 }}>{m.label}</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#94a3b8", fontFamily: "monospace" }}>{m.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                {/* Radar for top entity */}
                {topRisk && (
                  <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "20px", gridColumn: "span 1" }}>
                    <h3 style={{ fontSize: 12, fontWeight: 700, color: "#64748b", letterSpacing: "0.08em", marginBottom: 4 }}>RISK PROFILE</h3>
                    <p style={{ fontSize: 11, color: "#334155", marginBottom: 16 }}>{topRisk.entity}</p>
                    <ResponsiveContainer width="100%" height={200}>
                      <RadarChart data={[
                        { subject: "IC Mismatches", A: Math.min(100, topRisk.icMismatches * 25) },
                        { subject: "FX Risk",       A: topRisk.fxRisk * 20 },
                        { subject: "IC Complexity", A: topRisk.icComplexity * 20 },
                        { subject: "Churn",         A: Math.min(100, topRisk.churn * 30) },
                      ]}>
                        <PolarGrid stroke="rgba(255,255,255,0.06)" />
                        <PolarAngleAxis dataKey="subject" tick={{ fontSize: 10, fill: "#475569" }} />
                        <Radar dataKey="A" stroke={riskColor(topRisk.score)} fill={riskColor(topRisk.score)} fillOpacity={0.15} strokeWidth={2} />
                      </RadarChart>
                    </ResponsiveContainer>
                    <div style={{ marginTop: 12, padding: "10px 12px", background: `${riskColor(topRisk.score)}12`, borderRadius: 8, border: `1px solid ${riskColor(topRisk.score)}30` }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: riskColor(topRisk.score), marginBottom: 4 }}>{riskLabel(topRisk.score).toUpperCase()} — {topRisk.entity}</div>
                      <p style={{ fontSize: 11, color: "#64748b", lineHeight: 1.55 }}>
                        {topRisk.icMismatches > 0 && `${topRisk.icMismatches} unreconciled IC pairs. `}
                        {topRisk.churn > 0 && `${topRisk.churn} missing/orphan IC entries. `}
                        {topRisk.fxRisk > 2 && `High FX exposure across ${topRisk.fxRisk} currency pairs. `}
                        Prioritise for review.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── CHAT ── */}
        {tab === "chat" && (
          <div className="fade-in" style={{ display: "grid", gridTemplateColumns: "260px 1fr", height: "calc(100vh - 65px)" }}>
            <div style={{ padding: "24px 16px", borderRight: "1px solid rgba(255,255,255,0.05)", overflowY: "auto", background: "rgba(0,0,0,0.15)" }}>
              <h3 style={{ fontSize: 12, fontWeight: 700, color: "#64748b", letterSpacing: "0.1em", marginBottom: 14 }}>AI CONTEXT</h3>
              {[
                { label: "Hierarchy",  value: entities.length ? `${entities.length} entities loaded` : "Not uploaded", icon: "⬡", ok: entities.length > 0 },
                { label: "IC Pairs",   value: icPairs.length ? `${icPairs.length} pairs, ${reconGap} gaps` : "Not uploaded", icon: "⊕", ok: icPairs.length > 0 && reconGap === 0 },
                { label: "Risk",       value: riskScores.length ? `${riskScores.length} entities scored` : "No data", icon: "◈", ok: riskScores.length > 0 },
                { label: "Issues",     value: issues.length ? `${issues.length} detected` : "None found", icon: "⚠", ok: issues.length === 0 },
              ].map(item => (
                <div key={item.label} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 10px", borderRadius: 8, marginBottom: 6, background: "rgba(255,255,255,0.02)" }}>
                  <span style={{ fontSize: 13, color: "#38bdf8" }}>{item.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8" }}>{item.label}</div>
                    <div style={{ fontSize: 10, color: "#475569" }}>{item.value}</div>
                  </div>
                  <span style={{ fontSize: 14, color: item.ok ? "#34d399" : "#f59e0b" }}>{item.ok ? "✓" : "⚠"}</span>
                </div>
              ))}
              {!entities.length && (
                <div style={{ marginTop: 16, padding: "12px", background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 10 }}>
                  <p style={{ fontSize: 11, color: "#92400e", lineHeight: 1.6, marginBottom: 10 }}>Upload CSVs in the Hierarchy and Reconciliation tabs to give Strata AI full context.</p>
                  <button onClick={loadSampleAll} style={{ width: "100%", background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: 6, color: "#f59e0b", fontSize: 11, padding: "6px", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>Load sample data</button>
                </div>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <div style={{ padding: "16px 24px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#34d399", animation: "pulse 2s infinite" }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>Strata AI Assistant</span>
                  <span style={{ fontSize: 11, color: "#475569" }}>Powered by Claude · Your EPM data in context</span>
                </div>
              </div>
              <Chatbot entities={entities} icPairs={icPairs} issues={issues} riskScores={riskScores} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
