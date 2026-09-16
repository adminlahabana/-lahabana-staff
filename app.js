/* =====================================================================
   La Habana Staff — app
   Talks to Supabase. Every rule that matters (who sees what, where you
   can clock in from, what time it is) is enforced by the database.
   ===================================================================== */
"use strict";
 
const sb = supabase.createClient(window.LH.SUPABASE_URL, window.LH.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});
const TZ = "Indian/Maldives";
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const screenEl = () => $("screen");
 
/* ---------- small helpers ------------------------------------------- */
const fmtTime = d => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true })
  .format(new Date(d)).replace(/\s*(am|pm)/i, (m, p) => " " + p.toUpperCase());
const fmtDay = d => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).format(new Date(d));
const fmtDayTime = d => fmtDay(d) + ", " + fmtTime(d);
const todayISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const initials = n => (n || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
const hours = mins => Math.floor(mins / 60) + "h " + String(Math.round(mins % 60)).padStart(2, "0") + "m";
function mondayOf(iso) {
  const d = new Date(iso + "T12:00:00Z"); const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10);
}
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayLabel = iso => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric" }).format(new Date(iso + "T12:00:00Z"));
function shiftMinutes(st, en, brk) {
  if (!st || !en) return 0;
  const [h1, m1] = st.split(":").map(Number), [h2, m2] = en.split(":").map(Number);
  let mins = (h2 * 60 + m2) - (h1 * 60 + m1); if (mins <= 0) mins += 1440;
  return Math.max(0, mins - (brk || 0));
}
function hhmm(t) {            // "17:00:00" -> "5:00 PM" (a plain clock time, no timezone)
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM", hr = h % 12 === 0 ? 12 : h % 12;
  return hr + ":" + String(m).padStart(2, "0") + " " + ampm;
}
 
/* ---------- state ---------------------------------------------------- */
const S = {
  me: null, people: [], settings: null, types: [],
  tab: "home", shiftsTab: "clock", reportTab: "incidents",
  day: todayISO(), week: mondayOf(todayISO()), chat: null,
  unread: 0, cache: {}, busy: false, pendingSite: null
};
const person = id => S.people.find(p => p.id === id) || { display_name: "Someone", full_name: "Someone" };
const isMgr = () => S.me && (S.me.role === "manager" || S.me.role === "owner");
const isOwner = () => S.me && S.me.role === "owner";
 
/* ---------- chrome: toast, sheet, spinner ---------------------------- */
let toastT;
function toast(text, bad) {
  const old = document.querySelector(".toast"); if (old) old.remove();
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : ""); el.textContent = text;
  el.setAttribute("role", "status"); $("layer").appendChild(el);
  clearTimeout(toastT); toastT = setTimeout(() => el.remove(), 4200);
}
function sheet(html) {
  closeSheet();
  const wrap = document.createElement("div");
  wrap.className = "sheet"; wrap.dataset.act = "closesheet";
  wrap.innerHTML = '<div class="inner" data-stop="1">' +
    '<div class="sheetbar"><span class="grab"></span>' +
    '<button class="sheetclose" data-act="closesheet" aria-label="Close">✕</button></div>' + html + "</div>";
  $("layer").appendChild(wrap);
}
const closeSheet = () => document.querySelectorAll(".sheet").forEach(s => s.remove());
const busy = on => { S.busy = on; document.querySelectorAll(".btn").forEach(b => b.disabled = on); };
const spinner = '<div class="center"><div class="spin"></div></div>';
 
