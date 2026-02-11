const KEY = "hdj_glp1_tracker_v3";
const el = (id) => document.getElementById(id);

const state = loadState();
ensureDefaultPatient();
initDateToday();
refreshPatientsUI();
wireUI();
renderAll();

function loadState(){
  const raw = localStorage.getItem(KEY);
  if(raw) return JSON.parse(raw);
  return { activePatientId: null, patients: [] };
}
function saveState(){ localStorage.setItem(KEY, JSON.stringify(state)); }
function rid(){ return (crypto?.randomUUID?.() || ("id-" + Math.random().toString(16).slice(2) + Date.now())); }

function ensureDefaultPatient(){
  if(state.patients.length === 0){
    const id = rid();
    state.patients.push({ id, name:"PAT-001", visits:[] });
    state.activePatientId = id;
    saveState();
  }
  if(!state.activePatientId) state.activePatientId = state.patients[0].id;
}
function activePatient(){
  return state.patients.find(p => p.id === state.activePatientId) || state.patients[0];
}

function initDateToday(){
  const d = new Date();
  const iso = new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10);
  el("date").value = iso;
}

/* =========================
   UTIL
========================= */
function fmt(n){
  if(typeof n !== "number" || Number.isNaN(n)) return "";
  return (Math.round(n*10)/10).toString().replace(".", ",");
}
function sign(n){ return n>0 ? "+" : ""; }
function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function pill(label, value){
  return `<span class="pill"><span class="muted">${escapeHtml(label)}:</span> <b>${escapeHtml(value)}</b></span>`;
}
function tagHtml(text, cls){
  return `<span class="tag ${cls}">${escapeHtml(text)}</span>`;
}

/* =========================
   CALENDRIER INJECTION
========================= */
function nextInjectionDate(targetDow){ // 0=dim ... 6=sam
  const now = new Date();
  const day = now.getDay();
  let delta = (targetDow - day + 7) % 7;
  if (delta === 0) delta = 7; // prochain créneau = semaine suivante
  const d = new Date(now);
  d.setDate(now.getDate() + delta);
  return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10);
}

/* =========================
   TITRATION (les 2)
========================= */
const LADDERS = {
  Semaglutide: ["0,25 mg","0,5 mg","1 mg","1,7 mg","2,4 mg"],
  Tirzepatide: ["2,5 mg","5 mg","7,5 mg","10 mg","12,5 mg","15 mg"]
};

function normalizeDose(str){
  return String(str||"").trim().toLowerCase().replace(/\s+/g,"");
}
function pickDrugKey(drug){
  // map simple
  const d = (drug||"").toLowerCase();
  if (d.includes("tir")) return "Tirzepatide";
  if (d.includes("sema")) return "Semaglutide";
  return null;
}

function titrationAdvice(lastVisit){
  if(!lastVisit) return { ok:false, msg:"Aucune visite : impossible de proposer une titration." };

  const drugKey = pickDrugKey(lastVisit.drug);
  if(!drugKey) return { ok:false, msg:"Médicament non reconnu (choisir Semaglutide ou Tirzepatide)." };

  const ladder = LADDERS[drugKey];
  const curDoseRaw = lastVisit.dose || "";
  const curNorm = normalizeDose(curDoseRaw);

  // règles de blocage (HDJ prudence)
  const danger = lastVisit.redFlags?.level === "danger";
  const giScore = lastVisit.gi?.giScore ?? 0;
  const vomit = lastVisit.gi?.vomitCount ?? 0;
  const injMiss = lastVisit.injDone === "no";

  if(danger){
    return { ok:false, msg:"ALERTE : titration déconseillée (danger). Prioriser prise en charge EI / hydratation / bilan si besoin." };
  }
  if(vomit >= 3 || giScore >= 18){
    return { ok:false, msg:`EI digestifs significatifs (V=${vomit}/7j, score GI=${giScore}). Recommandation : maintenir dose ou réduire / adapter, pas d’augmentation.` };
  }
  if(injMiss){
    return { ok:false, msg:"Injection non faite cette semaine : stabiliser l’observance avant d’envisager une augmentation." };
  }

  // trouver index dose actuelle
  const idx = ladder.findIndex(d => normalizeDose(d) === curNorm);
  if(idx === -1){
    return {
      ok:false,
      msg:`Dose actuelle non reconnue (“${curDoseRaw}”). Doses attendues ${drugKey}: ${ladder.join(" → ")}`
    };
  }

  if(idx === ladder.length - 1){
    return { ok:true, msg:`${drugKey} : dose déjà au palier maximal (${ladder[idx]}).` };
  }

  const next = ladder[idx+1];
  return {
    ok:true,
    msg:`Proposition titration (${drugKey}) : ${ladder[idx]} → ${next} (si tolérance maintenue et pas d’alerte).`
  };
}