/* ---------- start up -------------------------------------------------- */
(async function start() {
  if (!window.LH.SUPABASE_URL || window.LH.SUPABASE_URL.includes("PASTE")) {
    screenEl().innerHTML = '<div class="center"><h2 class="title">Almost there</h2>' +
      '<p class="mut">Open <b>config.js</b> and paste your Supabase project URL and anon key, then reload.</p></div>';
    return;
  }
  const params = new URLSearchParams(location.search);
  if (params.get("site")) { S.pendingSite = params.get("site"); history.replaceState({}, "", location.pathname); }
  const { data } = await sb.auth.getSession();
  if (data.session) await boot(); else renderSignIn();
  sb.auth.onAuthStateChange((e) => { if (e === "SIGNED_OUT") { S.me = null; renderSignIn(); } });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
 
async function boot() {
  try { await bootInner(); }
  catch (e) {
    $("tabbar").hidden = true;
    screenEl().innerHTML = '<div class="center" style="text-align:left"><h2 class="title">Can\'t reach the database</h2>' +
      '<div class="card stack"><p class="sm" style="margin:0">The app opened, but Supabase didn\'t answer. Nearly always one of these:</p>' +
      '<p class="sm" style="margin:0">• The two values in <b>config.js</b> don\'t match your project (Supabase → Project Settings → API).</p>' +
      '<p class="sm" style="margin:0">• The database script hasn\'t been run yet, so the tables don\'t exist.</p>' +
      '<p class="sm" style="margin:0">• The project is paused — open it in Supabase and press Restore.</p>' +
      '<p class="xs mono mut" style="margin:0;overflow-wrap:anywhere">' + esc(e && e.message ? e.message : e) + '</p></div>' +
      '<button class="btn" data-act="reload">Try again</button>' +
      '<button class="btn sec" data-act="signout">Sign out</button></div>';
  }
}
async function bootInner() {
  screenEl().innerHTML = spinner;
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return renderSignIn();
  const [{ data: prof }, { data: people }, { data: settings }, { data: types }] = await Promise.all([
    sb.from("profiles").select("*").eq("id", user.id).maybeSingle(),
    sb.from("profiles").select("*").order("display_name"),
    sb.from("settings").select("*").eq("id", 1).maybeSingle(),
    sb.from("shift_types").select("*").order("sort")
  ]);
  if (!prof) {
    screenEl().innerHTML = '<div class="center"><h2 class="title">Not set up yet</h2>' +
      '<p class="mut">Your account exists but has no staff profile. Ask the owner to add you.</p>' +
      '<button class="btn sec" data-act="signout">Sign out</button></div>';
    return;
  }
  if (!prof.active) {
    await sb.auth.signOut();
    screenEl().innerHTML = '<div class="center"><h2 class="title">Account switched off</h2><p class="mut">Ask the owner to switch it back on.</p></div>';
    return;
  }
  S.me = prof; S.people = (people || []).filter(p => p.active); S.settings = settings; S.types = types || [];
  if (!prof.display_name || !prof.full_name) return renderProfileSetup();
  $("tabbar").hidden = false;
  watchMessages();
  if (S.pendingSite) { S.tab = "shifts"; S.shiftsTab = "clock"; const code = S.pendingSite; S.pendingSite = null; render(); return punch(code, "tag"); }
  render();
}
 
/* ---------- sign in --------------------------------------------------- */
function renderSignIn() {
  $("tabbar").hidden = true;
  screenEl().innerHTML = `
    <form class="center" id="signin">
      <div style="text-align:center"><div class="wordmark" style="font-size:32px">La Habana<span>Staff</span></div></div>
      <label class="lbl" for="em">Work email</label>
      <input id="em" type="email" autocomplete="username" required inputmode="email"
             autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="you@lahabana.mv">
      <label class="lbl" for="pw">Password</label>
      <input id="pw" type="password" autocomplete="current-password" required>
      <button class="btn" type="submit">Sign in</button>
      <button class="btn sec" type="button" data-act="forgot">I forgot my password</button>
      <p class="xs mut" style="text-align:center;margin:0">Only staff accounts created by the owner can sign in.</p>
    </form>`;
  $("signin").addEventListener("submit", async e => {
    e.preventDefault(); busy(true);
    const { error } = await sb.auth.signInWithPassword({
      email: $("em").value.trim().toLowerCase(), password: $("pw").value
    });
    busy(false);
    if (error) return signInProblem(error);
    boot();
  });
}
function signInProblem(error) {
  var raw = (error && error.message) || "";
  var low = raw.toLowerCase();
  if (low.indexOf("not confirmed") > -1) {
    return sheet('<div style="font-weight:600;font-size:18px">This account isn\'t confirmed yet</div>' +
      '<p class="sm mut" style="margin:0">Supabase made the account but is still waiting for the email to be verified, so it won\'t let anyone in.</p>' +
      '<p class="sm" style="margin:0">Fix it once, in Supabase:</p>' +
      '<p class="sm mut" style="margin:0">1. <b>Authentication → Sign In / Providers → Email</b>: turn <b>Confirm email</b> OFF.</p>' +
      '<p class="sm mut" style="margin:0">2. <b>Authentication → Users</b>: open this person\'s row and confirm them, or delete and add them again with auto-confirm ticked.</p>' +
      '<button class="btn sec" data-act="closesheet">Got it</button>');
  }
  if (low.indexOf("invalid login") > -1) {
    return sheet('<div style="font-weight:600;font-size:18px">Email or password is wrong</div>' +
      '<p class="sm mut" style="margin:0">Supabase has no account with exactly this email and password.</p>' +
      '<p class="sm mut" style="margin:0">• Check for a typo or a stray space, and that the phone hasn\'t capitalised the first letter.</p>' +
      '<p class="sm mut" style="margin:0">• If your browser filled the password in for you, clear it and type it by hand.</p>' +
      '<p class="sm mut" style="margin:0">• Still stuck? In Supabase, <b>Authentication → Users</b>, set a new password on the account.</p>' +
      '<button class="btn sec" data-act="closesheet">Got it</button>');
  }
  if (low.indexOf("rate") > -1 || low.indexOf("too many") > -1) {
    return toast("Too many tries in a row. Wait a minute, then try again.", true);
  }
  return sheet('<div style="font-weight:600;font-size:18px">Couldn\'t sign in</div>' +
    '<p class="sm mut" style="margin:0">Supabase said:</p>' +
    '<p class="sm mono" style="margin:0;overflow-wrap:anywhere">' + esc(raw || "no reason given") + '</p>' +
    '<button class="btn sec" data-act="closesheet">Close</button>');
}
 
function renderProfileSetup() {
  $("tabbar").hidden = true;
  screenEl().innerHTML = `
    <form class="center" id="pform">
      <h2 class="title">Tell us who you are</h2>
      <label class="lbl" for="fn">Full name</label><input id="fn" required value="${esc(S.me.full_name || "")}">
      <label class="lbl" for="dn">Short name staff will see</label><input id="dn" required value="${esc(S.me.display_name || "")}">
      <label class="lbl" for="ph">Phone</label><input id="ph" inputmode="tel" value="${esc(S.me.phone || "")}">
      <button class="btn" type="submit">Save</button>
    </form>`;
  $("pform").addEventListener("submit", async e => {
    e.preventDefault(); busy(true);
    const patch = { full_name: $("fn").value.trim(), display_name: $("dn").value.trim(), phone: $("ph").value.trim() };
    const { error } = await sb.from("profiles").update(patch).eq("id", S.me.id);
    busy(false);
    if (error) return toast(error.message, true);
    Object.assign(S.me, patch); $("tabbar").hidden = false; render();
  });
}
 
/* ---------- shell ----------------------------------------------------- */
function head(title) {
  return `<div class="apphead">
      <div class="wordmark">La Habana<span>Staff</span></div>
      <button class="row" data-act="profile" aria-label="Your profile">
        <span class="xs mut">${S.me.role === "staff" ? "Staff" : S.me.role === "manager" ? "Manager" : "Owner"}</span>
        <span class="avatar">${esc(initials(S.me.display_name))}</span></button>
    </div>${title ? `<h2 class="title">${esc(title)}</h2>` : ""}`;
}
function paintTabs() {
  const tabs = [["home", "Home", "⌂"], ["shifts", "Shifts", "◷"], ["report", "Report", "✎"], ["board", "Board", "▤"], ["chat", "Chat", "✉"]];
  $("tabbar").innerHTML = tabs.map(t => {
    const n = t[0] === "chat" ? S.unread : 0;
    return `<button data-act="tab" data-v="${t[0]}" aria-pressed="${S.tab === t[0]}">
      <span class="ic">${t[2]}</span>${t[1]}${n ? `<span class="dot">${n}</span>` : ""}</button>`;
  }).join("");
}
async function render() {
  paintTabs(); closeSheet();
  screenEl().innerHTML = spinner; screenEl().scrollTop = 0;
  try {
    if (S.tab === "home") await viewHome();
    else if (S.tab === "shifts") await viewShifts();
    else if (S.tab === "report") await viewReport();
    else if (S.tab === "board") await viewBoard();
    else if (S.tab === "chat") await viewChat();
  } catch (err) {
    screenEl().innerHTML = head("Something went wrong") +
      `<div class="card stack"><p class="sm">${esc(err.message || err)}</p>
       <button class="btn sec" data-act="tab" data-v="${S.tab}">Try again</button></div>`;
  }
}
 
/* ---------- home ------------------------------------------------------ */
async function openShift() {
  const { data } = await sb.from("shifts").select("*").eq("user_id", S.me.id).is("ended_at", null)
    .order("started_at", { ascending: false }).limit(1);
  return data && data[0];
}
async function viewHome() {
  const week = mondayOf(todayISO());
  const [open, sched, posts, jobs, reads] = await Promise.all([
    openShift(),
    sb.from("schedule").select("*").gte("day", todayISO()).eq("user_id", S.me.id).order("day").limit(3),
    sb.from("posts").select("*").order("pinned", { ascending: false }).order("created_at", { ascending: false }).limit(5),
    sb.from("jobs").select("id,priority,status").neq("status", "Fixed"),
    sb.from("post_reads").select("post_id").eq("user_id", S.me.id)
  ]);
  const next = (sched.data || []).find(r => !r.is_off);
  const type = next && S.types.find(t => t.id === next.type_id);
  const openJobs = jobs.data || [];
  const urgent = openJobs.filter(j => j.priority === "Urgent").length;
  const post = (posts.data || [])[0];
  const readIds = new Set((reads.data || []).map(r => r.post_id));
  const mustRead = (posts.data || []).filter(p => p.must_read && !readIds.has(p.id)).length;
 
  let mgr = "";
  if (isMgr()) {
    const [{ data: onNow }, { data: inc }, { data: reqs }] = await Promise.all([
      sb.rpc("on_shift_now"),
      sb.from("incidents").select("id").is("reviewed_at", null),
      sb.from("day_off").select("id").eq("status", "pending")
    ]);
    mgr = `<h3 class="sec">Manager</h3><div class="grid2">
      <button class="tile" data-act="tab" data-v="shifts" data-sub="timesheet"><span class="lbl">${(onNow || []).length} on shift now</span>
        <span class="sm mut">${(onNow || []).map(p => esc(p.display_name)).join(", ") || "Nobody clocked in"}</span></button>
      <button class="tile" data-act="tab" data-v="report"><span class="lbl">${(inc || []).length} to review</span><span class="sm mut">Incidents</span></button>
      <button class="tile" data-act="requests"><span class="lbl">${(reqs || []).length} requests</span><span class="sm mut">Day off</span></button>
      <button class="tile" data-act="settings"><span class="lbl">Settings</span><span class="sm mut">Venue, staff, shifts</span></button></div>`;
  }
 
  screenEl().innerHTML = head("Good evening, " + (S.me.display_name || "").split(" ")[0]) + `
    ${open ? `<div class="card stack">
        <div class="between"><span class="chip ok">On shift</span><span class="sm mut mono">since ${fmtTime(open.started_at)}</span></div>
        <div class="big">Clocked in ${hours((Date.now() - new Date(open.started_at)) / 60000)} ago</div>
        <button class="btn" data-act="tab" data-v="shifts">Clock out</button></div>`
      : `<div class="card stack">
        <div class="between"><span class="chip">Not clocked in</span><span class="sm mut mono">${fmtDay(new Date())}</span></div>
        <div class="big">${next ? "Next shift: " + dayLabel(next.day) + " " + (type ? hhmm(type.starts) + " – " + hhmm(type.ends) : hhmm(next.starts) + " – " + hhmm(next.ends)) : "No shift scheduled"}</div>
        ${next ? `<div class="sm mut">${esc(next.position || "")}</div>` : ""}
        <button class="btn" data-act="tab" data-v="shifts">Clock in</button></div>`}
    <div class="grid2" style="margin-top:10px">
      <button class="tile gold" data-act="loyalty"><span class="lbl">Stamp loyalty card</span><span class="sm mut">Opens the loyalty console</span></button>
      <button class="tile" data-act="reportwhat"><span class="lbl">Report something</span><span class="sm mut">Incident or fault</span></button>
    </div>
    ${post ? `<h3 class="sec">From the board</h3>
      <button class="card stack" style="width:100%;text-align:left" data-act="tab" data-v="board">
        <div class="row"><span class="chip gold">${esc(post.kind)}</span>${mustRead ? '<span class="chip warn">Must read</span>' : ""}</div>
        <div style="font-weight:600">${esc(post.title)}</div>
        <div class="sm mut">${esc((post.body || "").slice(0, 120))}</div></button>` : ""}
    <div class="grid2" style="margin-top:10px">
      <button class="tile" data-act="tab" data-v="report" data-sub="maintenance"><span class="lbl">${openJobs.length} open jobs</span><span class="sm mut">${urgent} urgent</span></button>
      <button class="tile" data-act="tab" data-v="chat"><span class="lbl">${S.unread || 0} unread</span><span class="sm mut">Messages</span></button>
    </div>${mgr}`;
}
 
/* ---------- shifts: clock -------------------------------------------- */
async function viewShifts() {
  const tabs = [["clock", "Clock"], ["schedule", "Schedule"]].concat(isMgr() ? [["timesheet", "Timesheet"]] : []);
  const seg = `<div class="segmented">${tabs.map(t =>
    `<button data-act="stab" data-v="${t[0]}" aria-pressed="${S.shiftsTab === t[0]}">${t[1]}</button>`).join("")}</div>`;
  screenEl().innerHTML = head("Shifts") + seg + spinner;
  const body = S.shiftsTab === "clock" ? await clockBody()
    : S.shiftsTab === "schedule" ? await scheduleBody() : await timesheetBody();
  screenEl().innerHTML = head("Shifts") + seg + body;
}
async function clockBody() {
  const open = await openShift();
  const since = addDays(todayISO(), -7);
  const { data: mine } = await sb.from("shifts").select("*").eq("user_id", S.me.id)
    .gte("started_at", since + "T00:00:00Z").order("started_at", { ascending: false });
  let total = 0;
  const rows = (mine || []).map(s => {
    const mins = s.ended_at ? (new Date(s.ended_at) - new Date(s.started_at)) / 60000 : 0;
    total += mins;
    return `<div class="listitem"><span class="chip">${dayLabel(s.started_at.slice(0, 10))}</span>
      <span class="sm">${fmtTime(s.started_at)}${s.ended_at ? " – " + fmtTime(s.ended_at) : " – still open"}
      ${s.auto_closed ? '<br><span class="xs" style="color:#F0C878">Auto-closed — ask a manager to fix it</span>' : ""}</span>
      <span class="sm mono mut">${s.ended_at ? hours(mins) : "—"}</span></div>`;
  }).join("");
  return (open
    ? `<div class="card stack"><span class="chip ok">On shift</span>
        <div class="big">Since ${fmtTime(open.started_at)}</div>
        <div class="sm mut">${hours((Date.now() - new Date(open.started_at)) / 60000)} so far</div>
        <button class="btn" data-act="scan">Scan the QR to clock out</button></div>`
    : `<div class="card stack"><span class="chip">Not clocked in</span>
        <div class="big">Scan the QR at the staff door</div>
        <div class="sm mut">Your phone has to be at ${esc(S.settings?.venue_name || window.LH.VENUE)}.</div>
        <button class="btn" data-act="scan">Scan the QR to clock in</button></div>`)
    + `<h3 class="sec">My last 7 days</h3><div class="stack">${rows || '<p class="sm mut">Nothing yet.</p>'}
       <div class="between sm mut" style="padding:0 4px"><span>Total</span><span class="mono">${hours(total)}</span></div></div>
       <button class="btn sec sm" style="margin-top:14px" data-act="fixshift">Forgot to clock out?</button>`;
}
 
/* ---------- shifts: schedule ------------------------------------------ */
async function weekData(week) {
  const [{ data: rows }, { data: wk }, { data: offs }] = await Promise.all([
    sb.from("schedule").select("*").eq("week_start", week),
    sb.from("weeks").select("*").eq("week_start", week).maybeSingle(),
    sb.from("day_off").select("*").eq("status", "approved").gte("day", week).lte("day", addDays(week, 6))
  ]);
  return { rows: rows || [], published: !!(wk && wk.published_at), offs: offs || [] };
}
function minutesOf(row) {
  const t = S.types.find(x => x.id === row.type_id);
  if (row.is_off) return 0;
  return t ? shiftMinutes(t.starts, t.ends, t.break_min) : shiftMinutes(row.starts, row.ends, 0);
}
function rowLabel(row) {
  const t = S.types.find(x => x.id === row.type_id);
  if (row.is_off) return { name: "Day off", time: "" };
  if (t) return { name: t.name, time: hhmm(t.starts) + " – " + hhmm(t.ends) };
  return { name: "Shift", time: hhmm(row.starts) + " – " + hhmm(row.ends) };
}
function weekWarnings(rows, offs) {
  const w = [];
  S.people.forEach(p => {
    const mine = rows.filter(r => r.user_id === p.id && !r.is_off);
    const mins = mine.reduce((n, r) => n + minutesOf(r), 0);
    if (mins > 48 * 60) w.push(`${p.display_name} is scheduled ${Math.round(mins / 60)} hours — over the 48-hour week.`);
    let run = 0, worst = 0;
    for (let i = 0; i < 7; i++) {
      const day = addDays(S.week, i);
      const worksToday = rows.some(r => r.user_id === p.id && r.day === day && !r.is_off);
      run = worksToday ? run + 1 : 0; worst = Math.max(worst, run);
    }
    if (worst >= 7) w.push(`${p.display_name} has 7 days in a row with no day off.`);
    mine.forEach(r => {
      const t = S.types.find(x => x.id === r.type_id);
      const mins2 = minutesOf(r);
      if (mins2 > 5 * 60 && (!t || !t.break_min)) w.push(`${p.display_name}'s ${rowLabel(r).name} on ${dayLabel(r.day)} is over 5 hours with no break set.`);
      if (offs.some(o => o.user_id === p.id && o.day === r.day)) w.push(`${p.display_name} has an approved day off on ${dayLabel(r.day)} but is scheduled.`);
    });
  });
  for (let i = 0; i < 7; i++) {
    const day = addDays(S.week, i);
    if (!rows.some(r => r.day === day && r.position === "Manager on duty" && !r.is_off))
      w.push(`${dayLabel(day)} has no Manager on duty.`);
  }
  return [...new Set(w)];
}
async function scheduleBody() {
  const { rows, published, offs } = await weekData(S.week);
  const nav = `<div class="between" style="margin-bottom:10px">
      <button class="chip" data-act="week" data-v="-7">‹ Earlier</button>
      <span class="sm mut mono">${dayLabel(S.week)} – ${dayLabel(addDays(S.week, 6))}</span>
      <button class="chip" data-act="week" data-v="7">Later ›</button></div>`;
 
  if (!isMgr()) {
    if (!published) return nav + `<div class="card stack"><span class="chip warn">Not published yet</span>
      <div class="big">This week isn't out</div><div class="sm mut">You'll see it here as soon as a manager publishes it.</div></div>
      <button class="btn sec" style="margin-top:12px" data-act="dayoff">Request a day off</button>`;
    const mine = rows.filter(r => r.user_id === S.me.id).sort((a, b) => a.day.localeCompare(b.day));
    const mins = mine.reduce((n, r) => n + minutesOf(r), 0);
    return nav + `<div class="card stack"><div class="between"><span class="chip gold">Published</span>
        <span class="sm mut mono">${hours(mins)} scheduled</span></div></div>
      <h3 class="sec">My shifts</h3><div class="stack">${mine.map(r => {
        const l = rowLabel(r);
        return `<div class="listitem"><span class="chip ${r.is_off ? "" : "gold"}">${dayLabel(r.day).split(" ")[0]}</span>
          <span class="sm"><b>${esc(l.name)}</b><br><span class="xs mut">${esc(l.time || "Not working")}${r.note ? " · " + esc(r.note) : ""}</span></span>
          <span class="xs mut">${esc(r.position || "")}</span></div>`;
      }).join("") || '<p class="sm mut">Nothing scheduled for you this week.</p>'}</div>
      <h3 class="sec">The team this week</h3><div class="stack">${S.people.filter(p => p.id !== S.me.id).map(p => {
        const days = rows.filter(r => r.user_id === p.id && !r.is_off).map(r => dayLabel(r.day).split(" ")[0]).join(", ");
        return `<div class="listitem"><span class="avatar sm">${esc(initials(p.display_name))}</span>
          <span class="sm">${esc(p.display_name)}<br><span class="xs mut">${days || "Not scheduled"}</span></span><span></span></div>`;
      }).join("")}</div>
      <button class="btn sec" style="margin-top:14px" data-act="dayoff">Request a day off</button>`;
  }
 
  const warns = weekWarnings(rows, offs);
  const days = Array.from({ length: 7 }, (_, i) => addDays(S.week, i));
  return nav + `<div class="between" style="margin-bottom:10px">
      <span class="chip ${published ? "gold" : "warn"}">${published ? "Published" : "Draft — staff can't see it"}</span>
      <span class="sm mut mono">${rows.filter(r => !r.is_off).length} shifts</span></div>
    <div class="daypick">${days.map(d => `<button data-act="day" data-v="${d}" aria-pressed="${S.day === d}">
        <span class="xs">${dayLabel(d).split(" ")[0]}</span><b>${dayLabel(d).split(" ")[1]}</b></button>`).join("")}</div>
    <div class="stack">${S.people.map(p => {
      const cells = rows.filter(r => r.user_id === p.id && r.day === S.day);
      const off = offs.some(o => o.user_id === p.id && o.day === S.day);
      const label = cells.length ? cells.map(c => rowLabel(c).name).join(" + ") : "Not scheduled";
      const sub = cells.length ? cells.map(c => rowLabel(c).time + (c.position ? " · " + c.position : "")).join(" / ")
        : (off ? "Approved day off" : "Tap to assign");
      return `<button class="listitem" data-act="assign" data-v="${p.id}">
        <span class="avatar sm">${esc(initials(p.display_name))}</span>
        <span class="sm">${esc(p.display_name)}<br><span class="xs mut">${esc(sub)}</span></span>
        <span class="chip ${cells.some(c => !c.is_off) ? "gold" : off ? "warn" : ""}">${esc(label)}</span></button>`;
    }).join("")}</div>
    ${warns.length ? `<div class="warnbox" style="margin-top:14px"><b>${warns.length} warning${warns.length > 1 ? "s" : ""}</b>${warns.map(x => `<span>• ${esc(x)}</span>`).join("")}</div>` : ""}
    <h3 class="sec">Week totals</h3><div class="stack">${S.people.map(p => {
      const mins = rows.filter(r => r.user_id === p.id).reduce((n, r) => n + minutesOf(r), 0);
      return `<div class="listitem"><span class="chip">${esc(initials(p.display_name))}</span>
        <span class="sm">${esc(p.display_name)}</span>
        <span class="sm mono ${mins > 48 * 60 ? "" : "mut"}" ${mins > 48 * 60 ? 'style="color:#F0C878"' : ""}>${Math.round(mins / 60)}h</span></div>`;
    }).join("")}</div>
    <div class="stack" style="margin-top:16px">
      <button class="btn sec" data-act="copyweek">Copy last week into this one</button>
      <button class="btn" data-act="publish">${published ? "Publish changes" : "Publish week"}</button></div>`;
}
 
/* ---------- shifts: timesheet ---------------------------------------- */
async function timesheetBody() {
  const from = S.week + "T00:00:00Z", to = addDays(S.week, 7) + "T00:00:00Z";
  const [{ data: shifts }, { data: sched }, { data: rejected }] = await Promise.all([
    sb.from("shifts").select("*").gte("started_at", from).lt("started_at", to).order("started_at"),
    sb.from("schedule").select("*").eq("week_start", S.week),
    sb.from("punches").select("*").eq("accepted", false).gte("at", addDays(todayISO(), -30) + "T00:00:00Z").order("at", { ascending: false }).limit(20)
  ]);
  const rows = S.people.map(p => {
    const mine = (shifts || []).filter(s => s.user_id === p.id);
    const worked = mine.reduce((n, s) => n + (s.ended_at ? (new Date(s.ended_at) - new Date(s.started_at)) / 60000 : 0), 0);
    const planned = (sched || []).filter(r => r.user_id === p.id).reduce((n, r) => n + minutesOf(r), 0);
    let flag = "", cls = "ok";
    const todaySched = (sched || []).find(r => r.user_id === p.id && r.day === todayISO() && !r.is_off);
    if (todaySched) {
      const t = S.types.find(x => x.id === todaySched.type_id);
      const startStr = (t ? t.starts : todaySched.starts) || "";
      if (startStr) {
        const start = new Date(todayISO() + "T" + startStr.slice(0, 5) + ":00+05:00");
        const punchedIn = mine.find(s => Math.abs(new Date(s.started_at) - start) < 6 * 3600e3);
        if (!punchedIn && Date.now() - start > 30 * 60000) { flag = "No-show"; cls = "bad"; }
        else if (punchedIn && new Date(punchedIn.started_at) - start > 10 * 60000) { flag = "Late"; cls = "warn"; }
      }
    }
    return `<div class="listitem"><span class="avatar sm">${esc(initials(p.display_name))}</span>
      <span class="sm">${esc(p.display_name)}<br><span class="xs mut">Worked ${hours(worked)} · scheduled ${Math.round(planned / 60)}h</span></span>
      <span class="chip ${cls}">${flag || "On track"}</span></div>`;
  }).join("");
  const shiftList = (shifts || []).map(s => `<button class="listitem" data-act="editshift" data-v="${s.id}">
      <span class="chip">${dayLabel(s.started_at.slice(0, 10))}</span>
      <span class="sm">${esc(person(s.user_id).display_name)}<br><span class="xs mut">${fmtTime(s.started_at)}${s.ended_at ? " – " + fmtTime(s.ended_at) : " – open"}${s.auto_closed ? " · auto-closed" : ""}${s.edit_reason ? " · edited" : ""}</span></span>
      <span class="sm mono mut">${s.ended_at ? hours((new Date(s.ended_at) - new Date(s.started_at)) / 60000) : "—"}</span></button>`).join("");
  return `<div class="between" style="margin-bottom:10px">
      <button class="chip" data-act="week" data-v="-7">‹ Earlier</button>
      <span class="sm mut mono">${dayLabel(S.week)} – ${dayLabel(addDays(S.week, 6))}</span>
      <button class="chip" data-act="week" data-v="7">Later ›</button></div>
    <div class="stack">${rows}</div>
    <h3 class="sec">Every shift this week</h3><div class="stack">${shiftList || '<p class="sm mut">No clock-ins this week.</p>'}</div>
    <h3 class="sec">Refused clock-ins (30 days)</h3><div class="stack">${(rejected || []).map(r => `
      <div class="listitem"><span class="chip bad">${esc(r.reason || "refused")}</span>
        <span class="sm">${esc(person(r.user_id).display_name)}<br><span class="xs mut">${fmtDayTime(r.at)}${r.distance_m ? " · " + Math.round(r.distance_m) + " m away" : ""}</span></span><span></span></div>`).join("")
    || '<p class="sm mut">None. Good sign.</p>'}</div>
    <button class="btn sec" style="margin-top:14px" data-act="csv">Download this week as CSV</button>`;
}
 
/* ---------- report: incidents + maintenance --------------------------- */
async function viewReport() {
  const seg = `<div class="segmented">
    <button data-act="rtab" data-v="incidents" aria-pressed="${S.reportTab === "incidents"}">Incidents</button>
    <button data-act="rtab" data-v="maintenance" aria-pressed="${S.reportTab === "maintenance"}">Maintenance</button></div>`;
  screenEl().innerHTML = head("Report") + seg + spinner;
  const body = S.reportTab === "incidents" ? await incidentsBody() : await jobsBody();
  screenEl().innerHTML = head("Report") + seg + body;
}
async function incidentsBody() {
  const { data, error } = await sb.from("incidents").select("*").order("happened_at", { ascending: false }).limit(60);
  if (error) throw error;
  return `<button class="btn" data-act="newincident">New incident</button>
    <h3 class="sec">${isMgr() ? "All incidents" : "My reports"}</h3>
    <div class="stack">${(data || []).map(i => `<div class="card stack">
      <div class="between"><span class="row">
        <span class="chip ${i.severity === "High" ? "bad" : i.severity === "Medium" ? "warn" : ""}">${esc(i.kind)}</span>
        ${i.severity === "High" ? '<span class="chip bad">High</span>' : ""}</span>
        <span class="xs mut mono">${fmtDayTime(i.happened_at)}</span></div>
      <div class="sm">${esc(i.description)}</div>
      <div class="xs mut">${esc(i.area || "")} · ${esc(person(i.created_by).display_name)}${i.action ? " · " + esc(i.action) : ""}
        ${Object.entries(i.extra || {}).map(([k, v]) => " · " + esc(v)).join("")}</div>
      ${(i.photos || []).length ? `<div class="row">${i.photos.map(p => `<button class="chip" data-act="photo" data-v="${esc(p)}">View photo</button>`).join("")}</div>` : ""}
      ${i.reviewed_at ? '<span class="chip ok">Reviewed</span>'
        : isMgr() ? `<button class="btn sec sm" data-act="review" data-v="${i.id}">Mark reviewed</button>`
        : '<span class="chip">Waiting for review</span>'}
    </div>`).join("") || '<p class="sm mut">Nothing logged yet.</p>'}</div>`;
}
async function jobsBody() {
  const { data, error } = await sb.from("jobs").select("*").order("created_at", { ascending: false }).limit(80);
  if (error) throw error;
  const open = (data || []).filter(j => j.status !== "Fixed")
    .sort((a, b) => (a.priority === "Urgent" ? -1 : 1) - (b.priority === "Urgent" ? -1 : 1) || a.created_at.localeCompare(b.created_at));
  const fixed = (data || []).filter(j => j.status === "Fixed").slice(0, 15);
  const age = j => {
    const d = Math.floor((Date.now() - new Date(j.created_at)) / 86400000);
    return d <= 0 ? "Open today" : "Open " + d + " day" + (d > 1 ? "s" : "");
  };
  const card = j => `<button class="card stack" style="width:100%;text-align:left" data-act="job" data-v="${j.id}">
      <div class="between"><span class="row">
        <span class="chip ${j.priority === "Urgent" ? "bad" : ""}">${esc(j.priority)}</span>
        <span class="chip ${j.status === "Fixed" ? "ok" : ""}">${esc(j.status)}</span></span>
        <span class="xs mut mono">${age(j)}</span></div>
      <div style="font-weight:600">${esc(j.title)}</div>
      <div class="xs mut">${esc(j.area || "")} · ${esc(person(j.created_by).display_name)}${(j.photos || []).length ? " · photo" : ""}</div></button>`;
  return `<button class="btn" data-act="newjob">Report a fault</button>
    <h3 class="sec">Open</h3><div class="stack">${open.map(card).join("") || '<p class="sm mut">Nothing open.</p>'}</div>
    ${fixed.length ? `<h3 class="sec">Fixed</h3><div class="stack">${fixed.map(card).join("")}</div>` : ""}`;
}
 
/* ---------- board ------------------------------------------------------ */
async function viewBoard() {
  screenEl().innerHTML = head("Board") + spinner;
  const [{ data: posts }, { data: reads }, { data: onNow }] = await Promise.all([
    sb.from("posts").select("*").order("pinned", { ascending: false }).order("created_at", { ascending: false }).limit(40),
    sb.from("post_reads").select("*"),
    sb.rpc("on_shift_now")
  ]);
  const today = todayISO();
  const live = (posts || []).filter(p => !p.until || p.until >= today);
  const mine = new Set((reads || []).filter(r => r.user_id === S.me.id).map(r => r.post_id));
  screenEl().innerHTML = head("Board") + `
    <div class="card stack">
      <div class="between"><span class="chip ok">On shift now</span><span class="xs mut mono">${fmtTime(new Date())}</span></div>
      ${(onNow || []).length ? `<div class="row">${(onNow || []).map(p => `<span class="avatar sm">${esc(initials(p.display_name))}</span>`).join("")}
        <span class="xs mut">${(onNow || []).map(p => esc(p.display_name)).join(", ")}</span></div>`
        : '<div class="sm mut">Nobody is clocked in.</div>'}
    </div>
    ${isMgr() ? '<button class="btn sec" style="margin-top:12px" data-act="newpost">New post</button>' : ""}
    <h3 class="sec">Notices</h3>
    <div class="stack">${live.map(p => {
      const count = (reads || []).filter(r => r.post_id === p.id).length;
      return `<div class="card stack">
        <div class="between"><span class="row"><span class="chip gold">${esc(p.kind)}</span>
          ${p.pinned ? '<span class="chip">Pinned</span>' : ""}</span>
          <span class="xs mut mono">${fmtDayTime(p.created_at)}</span></div>
        <div style="font-weight:600">${esc(p.title)}</div>
        <div class="sm mut">${esc(p.body || "")}</div>
        ${p.meta && p.meta.line ? `<div class="xs mono" style="color:var(--gold-ink)">${esc(p.meta.line)}</div>` : ""}
        ${p.must_read ? (isMgr()
          ? `<div class="between"><span class="chip ${count >= S.people.length ? "ok" : "warn"}">${count}/${S.people.length} read it</span>
             <button class="btn sec sm" data-act="whoread" data-v="${p.id}">Who hasn't</button></div>`
          : (mine.has(p.id) ? '<span class="chip ok">✓ You read this</span>'
             : `<button class="btn sm" data-act="gotit" data-v="${p.id}">Got it</button>`)) : ""}
        ${isMgr() ? `<button class="btn sec sm" data-act="delpost" data-v="${p.id}">Remove</button>` : ""}
      </div>`;
    }).join("") || '<p class="sm mut">No notices yet.</p>'}</div>`;
}
 
/* ---------- chat -------------------------------------------------------- */
let chatChannel = null;
function watchMessages() {
  if (chatChannel) return;
  chatChannel = sb.channel("lh-messages")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, p => {
      const m = p.new;
      if (m.sender === S.me.id) return;
      const inThisThread = S.tab === "chat" && S.chat &&
        ((S.chat === "all" && !m.recipient) || (S.chat === m.sender && m.recipient === S.me.id));
      if (inThisThread) viewChat();
      else { S.unread++; paintTabs(); if (S.tab === "chat") viewChat(); }
    }).subscribe();
}
async function viewChat() {
  const { data, error } = await sb.from("messages").select("*").order("created_at", { ascending: false }).limit(300);
  if (error) throw error;
  const msgs = (data || []).slice().reverse();
  if (!S.chat) {
    S.unread = 0; paintTabs();
    const threads = [{ id: "all", name: "All staff" }].concat(
      S.people.filter(p => p.id !== S.me.id).map(p => ({ id: p.id, name: p.display_name })));
    screenEl().innerHTML = head("Chat") + `<div class="stack">${threads.map(t => {
      const list = t.id === "all" ? msgs.filter(m => !m.recipient)
        : msgs.filter(m => m.recipient && (m.sender === t.id || m.recipient === t.id));
      const last = list[list.length - 1];
      return `<button class="listitem" data-act="openchat" data-v="${t.id}">
        <span class="avatar sm">${t.id === "all" ? "★" : esc(initials(t.name))}</span>
        <span class="sm">${esc(t.name)}<br><span class="xs mut">${last ? esc(last.body.slice(0, 40)) : "No messages yet"}</span></span>
        <span class="xs mut mono">${last ? fmtTime(last.created_at) : ""}</span></button>`;
    }).join("")}</div>
    <p class="note" style="margin-top:16px">Everyone is in All staff. A private message is only seen by the two of you.</p>`;
    return;
  }
  const name = S.chat === "all" ? "All staff" : person(S.chat).display_name;
  const list = S.chat === "all" ? msgs.filter(m => !m.recipient)
    : msgs.filter(m => m.recipient && (m.sender === S.chat || m.recipient === S.chat));
  screenEl().innerHTML = `<div class="apphead">
      <button class="chip" data-act="chatback">‹ Back</button>
      <div style="font-weight:600">${esc(name)}</div>
      <span class="avatar sm">${S.chat === "all" ? "★" : esc(initials(name))}</span></div>
    <div class="stack" style="gap:8px" id="msgs">${list.map(m => `
      <div class="msg ${m.sender === S.me.id ? "me" : ""}">
        ${m.sender !== S.me.id ? `<div class="who">${esc(person(m.sender).display_name)}</div>` : ""}
        ${esc(m.body)}<div class="tm">${fmtTime(m.created_at)}</div></div>`).join("")
      || '<p class="sm mut">Say something.</p>'}</div>
    <form class="composer" id="send"><input id="msgbox" placeholder="Message…" autocomplete="off" required>
      <button class="btn" style="width:auto;padding:0 18px">Send</button></form>`;
  const form = $("send");
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const box = $("msgbox"); const body = box.value.trim(); if (!body) return;
    box.value = "";
    const { error: err } = await sb.from("messages").insert({
      sender: S.me.id, recipient: S.chat === "all" ? null : S.chat, body
    });
    if (err) toast(err.message, true);
    viewChat();
  });
  const box = $("msgs"); if (box) screenEl().scrollTop = screenEl().scrollHeight;
}
 
/* ---------- clocking in ------------------------------------------------ */
function getLocation() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      p => resolve(p.coords), () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}
async function punch(code, method) {
  const layer = document.createElement("div");
  layer.className = "scan";
  layer.innerHTML = '<div class="spin"></div><div style="font-weight:600">Checking you are at the venue…</div>';
  $("layer").appendChild(layer);
  const c = await getLocation();
  const { data, error } = await sb.rpc("clock_punch", {
    p_site_code: code,
    p_lat: c ? c.latitude : null,
    p_lng: c ? c.longitude : null,
    p_acc: c ? c.accuracy : null,
    p_method: method || "scan"
  });
  layer.remove();
  if (error) return toast(error.message, true);
  toast(data.message, !data.ok);
  if (data.ok) render();
}
async function startScan() {
  const layer = document.createElement("div");
  layer.className = "scan";
  layer.innerHTML = `<video playsinline muted autoplay></video>
    <div style="font-weight:600">Point at the QR by the staff door</div>
    <div class="sm mut">Can't scan? Take a photo of it instead.</div>
    <label class="btn sec" style="max-width:280px">Take a photo of the QR
      <input type="file" accept="image/*" capture="environment" hidden id="qrfile"></label>
    <button class="btn sec" style="max-width:280px" data-act="closescan">Cancel</button>`;
  $("layer").appendChild(layer);
  const video = layer.querySelector("video");
  let stream = null, stop = false;
  const finish = code => { stop = true; if (stream) stream.getTracks().forEach(t => t.stop()); layer.remove(); punch(code, "scan"); };
  layer.querySelector("#qrfile").addEventListener("change", async e => {
    const file = e.target.files[0]; if (!file) return;
    const code = await decodeImage(file);
    if (code) finish(code); else toast("Couldn't read that QR. Try again in better light.", true);
  });
  layer.addEventListener("click", e => {
    if (e.target.closest('[data-act="closescan"]')) { stop = true; if (stream) stream.getTracks().forEach(t => t.stop()); layer.remove(); }
  });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
    video.srcObject = stream; await video.play();
  } catch (e) {
    video.remove();
    toast("Your phone won't give the camera. Use the photo button instead.", true);
    return;
  }
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
  (function tick() {
    if (stop) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const found = window.jsQR && jsQR(img.data, img.width, img.height);
      if (found && found.data) return finish(siteFrom(found.data));
    }
    requestAnimationFrame(tick);
  })();
}
function siteFrom(text) {
  try { const u = new URL(text); return u.searchParams.get("site") || text; } catch (e) { return text; }
}
function decodeImage(file) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      const scale = Math.min(1, 1200 / Math.max(img.width, img.height));
      c.width = img.width * scale; c.height = img.height * scale;
      const x = c.getContext("2d"); x.drawImage(img, 0, 0, c.width, c.height);
      const d = x.getImageData(0, 0, c.width, c.height);
      const found = window.jsQR && jsQR(d.data, d.width, d.height);
      resolve(found && found.data ? siteFrom(found.data) : null);
    };
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(file);
  });
}
 