/* =========================
   RED FLAGS
========================= */
function computeRedFlags(x){
  const flags = [];
  if(x.vomitCount >= 3) flags.push("Vomissements répétés (≥3/7j)");
  const dehydration = (x.lowFluids && x.lowUrine) || (x.lowUrine && x.dizzy) || (x.lowFluids && x.dizzy);
  if(dehydration) flags.push("Signes de déshydratation (apports bas + diurèse/vertiges)");
  if(x.riskMeds && (x.vomitCount >= 1 || dehydration)) flags.push("Contexte à risque (AINS/diurétiques + EI)");
  if(x.creat !== null && x.creatBase !== null){
    const ratio = x.creat / Math.max(x.creatBase, 1);
    if(ratio >= 1.3) flags.push("Créatinine ↑ (≥30% vs habituelle)");
  }
  if(x.abdoPain >= 7) flags.push("Douleur abdominale importante (≥7/10)");

  let level = "ok";
  if(flags.length) level = "warn";
  if(flags.some(f => f.includes("Créatinine") || f.includes("déshydratation") || f.includes("Douleur")) || x.vomitCount >= 5) level = "danger";
  return { level, flags };
}

function updateAlertPreview(){
  const preview = computeRedFlags({
    vomitCount: +el("vomitCount").value,
    lowFluids: el("lowFluids").value === "yes",
    lowUrine: el("lowUrine").value === "yes",
    dizzy: el("dizzy").value === "yes",
    riskMeds: el("riskMeds").value === "yes",
    creat: el("creat").value ? +el("creat").value : null,
    creatBase: el("creatBase").value ? +el("creatBase").value : null,
    abdoPain: +el("abdoPain").value
  });

  const box = el("alertBox");
  if(!preview.flags.length){
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  const title = preview.level === "danger" ? "ALERTE — à recontacter rapidement" : "Vigilance";
  const advice = preview.level === "danger"
    ? "Hydratation / bilan clinique et rénal à discuter. Si impossibilité de s’hydrater, malaise, douleur abdo majeure → avis urgent."
    : "Surveillance rapprochée + conseils hydratation / adaptation si besoin.";

  box.classList.remove("hidden");
  box.innerHTML =
    `<b>${escapeHtml(title)}</b>
     <div style="margin-top:6px">• ${preview.flags.map(escapeHtml).join("<br>• ")}</div>
     <div style="margin-top:8px;opacity:.9">${escapeHtml(advice)}</div>`;
}

/* =========================
   UI WIRING
========================= */
function wireUI(){
  const bindRange = (id, labelId) => {
    const r = el(id), lab = el(labelId);
    const upd = () => lab.textContent = `${r.value}/10`;
    r.addEventListener("input", upd); upd();
  };
  bindRange("nausea","nauseaLabel");
  bindRange("diarrhea","diarrheaLabel");
  bindRange("constipation","constipationLabel");
  bindRange("reflux","refluxLabel");
  bindRange("abdoPain","abdoPainLabel");

  ["vomitCount","lowFluids","lowUrine","dizzy","riskMeds","creat","creatBase","abdoPain"].forEach(id=>{
    el(id).addEventListener("input", updateAlertPreview);
    el(id).addEventListener("change", updateAlertPreview);
  });

  el("visitForm").addEventListener("submit", onSubmitVisit);

  el("resetBtn").addEventListener("click", () => {
    el("visitForm").reset();
    initDateToday();
    ["nausea","diarrhea","constipation","reflux","abdoPain"].forEach(id => el(id).dispatchEvent(new Event("input")));
    el("alertBox").classList.add("hidden");
    el("alertBox").innerHTML = "";
    el("weeklyHint").textContent = "";
    updateAlertPreview();
  });

  el("filter").addEventListener("input", renderAll);

  el("exportBtn").addEventListener("click", () => {
    const p = activePatient();
    downloadText(`${p.name}-hdj-glp1.csv`, toCSV(visitsToRows(p)));
  });

  el("clearBtn").addEventListener("click", () => {
    const p = activePatient();
    if(!confirm(`Effacer toutes les données du patient ${p.name} ?`)) return;
    p.visits = [];
    saveState();
    renderAll();
  });

  // Patients dialog
  el("managePatientsBtn").addEventListener("click", () => {
    refreshPatientsUI();
    el("patientDialog").showModal();
  });
  el("closeDialog").addEventListener("click", () => el("patientDialog").close());

  el("addPatientBtn").addEventListener("click", () => {
    const name = el("newPatientName").value.trim();
    if(!name) return;
    const id = rid();
    state.patients.push({ id, name, visits: [] });
    state.activePatientId = id;
    el("newPatientName").value = "";
    saveState();
    refreshPatientsUI();
    renderAll();
  });

  el("setActiveBtn").addEventListener("click", () => {
    state.activePatientId = el("patientSelect").value;
    saveState();
    el("patientDialog").close();
    renderAll();
  });

  el("deletePatientBtn").addEventListener("click", () => {
    const id = el("patientSelect").value;
    const p = state.patients.find(x => x.id === id);
    if(!p) return;
    if(!confirm(`Supprimer ${p.name} et toutes ses données ?`)) return;
    state.patients = state.patients.filter(x => x.id !== id);
    state.activePatientId = state.patients.length ? state.patients[0].id : null;
    ensureDefaultPatient();
    saveState();
    refreshPatientsUI();
    renderAll();
  });

  // QR
  if (el("qrBtn")) {
    el("qrBtn").addEventListener("click", openQr);
    el("closeQrDialog").addEventListener("click", () => el("qrDialog").close());
    el("regenQrBtn").addEventListener("click", () => renderQr(el("qrLink").value.trim()));
    el("copyLinkBtn").addEventListener("click", async () => {
      const link = el("qrLink").value.trim();
      await navigator.clipboard.writeText(link);
      alert("Lien copié ✅");
    });
  }

  // Print A4
  if (el("printBtn")) {
    el("printBtn").addEventListener("click", printA4);
  }

  // Titration
  if (el("titrationBtn")) {
    el("titrationBtn").addEventListener("click", () => {
      const p = activePatient();
      const last = (p.visits || [])[0] || null;
      const adv = titrationAdvice(last);
      alert(adv.msg);
    });
  }

  updateAlertPreview();
}

function refreshPatientsUI(){
  const sel = el("patientSelect");
  sel.innerHTML = "";
  state.patients.forEach(p=>{
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  sel.value = state.activePatientId;
}

/* =========================
   FORM SUBMIT
========================= */
function onSubmitVisit(e){
  e.preventDefault();
  const p = activePatient();
  const visit = collectVisit();
  el("weeklyHint").textContent = weeklyConsistencyHint(p, visit.date) || "";
  p.visits.unshift(visit);
  saveState();
  renderAll();

  el("visitForm").reset();
  initDateToday();
  ["nausea","diarrhea","constipation","reflux","abdoPain"].forEach(id => el(id).dispatchEvent(new Event("input")));
  updateAlertPreview();
}

function weeklyConsistencyHint(p, date){
  const d = new Date(date + "T00:00:00");
  const recent = (p.visits || []).find(v => {
    const dv = new Date(v.date + "T00:00:00");
    const diffDays = Math.abs((d - dv) / (1000*60*60*24));
    return diffDays < 7;
  });
  return recent ? `Note : une visite existe déjà à moins de 7 jours (${recent.date}).` : "";
}

function collectVisit(){
  const date = el("date").value;

  const nausea = +el("nausea").value;
  const vomitCount = +el("vomitCount").value;
  const diarrhea = +el("diarrhea").value;
  const constipation = +el("constipation").value;
  const reflux = +el("reflux").value;
  const abdoPain = +el("abdoPain").value;

  const lowFluids = el("lowFluids").value === "yes";
  const lowUrine  = el("lowUrine").value === "yes";
  const dizzy     = el("dizzy").value === "yes";
  const riskMeds  = el("riskMeds").value === "yes";

  const creat = el("creat").value ? +el("creat").value : null;
  const creatBase = el("creatBase").value ? +el("creatBase").value : null;

  const redFlags = computeRedFlags({ vomitCount, lowFluids, lowUrine, dizzy, riskMeds, creat, creatBase, abdoPain });
  const giScore = nausea + diarrhea + constipation + reflux + abdoPain + Math.min(vomitCount, 10);

  return {
    id: rid(),
    date,
    drug: el("drug").value,
    dose: el("dose").value.trim(),
    injDay: +el("injDay").value,
    injDone: el("injDone").value,
    injMissReason: el("injMissReason").value.trim(),
    weight: +el("weight").value,
    waist: el("waist").value ? +el("waist").value : null,
    gi: { nausea, vomitCount, diarrhea, constipation, reflux, abdoPain, giScore },
    hydration: { lowFluids, lowUrine, dizzy, riskMeds },
    labs: { creat, creatBase },
    compliance: { proteinOK: el("proteinOK").value, activityMin: el("activityMin").value ? +el("activityMin").value : 0 },
    goals: { targetWeight: el("targetWeight").value ? +el("targetWeight").value : null, goalText: el("goalText").value.trim() },
    redFlags,
    notes: el("notes").value.trim()
  };
}

/* =========================
   RENDER
========================= */
function renderAll(){
  const p = activePatient();
  el("activePatientName").textContent = p?.name || "—";

  const filter = el("filter").value.trim().toLowerCase();
  const visits = (p.visits || []).filter(v => !filter || JSON.stringify(v).toLowerCase().includes(filter));
  el("count").textContent = visits.length;

  renderKPIs(p);
  renderTable(visits);
  renderChart(p);
}

function renderKPIs(p){
  const visits = p.visits || [];
  const last = visits[0] || null;

  // weight trend
  const wChrono = visits.slice().sort((a,b)=>a.date.localeCompare(b.date));
  let delta=null, sinceStart=null;
  if(wChrono.length>=2){
    delta = wChrono[wChrono.length-1].weight - wChrono[wChrono.length-2].weight;
    sinceStart = wChrono[wChrono.length-1].weight - wChrono[0].weight;
  }

  const lastAlert = last?.redFlags?.level || "ok";
  const tag = lastAlert==="ok" ? tagHtml("OK","t-ok") : lastAlert==="warn" ? tagHtml("Vigilance","t-warn") : tagHtml("Alerte","t-danger");

  const injDay = last ? last.injDay : 1;
  const nextInj = nextInjectionDate(injDay);

  // titration preview
  const tit = titrationAdvice(last);

  el("kpis").innerHTML = [
    pill("Dernière visite", last ? `${last.date}` : "—"),
    pill("Dernier poids", last ? `${fmt(last.weight)} kg` : "—"),
    pill("Δ dernière semaine", delta===null ? "—" : `${sign(delta)}${fmt(delta)} kg`),
    pill("Δ depuis début", sinceStart===null ? "—" : `${sign(sinceStart)}${fmt(sinceStart)} kg`),
    pill("Prochaine injection", nextInj),
    `<span class="pill"><span class="muted">Statut :</span> ${tag}</span>`,
    pill("Titration", tit.ok ? "OK" : "Blocage / à vérifier")
  ].join("");
}

function renderTable(visits){
  const tbody = el("table").querySelector("tbody");
  tbody.innerHTML = "";

  visits.forEach(v=>{
    const tr = document.createElement("tr");

    const inj = v.injDone === "yes"
      ? `${escapeHtml(v.drug)} ${escapeHtml(v.dose || "")} <div class="mini">faite</div>`
      : `${escapeHtml(v.drug)} ${escapeHtml(v.dose || "")} <div class="mini warn">manquée: ${escapeHtml(v.injMissReason || "—")}</div>`;

    const gi = `Score: <b>${v.gi.giScore}</b><div class="mini">N ${v.gi.nausea}/10 · V ${v.gi.vomitCount}/7j · D ${v.gi.diarrhea}/10 · C ${v.gi.constipation}/10</div>`;

    const rf = v.redFlags.flags.length
      ? `${tagHtml(v.redFlags.level==="danger"?"Alerte":"Vigilance", v.redFlags.level==="danger"?"t-danger":"t-warn")}<div class="mini">${escapeHtml(v.redFlags.flags.join(" • "))}</div>`
      : `${tagHtml("OK","t-ok")}`;

    tr.innerHTML = `
      <td>${escapeHtml(v.date)}</td>
      <td>${inj}</td>
      <td><b>${fmt(v.weight)} kg</b>${v.waist ? `<div class="mini">Taille ${fmt(v.waist)} cm</div>` : ""}</td>
      <td>${gi}</td>
      <td>${rf}</td>
      <td style="width:86px"><button class="btn danger" data-del="${v.id}" type="button">Suppr.</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("button[data-del]").forEach(btn=>{
    btn.addEventListener("click", () => {
      const p = activePatient();
      p.visits = p.visits.filter(x => x.id !== btn.dataset.del);
      saveState();
      renderAll();
    });
  });
}

function renderChart(p){
  const canvas = el("chart");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0,0,canvas.width,canvas.height);

  const visits = (p.visits || []).slice().sort((a,b)=>a.date.localeCompare(b.date));
  if(visits.length < 2){
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "16px system-ui";
    ctx.fillText("Ajoute ≥2 visites avec poids pour afficher la courbe.", 18, canvas.height/2);
    return;
  }

  const weights = visits.map(v => v.weight);
  const minW = Math.min(...weights), maxW = Math.max(...weights);
  const W = canvas.width, H = canvas.height;

  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.strokeRect(12,12,W-24,H-24);

  const pad = 22;
  const x0 = 12+pad, x1 = W-12-pad, y0 = 12+pad, y1 = H-12-pad;

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  for(let i=0;i<=4;i++){
    const y = y0 + i*(y1-y0)/4;
    ctx.beginPath(); ctx.moveTo(x0,y); ctx.lineTo(x1,y); ctx.stroke();
  }

  const denom = (maxW - minW) || 1;
  const pts = visits.map((v,i)=>{
    const x = x0 + i*(x1-x0)/(visits.length-1);
    const y = y1 - ((v.weight - minW) * (y1-y0)/denom);
    return {x,y,w:v.weight,date:v.date};
  });

  ctx.strokeStyle = "rgba(94,234,212,0.9)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  pts.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));
  ctx.stroke();

  ctx.fillStyle = "rgba(94,234,212,0.95)";
  pts.forEach(p=>{ ctx.beginPath(); ctx.arc(p.x,p.y,3.5,0,Math.PI*2); ctx.fill(); });

  const last = pts[pts.length-1];
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "12px system-ui";
  ctx.fillText(`${last.date} · ${fmt(last.w)} kg`, Math.max(18,last.x-55), Math.max(22,last.y-10));

  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fillText(`${fmt(maxW)} kg`, 18, y0+4);
  ctx.fillText(`${fmt(minW)} kg`, 18, y1);
}

/* =========================
   CSV
========================= */
function visitsToRows(p){
  const rows = [];
  rows.push({
    patient:p.name,date:"",drug:"",dose:"",injDay:"",injDone:"",injMissReason:"",
    weight:"",waist:"",nausea:"",vomitCount:"",diarrhea:"",constipation:"",reflux:"",abdoPain:"",
    giScore:"",lowFluids:"",lowUrine:"",dizzy:"",riskMeds:"",creat:"",creatBase:"",
    alertLevel:"",alertFlags:"",proteinOK:"",activityMin:"",targetWeight:"",goalText:"",notes:""
  });

  (p.visits||[]).slice().reverse().forEach(v=>{
    rows.push({
      patient:p.name,date:v.date,drug:v.drug,dose:v.dose,injDay:v.injDay,injDone:v.injDone,injMissReason:v.injMissReason,
      weight:v.weight,waist:(v.waist??""),nausea:v.gi.nausea,vomitCount:v.gi.vomitCount,diarrhea:v.gi.diarrhea,
      constipation:v.gi.constipation,reflux:v.gi.reflux,abdoPain:v.gi.abdoPain,giScore:v.gi.giScore,
      lowFluids:v.hydration.lowFluids?"yes":"no",lowUrine:v.hydration.lowUrine?"yes":"no",dizzy:v.hydration.dizzy?"yes":"no",
      riskMeds:v.hydration.riskMeds?"yes":"no",creat:(v.labs.creat??""),creatBase:(v.labs.creatBase??""),
      alertLevel:v.redFlags.level,alertFlags:v.redFlags.flags.join(" | "),
      proteinOK:v.compliance.proteinOK,activityMin:v.compliance.activityMin,targetWeight:(v.goals.targetWeight??""),
      goalText:v.goals.goalText,notes:v.notes
    });
  });
  return rows;
}
function toCSV(rows){
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replaceAll('"','""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  rows.slice(1).forEach(r => lines.push(headers.map(h => esc(r[h])).join(",")));
  return lines.join("\n");
}
function downloadText(filename, text){
  const blob = new Blob([text], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* =========================
   QR
========================= */
function fullPageUrlGuess(){
  const u = window.location.href;
  if(u.includes("/full/")) return u;
  if(u.includes("/pen/")) return u.replace("/pen/","/full/");
  return u;
}
function renderQr(link){
  const box = el("qrBox");
  box.innerHTML = "";
  // QRCode lib must be loaded via CodePen Settings (you already added it)
  new QRCode(box, { text: link, width: 220, height: 220 });
}
function openQr(){
  const link = fullPageUrlGuess();
  el("qrLink").value = link;
  renderQr(link);
  el("qrDialog").showModal();
}

/* =========================
   PRINT A4
========================= */
function printA4(){
  const p = activePatient();
  const last = (p.visits || [])[0] || null;
  if(!last){ alert("Aucune visite à imprimer."); return; }

  // Weight delta
  const chrono = (p.visits||[]).slice().sort((a,b)=>a.date.localeCompare(b.date));
  let sinceStart = null;
  if(chrono.length >= 2) sinceStart = chrono[chrono.length-1].weight - chrono[0].weight;

  const tit = titrationAdvice(last);

  const html = `
  <html><head><meta charset="utf-8"/>
  <title>Fiche patient ${escapeHtml(p.name)}</title>
  <style>
    body{ font-family: system-ui, Arial; margin: 24px; }
    h1{ font-size:18px; margin:0 0 8px; }
    h2{ font-size:14px; margin:18px 0 8px; }
    .muted{ color:#555; font-size:12px; }
    .grid{ display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
    .box{ border:1px solid #ddd; border-radius:10px; padding:10px; }
    ul{ margin:8px 0 0 18px; }
    .tag{ display:inline-block; padding:2px 8px; border-radius:999px; border:1px solid #ddd; font-size:12px; }
  </style></head><body>
    <h1>HDJ Obésité — Suivi GLP-1</h1>
    <div class="muted">Patient : <b>${escapeHtml(p.name)}</b> — Date : ${escapeHtml(last.date)}</div>

    <div class="grid" style="margin-top:12px;">
      <div class="box">
        <h2>Injection</h2>
        <div>${escapeHtml(last.drug)} — ${escapeHtml(last.dose || "—")}</div>
        <div class="muted">Jour cible : ${last.injDay} — Prochaine injection : ${escapeHtml(nextInjectionDate(last.injDay))}</div>
        <div class="muted">Observance : ${last.injDone === "yes" ? "faite" : "manquée ("+escapeHtml(last.injMissReason||"—")+")"}</div>
      </div>

      <div class="box">
        <h2>Anthropométrie</h2>
        <div>Poids : <b>${fmt(last.weight)} kg</b> ${sinceStart===null ? "" : `(Δ depuis début: ${sign(sinceStart)}${fmt(sinceStart)} kg)`}</div>
        <div class="muted">Tour de taille : ${last.waist ? fmt(last.waist)+" cm" : "—"}</div>
      </div>

      <div class="box">
        <h2>EI digestifs</h2>
        <div class="muted">Score GI : ${last.gi.giScore}</div>
        <ul>
          <li>Nausées: ${last.gi.nausea}/10</li>
          <li>Vomissements: ${last.gi.vomitCount}/7j</li>
          <li>Diarrhée: ${last.gi.diarrhea}/10</li>
          <li>Constipation: ${last.gi.constipation}/10</li>
          <li>RGO: ${last.gi.reflux}/10</li>
          <li>Douleur abdo: ${last.gi.abdoPain}/10</li>
        </ul>
      </div>

      <div class="box">
        <h2>Alertes / IRA</h2>
        <div><span class="tag">${escapeHtml(last.redFlags.level.toUpperCase())}</span></div>
        ${last.redFlags.flags.length ? `<ul>${last.redFlags.flags.map(f=>`<li>${escapeHtml(f)}</li>`).join("")}</ul>` : `<div class="muted">Aucune alerte</div>`}
        <div class="muted">Créatinine: ${last.labs.creat ?? "—"} (base ${last.labs.creatBase ?? "—"})</div>
      </div>
    </div>

    <div class="box" style="margin-top:12px;">
      <h2>Compliance & objectifs</h2>
      <div>Protéines : ${escapeHtml(last.compliance.proteinOK)}</div>
      <div>Activité : ${escapeHtml(String(last.compliance.activityMin))} min/sem</div>
      <div>Objectif poids : ${last.goals.targetWeight ? fmt(last.goals.targetWeight)+" kg" : "—"}</div>
      <div>Objectif : ${escapeHtml(last.goals.goalText || "—")}</div>
      <div class="muted" style="margin-top:8px;">Titration : ${escapeHtml(tit.msg)}</div>
    </div>

    <div class="box" style="margin-top:12px;">
      <h2>Notes</h2>
      <div>${escapeHtml(last.notes || "—")}</div>
    </div>

    <script>window.print();</script>
  </body></html>`;

  const w = window.open("", "_blank");
  w.document.open();
  w.document.write(html);
  w.document.close();
}