/* ---------- photos ------------------------------------------------------ */
async function shrink(file) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, "image/jpeg", 0.72));
}
async function uploadPhotos(input, folder) {
  const out = [];
  for (const file of Array.from(input.files || []).slice(0, 3)) {
    const blob = await shrink(file);
    const path = folder + "/" + crypto.randomUUID() + ".jpg";
    const { error } = await sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg" });
    if (error) { toast("Photo didn't upload: " + error.message, true); continue; }
    out.push(path);
  }
  return out;
}
async function showPhoto(path) {
  const { data, error } = await sb.storage.from("photos").createSignedUrl(path, 3600);
  if (error) return toast("Couldn't open that photo.", true);
  sheet(`<div style="font-weight:600">Photo</div><img src="${esc(data.signedUrl)}" alt="" style="border-radius:12px">
    <button class="btn sec" data-act="closesheet">Close</button>`);
}
 
/* ---------- forms ------------------------------------------------------ */
const areaOptions = sel => (S.settings?.areas || []).map(a =>
  `<option${a === sel ? " selected" : ""}>${esc(a)}</option>`).join("");
const posOptions = sel => (S.settings?.positions || []).map(a =>
  `<option${a === sel ? " selected" : ""}>${esc(a)}</option>`).join("");
 
function newIncidentSheet() {
  const kinds = ["Complaint", "Breakage", "Burn / injury", "Refused guest", "Fight / aggression", "Other"];
  sheet(`<div style="font-weight:600;font-size:18px">New incident</div>
    <div class="row" id="kinds">${kinds.map((k, i) =>
      `<button type="button" class="chip${i === 0 ? " gold" : ""}" data-act="kind" data-v="${esc(k)}">${esc(k)}</button>`).join("")}</div>
    <label class="lbl" for="iarea">Where</label><select id="iarea">${areaOptions()}</select>
    <div id="extra"></div>
    <label class="lbl" for="itext">What happened</label><textarea id="itext" rows="3" required></textarea>
    <label class="lbl" for="iaction">What you did about it (optional)</label><input id="iaction">
    <label class="lbl" for="isev">How serious</label>
    <select id="isev"><option>Low</option><option>Medium</option><option>High</option></select>
    <label class="btn sec" style="text-align:left">Add photo (optional)
      <input type="file" id="iphoto" accept="image/*" capture="environment" multiple hidden></label>
    <p class="xs mut" style="margin:0">Don't photograph guests' faces or ID cards.</p>
    <button class="btn" data-act="saveincident">Save incident</button>`);
  setKind("Complaint");
}
function setKind(kind) {
  document.querySelectorAll('[data-act="kind"]').forEach(b => b.classList.toggle("gold", b.dataset.v === kind));
  const box = $("extra"); if (!box) return;
  const sev = $("isev");
  if (kind === "Refused guest") box.innerHTML = `<label class="lbl" for="x1">Why refused</label>
    <select id="x1" data-key="Reason"><option>Under age (born on or after 1 Jan 2007)</option><option>No ID</option><option>Intoxicated</option><option>Behaviour</option><option>Other</option></select>`;
  else if (kind === "Breakage") box.innerHTML = `<label class="lbl" for="x1">What broke</label><input id="x1" data-key="Item">
    <label class="lbl" for="x2">Rough cost (MVR)</label><input id="x2" data-key="Cost MVR" inputmode="numeric">
    <label class="lbl" for="x3">Charged to the guest?</label><select id="x3" data-key="Charged"><option>No</option><option>Yes</option></select>`;
  else if (kind === "Burn / injury") box.innerHTML = `<label class="lbl" for="x1">Who was hurt</label>
    <select id="x1" data-key="Hurt"><option>Guest</option><option>Staff</option></select>
    <label class="lbl" for="x2">First aid given?</label><select id="x2" data-key="First aid"><option>Yes</option><option>No</option></select>`;
  else if (kind === "Complaint") box.innerHTML = `<label class="lbl" for="x1">About</label>
    <select id="x1" data-key="About"><option>Service</option><option>Shisha</option><option>Food & drink</option><option>Karaoke</option><option>Noise</option><option>Price</option><option>Other</option></select>`;
  else box.innerHTML = "";
  if (sev) sev.value = (kind === "Fight / aggression" || kind === "Burn / injury") ? "High" : "Low";
}
async function saveIncident() {
  const kind = document.querySelector('[data-act="kind"].gold')?.dataset.v || "Other";
  const description = $("itext").value.trim();
  if (!description) return toast("Write what happened first.", true);
  busy(true);
  const extra = {};
  ["x1", "x2", "x3"].forEach(id => { const el = $(id); if (el && el.value) extra[el.dataset.key] = el.value; });
  const photos = await uploadPhotos($("iphoto"), "incidents");
  const { error } = await sb.from("incidents").insert({
    created_by: S.me.id, kind, area: $("iarea").value, severity: $("isev").value,
    description, action: $("iaction").value.trim() || null, extra, photos
  });
  busy(false);
  if (error) return toast(error.message, true);
  closeSheet(); S.tab = "report"; S.reportTab = "incidents"; render();
  toast($("isev") && kind ? "Incident logged." : "Incident logged.");
}
function newJobSheet() {
  sheet(`<div style="font-weight:600;font-size:18px">Report a fault</div>
    <label class="lbl" for="jt">What's wrong</label><input id="jt" placeholder="Room 2 mic dead" required>
    <label class="lbl" for="ja">Where</label><select id="ja">${areaOptions()}</select>
    <label class="lbl" for="jd">Details (optional)</label><textarea id="jd" rows="2"></textarea>
    <label class="lbl" for="jp">How urgent</label>
    <select id="jp"><option>Normal</option><option>Urgent</option><option>Low</option></select>
    <label class="btn sec" style="text-align:left">Add photo (optional)
      <input type="file" id="jphoto" accept="image/*" capture="environment" multiple hidden></label>
    <button class="btn" data-act="savejob">Send to maintenance</button>`);
}
async function saveJob() {
  const title = $("jt").value.trim();
  if (!title) return toast("Give it a short title.", true);
  busy(true);
  const photos = await uploadPhotos($("jphoto"), "jobs");
  const { error } = await sb.from("jobs").insert({
    created_by: S.me.id, title, area: $("ja").value, details: $("jd").value.trim() || null,
    priority: $("jp").value, photos
  });
  busy(false);
  if (error) return toast(error.message, true);
  closeSheet(); S.tab = "report"; S.reportTab = "maintenance"; render();
  toast("Sent. It stays open until someone fixes it.");
}
async function jobSheet(id) {
  const [{ data: j }, { data: events }] = await Promise.all([
    sb.from("jobs").select("*").eq("id", id).maybeSingle(),
    sb.from("job_events").select("*").eq("job_id", id).order("at")
  ]);
  if (!j) return toast("That job is gone.", true);
  sheet(`<div class="between"><span class="chip ${j.priority === "Urgent" ? "bad" : ""}">${esc(j.priority)}</span>
      <span class="chip ${j.status === "Fixed" ? "ok" : ""}">${esc(j.status)}</span></div>
    <div style="font-weight:600;font-size:18px">${esc(j.title)}</div>
    <div class="sm mut">${esc(j.area || "")} · reported by ${esc(person(j.created_by).display_name)} · ${fmtDayTime(j.created_at)}</div>
    ${j.details ? `<div class="card sm">${esc(j.details)}</div>` : ""}
    ${(j.photos || []).length ? `<div class="row">${j.photos.map(p => `<button class="chip" data-act="photo" data-v="${esc(p)}">View photo</button>`).join("")}</div>` : ""}
    ${j.fix_note ? `<div class="card sm"><b>Fixed:</b> ${esc(j.fix_note)} — ${esc(person(j.fixed_by).display_name)}</div>` : ""}
    ${events.length ? `<div class="stack">${events.map(e => `<div class="xs mut">${fmtDayTime(e.at)} · ${esc(e.text)}</div>`).join("")}</div>` : ""}
    ${j.status !== "Fixed" ? `
      ${j.status === "Open" ? `<button class="btn sec" data-act="jobstat" data-v="${j.id}|In progress">I'm on it</button>` : ""}
      <label class="lbl" for="fixnote">What did you do?</label><input id="fixnote" placeholder="Swapped the mic and tested it">
      <button class="btn" data-act="jobfix" data-v="${j.id}">Mark fixed</button>`
    : `<label class="lbl" for="fixnote">Why reopen?</label><input id="fixnote">
       <button class="btn sec" data-act="jobstat" data-v="${j.id}|Open">Reopen</button>`}`);
}
async function jobStatus(id, status) {
  const note = $("fixnote") ? $("fixnote").value.trim() : "";
  if (status === "Open" && !note) return toast("Say why you're reopening it.", true);
  busy(true);
  const patch = status === "Open" ? { status, fix_note: null, fixed_by: null, fixed_at: null } : { status };
  const { error } = await sb.from("jobs").update(patch).eq("id", id);
  if (!error) await sb.from("job_events").insert({ job_id: id, by_user: S.me.id, text: `${S.me.display_name} set it to ${status}${note ? " — " + note : ""}` });
  busy(false);
  if (error) return toast(error.message, true);
  closeSheet(); render(); toast(status === "Open" ? "Reopened." : "Marked in progress.");
}
async function jobFix(id) {
  const note = $("fixnote").value.trim();
  if (!note) return toast("Write what you did first.", true);
  busy(true);
  const { error } = await sb.from("jobs").update({ status: "Fixed", fix_note: note, fixed_by: S.me.id, fixed_at: new Date().toISOString() }).eq("id", id);
  if (!error) await sb.from("job_events").insert({ job_id: id, by_user: S.me.id, text: `${S.me.display_name} fixed it — ${note}` });
  busy(false);
  if (error) return toast(error.message, true);
  closeSheet(); render(); toast("Fixed. Nice one.");
}
 
/* ---------- schedule editing ------------------------------------------ */
async function assignSheet(userId) {
  const { data: rows } = await sb.from("schedule").select("*").eq("day", S.day).eq("user_id", userId);
  const p = person(userId);
  sheet(`<div style="font-weight:600;font-size:18px">${esc(p.display_name)}</div>
    <div class="sm mut">${dayLabel(S.day)}</div>
    ${(rows || []).map(r => `<div class="listitem"><span class="chip ${r.is_off ? "" : "gold"}">${esc(rowLabel(r).name)}</span>
      <span class="sm">${esc(rowLabel(r).time || "Not working")}<br><span class="xs mut">${esc(r.position || "")}</span></span>
      <button class="chip bad" data-act="unassign" data-v="${r.id}">Remove</button></div>`).join("")}
    <label class="lbl" for="stype">Give them</label>
    <select id="stype">${S.types.map(t => `<option value="${t.id}">${esc(t.name)} · ${hhmm(t.starts)} – ${hhmm(t.ends)}</option>`).join("")}
      <option value="off">Day off</option></select>
    <label class="lbl" for="spos">Position</label><select id="spos">${posOptions(p.position)}</select>
    <label class="lbl" for="snote">Note (optional)</label><input id="snote" placeholder="Birthday booking in Room 2">
    <button class="btn" data-act="saveassign" data-v="${userId}">Save</button>`);
}
async function saveAssign(userId) {
  const val = $("stype").value;
  busy(true);
  const row = val === "off"
    ? { day: S.day, user_id: userId, is_off: true, updated_by: S.me.id }
    : { day: S.day, user_id: userId, type_id: val, position: $("spos").value, note: $("snote").value.trim() || null, updated_by: S.me.id };
  const { error } = await sb.from("schedule").insert(row);
  busy(false);
  if (error) return toast(error.message, true);
  closeSheet(); render();
}
async function copyWeek() {
  const prev = addDays(S.week, -7);
  const { data: rows } = await sb.from("schedule").select("*").eq("week_start", prev);
  if (!rows || !rows.length) return toast("Last week is empty — nothing to copy.", true);
  const { data: existing } = await sb.from("schedule").select("id").eq("week_start", S.week);
  if (existing && existing.length) return toast("This week already has shifts. Clear them first.", true);
  const copy = rows.map(r => ({ day: addDays(r.day, 7), user_id: r.user_id, type_id: r.type_id, starts: r.starts, ends: r.ends, position: r.position, is_off: r.is_off, updated_by: S.me.id }));
  const { error } = await sb.from("schedule").insert(copy);
  if (error) return toast(error.message, true);
  render(); toast("Copied " + copy.length + " shifts from last week.");
}
 
/* ---------- other sheets ----------------------------------------------- */
async function requestsSheet() {
  const { data } = await sb.from("day_off").select("*").eq("status", "pending").order("day");
  sheet(`<div style="font-weight:600;font-size:18px">Day off requests</div>
    ${(data || []).map(r => `<div class="card stack">
      <div class="between"><span class="chip">${esc(person(r.user_id).display_name)}</span><span class="sm mono">${dayLabel(r.day)}</span></div>
      ${r.reason ? `<div class="xs mut">${esc(r.reason)}</div>` : ""}
      <div class="row"><button class="btn sm" data-act="decide" data-v="${r.id}|approved">Approve</button>
        <button class="btn sec sm" data-act="decide" data-v="${r.id}|declined">Decline</button></div></div>`).join("")
    || '<p class="sm mut">Nothing waiting.</p>'}
    <button class="btn sec" data-act="closesheet">Close</button>`);
}
function dayOffSheet() {
  sheet(`<div style="font-weight:600;font-size:18px">Request a day off</div>
    <label class="lbl" for="dday">Which day</label><input id="dday" type="date" value="${addDays(todayISO(), 7)}">
    <label class="lbl" for="dwhy">Why (optional)</label><textarea id="dwhy" rows="2"></textarea>
    <button class="btn" data-act="savedayoff">Send to the manager</button>`);
}
function newPostSheet() {
  sheet(`<div style="font-weight:600;font-size:18px">New post</div>
    <label class="lbl" for="pk">Type</label>
    <select id="pk"><option>Today's promo</option><option>Price change</option><option>New flavour</option><option>General</option></select>
    <label class="lbl" for="pt">Title</label><input id="pt" required>
    <label class="lbl" for="pb">Message</label><textarea id="pb" rows="3"></textarea>
    <label class="lbl" for="pl">One line of detail (optional)</label>
    <input id="pl" placeholder="Premium head · MVR 350 → MVR 390 · from Thu 17 Sep">
    <label class="lbl" for="pu">Show until (optional)</label><input id="pu" type="date">
    <div class="row"><label class="chip"><input type="checkbox" id="ppin" style="width:auto;margin-right:6px"> Pin to top</label>
      <label class="chip"><input type="checkbox" id="pmust" style="width:auto;margin-right:6px"> Must read</label></div>
    <button class="btn" data-act="savepost">Post to the board</button>`);
}
async function whoRead(postId) {
  const { data } = await sb.from("post_reads").select("*").eq("post_id", postId);
  const done = new Set((data || []).map(r => r.user_id));
  sheet(`<div style="font-weight:600;font-size:18px">Who has read it</div>
    <div class="stack">${S.people.map(p => `<div class="listitem"><span class="avatar sm">${esc(initials(p.display_name))}</span>
      <span class="sm">${esc(p.display_name)}</span>
      <span class="chip ${done.has(p.id) ? "ok" : "warn"}">${done.has(p.id) ? "Read" : "Not yet"}</span></div>`).join("")}</div>
    <button class="btn sec" data-act="closesheet">Close</button>`);
}
async function editShiftSheet(id) {
  const { data: s } = await sb.from("shifts").select("*").eq("id", id).maybeSingle();
  if (!s) return;
  const local = iso => iso ? new Date(new Date(iso).getTime() + 5 * 3600e3).toISOString().slice(0, 16) : "";
  sheet(`<div style="font-weight:600;font-size:18px">${esc(person(s.user_id).display_name)}</div>
    <div class="sm mut">${fmtDay(s.started_at)}${s.auto_closed ? " · auto-closed after 14 hours" : ""}</div>
    <label class="lbl" for="es">Started</label><input id="es" type="datetime-local" value="${local(s.started_at)}">
    <label class="lbl" for="ee">Finished</label><input id="ee" type="datetime-local" value="${local(s.ended_at)}">
    <label class="lbl" for="er">Why are you changing it?</label><input id="er" required placeholder="Forgot to clock out, checked the CCTV">
    <button class="btn" data-act="saveshift" data-v="${id}">Save change</button>
    <p class="xs mut" style="margin:0">The original times are kept.</p>`);
}
async function saveShift(id) {
  const reason = $("er").value.trim();
  if (!reason) return toast("A reason is required.", true);
  const toISO = v => v ? new Date(v + ":00+05:00").toISOString() : null;
  busy(true);
  const { error } = await sb.from("shifts").update({
    started_at: toISO($("es").value), ended_at: toISO($("ee").value),
    edited_by: S.me.id, edit_reason: reason, auto_closed: false
  }).eq("id", id);
  busy(false);
  if (error) return toast(error.message, true);
  closeSheet(); render(); toast("Shift updated.");
}
function fixShiftSheet() {
  sheet(`<div style="font-weight:600;font-size:18px">Forgot to clock out?</div>
    <p class="sm mut" style="margin:0">Send a manager a message with the time you actually finished — they can correct it on the timesheet.</p>
    <button class="btn" data-act="msgmanager">Message a manager</button>
    <button class="btn sec" data-act="closesheet">Close</button>`);
}
async function profileSheet() {
  sheet(`<div style="font-weight:600;font-size:18px">${esc(S.me.display_name)}</div>
    <div class="sm mut">${esc(S.me.full_name || "")} · ${esc(S.me.role)}${S.me.position ? " · " + esc(S.me.position) : ""}</div>
    <label class="lbl" for="mdn">Short name</label><input id="mdn" value="${esc(S.me.display_name || "")}">
    <label class="lbl" for="mph">Phone</label><input id="mph" value="${esc(S.me.phone || "")}">
    <button class="btn" data-act="saveprofile">Save</button>
    ${isMgr() ? '<button class="btn sec" data-act="settings">Settings</button>' : ""}
    <button class="btn sec" data-act="signout">Sign out</button>`);
}
 
/* ---------- settings ---------------------------------------------------- */
async function settingsSheet() {
  const s = S.settings || {};
  sheet(`<div style="font-weight:600;font-size:18px">Settings</div>
    ${isOwner() ? `
      <label class="lbl" for="vn">Venue name</label><input id="vn" value="${esc(s.venue_name || "")}">
      <label class="lbl">Venue location</label>
      <div class="row"><input id="vlat" placeholder="latitude" value="${s.venue_lat ?? ""}" inputmode="decimal" style="flex:1">
        <input id="vlng" placeholder="longitude" value="${s.venue_lng ?? ""}" inputmode="decimal" style="flex:1"></div>
      <button class="btn sec" data-act="hereloc">Use my location right now</button>
      <label class="lbl" for="vrad">How close staff must be (metres)</label><input id="vrad" type="number" value="${s.radius_m ?? 150}">
      <label class="lbl" for="vloy">Loyalty console link</label><input id="vloy" value="${esc(s.loyalty_url || "")}" placeholder="https://script.google.com/…/exec?page=staff">
      <label class="lbl" for="vareas">Areas (one per line)</label><textarea id="vareas" rows="4">${esc((s.areas || []).join("\n"))}</textarea>
      <label class="lbl" for="vpos">Positions (one per line)</label><textarea id="vpos" rows="3">${esc((s.positions || []).join("\n"))}</textarea>
      <button class="btn" data-act="savesettings">Save settings</button>
      <div class="card stack"><div class="sm"><b>Clock-in code</b></div>
        <div class="xs mono" style="overflow-wrap:anywhere">${esc(s.site_code || "")}</div>
        <div class="xs mut" style="overflow-wrap:anywhere">QR link: ${esc(location.origin + location.pathname + "?site=" + (s.site_code || ""))}</div>
        <button class="btn sec sm" data-act="qrposter">Show the QR poster</button>
        <button class="btn sec sm" data-act="newcode">New code (old QR stops working)</button></div>
      <button class="btn sec" data-act="staff">Staff and roles</button>` : ""}
    <button class="btn sec" data-act="shifttypes">Shift types</button>
    <button class="btn sec" data-act="closesheet">Close</button>`);
}
async function staffSheet() {
  const { data } = await sb.from("profiles").select("*").order("display_name");
  sheet(`<div style="font-weight:600;font-size:18px">Staff</div>
    <p class="xs mut" style="margin:0">New people are added in Supabase (Authentication → Users → Add user). They appear here after their first sign-in.</p>
    <div class="stack">${(data || []).map(p => `<div class="card stack">
      <div class="between"><span class="row"><span class="avatar sm">${esc(initials(p.display_name))}</span>
        <span class="sm">${esc(p.display_name || "—")}<br><span class="xs mut">${esc(p.full_name || "")}</span></span></span>
        <span class="chip ${p.active ? "ok" : "bad"}">${p.active ? "Active" : "Off"}</span></div>
      <div class="row">
        <select data-role-for="${p.id}" style="flex:1">
          ${["staff", "manager", "owner"].map(r => `<option value="${r}"${p.role === r ? " selected" : ""}>${r}</option>`).join("")}
        </select>
        <select data-pos-for="${p.id}" style="flex:1"><option value="">position…</option>${posOptions(p.position)}</select>
      </div>
      <div class="row"><button class="btn sm" data-act="saveperson" data-v="${p.id}">Save</button>
        <button class="btn sec sm" data-act="toggleperson" data-v="${p.id}|${p.active ? "off" : "on"}">${p.active ? "Deactivate" : "Reactivate"}</button></div>
    </div>`).join("")}</div>
    <button class="btn sec" data-act="closesheet">Close</button>`);
}
async function shiftTypesSheet() {
  sheet(`<div style="font-weight:600;font-size:18px">Shift types</div>
    <div class="stack">${S.types.map(t => `<div class="listitem"><span class="chip gold">${esc(t.name)}</span>
      <span class="sm">${hhmm(t.starts)} – ${hhmm(t.ends)}<br><span class="xs mut">${t.break_min} min break</span></span>
      <button class="chip bad" data-act="deltype" data-v="${t.id}">Remove</button></div>`).join("")}</div>
    <div class="card stack"><div class="sm"><b>Add one</b></div>
      <input id="tn" placeholder="Name, e.g. Evening">
      <div class="row"><input id="ts" type="time" value="17:00" style="flex:1"><input id="te" type="time" value="01:00" style="flex:1"></div>
      <input id="tb" type="number" value="30" placeholder="unpaid break minutes">
      <button class="btn sm" data-act="savetype">Add shift type</button></div>
    <button class="btn sec" data-act="closesheet">Close</button>`);
}
function qrPoster() {
  const link = location.origin + location.pathname + "?site=" + (S.settings?.site_code || "");
  const src = "https://api.qrserver.com/v1/create-qr-code/?size=520x520&margin=12&data=" + encodeURIComponent(link);
  sheet(`<div style="font-weight:600;font-size:18px">Clock-in poster</div>
    <div style="background:#fff;border-radius:14px;padding:18px;text-align:center;color:#111">
      <div style="font:600 20px/1.2 var(--display);color:#111">La Habana</div>
      <div style="font:600 11px/1 var(--mono);letter-spacing:.24em;color:#8A6A1F;margin:4px 0 12px">STAFF CLOCK-IN</div>
      <img src="${src}" alt="Clock-in QR code" style="width:220px;height:220px">
      <div style="font:600 13px var(--body);margin-top:10px;color:#111">Scan to clock in or out</div>
      <div style="font:400 11px var(--body);color:#555">Staff only</div>
    </div>
    <p class="xs mut" style="margin:0">Take a screenshot and print it, or leave this open on a spare phone by the staff door.</p>
    <button class="btn sec" data-act="closesheet">Close</button>`);
}
function csvExport(){
  const from = S.week + "T00:00:00Z", to = addDays(S.week, 7) + "T00:00:00Z";
  sb.from("shifts").select("*").gte("started_at", from).lt("started_at", to).order("started_at").then(({ data }) => {
    const rows = [["Name", "Date", "In", "Out", "Hours", "Auto-closed", "Edited", "Reason"]].concat((data || []).map(s => {
      const mins = s.ended_at ? (new Date(s.ended_at) - new Date(s.started_at)) / 60000 : 0;
      return [person(s.user_id).display_name, s.started_at.slice(0, 10), fmtTime(s.started_at),
        s.ended_at ? fmtTime(s.ended_at) : "", (mins / 60).toFixed(2), s.auto_closed ? "yes" : "", s.edited_by ? "yes" : "", s.edit_reason || ""];
    }));
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "la-habana-hours-" + S.week + ".csv"; a.click();
  });
}
 
/* ---------- every tap in the app --------------------------------------- */
document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  if (el.classList.contains("sheet") && e.target.closest("[data-stop]")) return;
  const act = el.dataset.act, v = el.dataset.v;
  const parts = (v || "").split("|");
 
  switch (act) {
    case "tab": S.chat = null; if (el.dataset.sub) { S.shiftsTab = el.dataset.sub; S.reportTab = el.dataset.sub; } S.tab = v; return render();
    case "stab": S.shiftsTab = v; return viewShifts();
    case "rtab": S.reportTab = v; return viewReport();
    case "day": S.day = v; return viewShifts();
    case "week": S.week = addDays(S.week, Number(v)); if (S.day < S.week || S.day > addDays(S.week, 6)) S.day = S.week; return viewShifts();
    case "closesheet": return closeSheet();
    case "profile": return profileSheet();
    case "settings": closeSheet(); return settingsSheet();
    case "staff": return staffSheet();
    case "shifttypes": return shiftTypesSheet();
    case "qrposter": return qrPoster();
    case "signout": await sb.auth.signOut(); location.reload(); return;
    case "reload": return location.reload();
 
    case "scan": return startScan();
    case "photo": return showPhoto(v);
    case "fixshift": return fixShiftSheet();
    case "msgmanager": {
      const mgr = S.people.find(p => p.role === "manager" || p.role === "owner");
      closeSheet(); S.tab = "chat"; S.chat = mgr ? mgr.id : "all"; return render();
    }
 
    case "loyalty": {
      const url = S.settings && S.settings.loyalty_url;
      if (!url) return toast(isOwner() ? "Add the loyalty link in Settings." : "The owner hasn't added the loyalty link yet.", true);
      return window.open(url, "_blank", "noopener");
    }
    case "reportwhat":
      return sheet(`<div style="font-weight:600;font-size:18px">Report something</div>
        <button class="btn" data-act="newincident">Incident</button>
        <button class="btn sec" data-act="newjob">Broken or faulty</button>`);
    case "newincident": return newIncidentSheet();
    case "kind": return setKind(v);
    case "saveincident": return saveIncident();
    case "newjob": return newJobSheet();
    case "savejob": return saveJob();
    case "job": return jobSheet(v);
    case "jobstat": return jobStatus(parts[0], parts[1]);
    case "jobfix": return jobFix(v);
    case "review": {
      const { error } = await sb.from("incidents").update({ reviewed_by: S.me.id, reviewed_at: new Date().toISOString() }).eq("id", v);
      if (error) return toast(error.message, true);
      toast("Marked reviewed."); return render();
    }
 
    case "assign": return assignSheet(v);
    case "saveassign": return saveAssign(v);
    case "unassign": {
      const { error } = await sb.from("schedule").delete().eq("id", v);
      if (error) return toast(error.message, true);
      closeSheet(); return render();
    }
    case "copyweek": return copyWeek();
    case "publish": {
      const { data, error } = await sb.rpc("publish_week", { p_week: S.week });
      if (error) return toast(error.message, true);
      toast(data.message, !data.ok); return render();
    }
    case "dayoff": return dayOffSheet();
    case "savedayoff": {
      const { error } = await sb.from("day_off").insert({ user_id: S.me.id, day: $("dday").value, reason: $("dwhy").value.trim() || null });
      if (error) return toast(error.message, true);
      closeSheet(); return toast("Sent to your manager.");
    }
    case "requests": return requestsSheet();
    case "decide": {
      const { error } = await sb.from("day_off").update({ status: parts[1], decided_by: S.me.id, decided_at: new Date().toISOString() }).eq("id", parts[0]);
      if (error) return toast(error.message, true);
      toast(parts[1] === "approved" ? "Approved." : "Declined."); return requestsSheet();
    }
 
    case "newpost": return newPostSheet();
    case "savepost": {
      const title = $("pt").value.trim();
      if (!title) return toast("Give the post a title.", true);
      const { error } = await sb.from("posts").insert({
        kind: $("pk").value, title, body: $("pb").value.trim() || null,
        meta: $("pl").value.trim() ? { line: $("pl").value.trim() } : {},
        pinned: $("ppin").checked, must_read: $("pmust").checked,
        until: $("pu").value || null, created_by: S.me.id
      });
      if (error) return toast(error.message, true);
      closeSheet(); toast("Posted."); return render();
    }
    case "gotit": {
      const { error } = await sb.from("post_reads").insert({ post_id: v, user_id: S.me.id });
      if (error && error.code !== "23505") return toast(error.message, true);
      toast("Thanks — the manager can see you read it."); return render();
    }
    case "whoread": return whoRead(v);
    case "delpost": {
      const { error } = await sb.from("posts").delete().eq("id", v);
      if (error) return toast(error.message, true);
      return render();
    }
 
    case "openchat": S.chat = v; return viewChat();
    case "chatback": S.chat = null; return viewChat();
 
    case "editshift": return editShiftSheet(v);
    case "saveshift": return saveShift(v);
    case "csv": return csvExport();
 
    case "saveprofile": {
      const patch = { display_name: $("mdn").value.trim(), phone: $("mph").value.trim() };
      const { error } = await sb.from("profiles").update(patch).eq("id", S.me.id);
      if (error) return toast(error.message, true);
      Object.assign(S.me, patch); closeSheet(); toast("Saved."); return render();
    }
    case "hereloc": {
      const c = await getLocation();
      if (!c) return toast("Couldn't read your location. Turn location on.", true);
      $("vlat").value = c.latitude.toFixed(6); $("vlng").value = c.longitude.toFixed(6);
      return toast("Location filled in — now press Save settings.");
    }
    case "savesettings": {
      const patch = {
        venue_name: $("vn").value.trim(),
        venue_lat: parseFloat($("vlat").value) || null,
        venue_lng: parseFloat($("vlng").value) || null,
        radius_m: parseInt($("vrad").value, 10) || 150,
        loyalty_url: $("vloy").value.trim() || null,
        areas: $("vareas").value.split("\n").map(x => x.trim()).filter(Boolean),
        positions: $("vpos").value.split("\n").map(x => x.trim()).filter(Boolean),
        updated_at: new Date().toISOString()
      };
      const { error } = await sb.from("settings").update(patch).eq("id", 1);
      if (error) return toast(error.message, true);
      Object.assign(S.settings, patch); closeSheet(); toast("Settings saved."); return render();
    }
    case "newcode": {
      const code = Array.from(crypto.getRandomValues(new Uint8Array(9))).map(b => b.toString(16).padStart(2, "0")).join("");
      const { error } = await sb.from("settings").update({ site_code: code }).eq("id", 1);
      if (error) return toast(error.message, true);
      S.settings.site_code = code; toast("New code made. Print the new QR."); return settingsSheet();
    }
    case "saveperson": {
      const role = document.querySelector(`[data-role-for="${v}"]`).value;
      const pos = document.querySelector(`[data-pos-for="${v}"]`).value || null;
      const { error } = await sb.from("profiles").update({ role, position: pos }).eq("id", v);
      if (error) return toast(error.message, true);
      toast("Saved."); return staffSheet();
    }
    case "toggleperson": {
      const { error } = await sb.from("profiles").update({ active: parts[1] === "on" }).eq("id", parts[0]);
      if (error) return toast(error.message, true);
      return staffSheet();
    }
    case "savetype": {
      const name = $("tn").value.trim();
      if (!name) return toast("Name it first.", true);
      const { error } = await sb.from("shift_types").insert({
        name, starts: $("ts").value, ends: $("te").value, break_min: parseInt($("tb").value, 10) || 0, sort: S.types.length + 1
      });
      if (error) return toast(error.message, true);
      const { data } = await sb.from("shift_types").select("*").order("sort");
      S.types = data || []; return shiftTypesSheet();
    }
    case "deltype": {
      const { error } = await sb.from("shift_types").delete().eq("id", v);
      if (error) return toast(error.message, true);
      S.types = S.types.filter(t => t.id !== v); return shiftTypesSheet();
    }
    case "forgot": {
      const email = ($("em") && $("em").value.trim()) || "";
      if (!email) return toast("Type your email first, then tap this.", true);
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href });
      return toast(error ? error.message : "Check your email for a reset link.", !!error);
    }
  }
});
 
