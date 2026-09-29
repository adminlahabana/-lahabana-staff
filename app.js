/* =====================================================================
   La Habana Staff — app
   Talks to Supabase. Every rule that matters (who sees what, where you
   can clock in from, what time it is) is enforced by the database.
   ===================================================================== */
"use strict";
 
/* Accepts what people actually paste: a trailing slash, the dashboard link,
   or the project URL with something stuck on the end. */
function cleanProjectUrl(raw) {
  var u = String(raw || "").trim().replace(/\s+/g, "").replace(/\/+$/, "");
  var m = u.match(/dashboard\/project\/([a-z0-9]{10,})/i);          // dashboard link
  if (m) return "https://" + m[1] + ".supabase.co";
  m = u.match(/([a-z0-9]{10,})\.supabase\.(co|in|net)/i);           // any project address
  if (m) return "https://" + m[0].toLowerCase();
  if (/^[a-z0-9]{15,}$/i.test(u)) return "https://" + u + ".supabase.co"; // bare project ref
  return u;
}
window.LH.SUPABASE_URL = cleanProjectUrl(window.LH.SUPABASE_URL);
window.LH.SUPABASE_ANON_KEY = String(window.LH.SUPABASE_ANON_KEY || "").trim();
 
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
 
const fmtDate = iso => iso
  ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(iso + "T12:00:00Z"))
  : "";
const daysTo = iso => iso == null || iso === "" ? null
  : Math.round((new Date(iso + "T12:00:00Z") - new Date(todayISO() + "T12:00:00Z")) / 86400000);
/* a red or amber flag next to a date that is gone or nearly gone */
function expChip(iso) {
  const d = daysTo(iso);
  if (d === null) return "";
  if (d < 0) return ' <span class="chip bad">Expired</span>';
  if (d === 0) return ' <span class="chip bad">Today</span>';
  if (d <= 30) return ` <span class="chip bad">${d} day${d === 1 ? "" : "s"} left</span>`;
  if (d <= 90) return ` <span class="chip warn">${d} days left</span>`;
  return "";
}
const DOCS = [["id_expiry", "ID / Passport"], ["insurance_expiry", "Insurance"], ["permit_expiry", "Work permit"]];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const BELL = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/></svg>';
 
/* ---------- state ---------------------------------------------------- */
const S = {
  me: null, people: [], settings: null, types: [],
  tab: "home", shiftsTab: "clock", reportTab: "incidents",
  day: todayISO(), week: mondayOf(todayISO()), chat: null,
  unread: 0, cache: {}, busy: false, pendingSite: null,
  hr: null, hrReady: true, alerts: [],
  threadUnread: {}, reads: {}, readsReady: true, lastReadWrite: 0,
  payRun: null, payRunRow: null, paySlips: [], slipOpen: null, mySlips: [], personSlips: [], newRun: null, recalc: null
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
/* Nothing is allowed to hang forever: if Supabase doesn't answer, we say so. */
function withTimeout(p, ms, label) {
  return Promise.race([
    Promise.resolve(p),
    new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error(label || "Supabase didn't answer in " + Math.round(ms / 1000) + " seconds")); }, ms);
    })
  ]);
}
 
/* ---------- start up -------------------------------------------------- */
(async function start() {
  if (!window.LH.SUPABASE_URL || window.LH.SUPABASE_URL.includes("PASTE")) {
    screenEl().innerHTML = '<div class="center"><h2 class="title">Almost there</h2>' +
      '<p class="mut">Open <b>config.js</b> and paste your Supabase project URL and anon key, then reload.</p></div>';
    return;
  }
  const params = new URLSearchParams(location.search);
  if (params.get("site")) { S.pendingSite = params.get("site"); history.replaceState({}, "", location.pathname); }
  let session = null;
  try {
    const res = await withTimeout(sb.auth.getSession(), 8000, "getSession timed out");
    session = res && res.data && res.data.session;
  } catch (e) { session = null; }
  if (session) await boot(); else renderSignIn();
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
      '<p class="sm" style="margin:0">• The project is paused or still starting — open it in Supabase and press Restore.</p>' +
      '<p class="sm" style="margin:0">• Your phone lost the internet halfway through.</p>' +
      '<p class="xs mono mut" style="margin:0;overflow-wrap:anywhere">' + esc(e && e.message ? e.message : e) + '</p></div>' +
      '<button class="btn" data-act="reload">Try again</button>' +
      '<button class="btn sec" data-act="signout">Sign out</button></div>';
  }
}
async function bootInner() {
  screenEl().innerHTML = spinner;
  const { data: { user } } = await withTimeout(sb.auth.getUser(), 12000, "Supabase didn't answer when checking who you are.");
  if (!user) return renderSignIn();
  const [{ data: prof }, { data: people }, { data: settings }, { data: types }] = await withTimeout(Promise.all([
    sb.from("profiles").select("*").eq("id", user.id).maybeSingle(),
    sb.from("profiles").select("*").order("display_name"),
    sb.from("settings").select("*").eq("id", 1).maybeSingle(),
    sb.from("shift_types").select("*").order("sort")
  ]), 15000, "Supabase didn't answer when loading your staff list.");
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
  await loadHr();
  await loadReads();
  await refreshUnread().catch(() => {});
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
  if (low.indexOf("invalid path") > -1 || low.indexOf("not found") > -1 || low.indexOf("failed to fetch") > -1) {
    return sheet('<div style="font-weight:600;font-size:18px">The address in config.js is wrong</div>' +
      '<p class="sm mut" style="margin:0">The app is reaching Supabase but knocking on the wrong door. It is currently using:</p>' +
      '<p class="sm mono" style="margin:0;overflow-wrap:anywhere">' + esc(window.LH.SUPABASE_URL) + '</p>' +
      '<p class="sm" style="margin:0">It has to be the <b>Project URL</b> from Supabase → <b>Project Settings → API</b>, which looks like:</p>' +
      '<p class="sm mono" style="margin:0">https://abcdefghijklmnop.supabase.co</p>' +
      '<p class="sm mut" style="margin:0">Not the dashboard link you browse with, and with nothing after <b>.co</b> — no slash, no /rest/v1.</p>' +
      '<p class="sm mut" style="margin:0">Fix the SUPABASE_URL line in <b>config.js</b> on GitHub, commit, then reload here.</p>' +
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
 
/* ---------- your own employment record -------------------------------- */
/* Lives in its own table so nobody reads anybody else's passport dates.
   If the update-1.sql script hasn't been run yet, the app carries on
   without it instead of breaking. */
async function loadHr() {
  try {
    const { data, error } = await sb.from("staff_hr").select("*").eq("user_id", S.me.id).maybeSingle();
    if (error) { S.hrReady = false; S.hr = null; return; }
    S.hrReady = true; S.hr = data || {};
  } catch (e) { S.hrReady = false; S.hr = null; }
}
 
/* ---------- unread messages, per conversation -------------------------- */
/* A thread is "all" (everyone) or the other person's id. What you have read
   is remembered in the database, so the count is the same on every device. */
const threadKey = m => m.recipient ? (m.sender === S.me.id ? m.recipient : m.sender) : "all";
const threadName = k => k === "all" ? "All staff" : (person(k).display_name || "Someone");
const totalUnread = () => Object.keys(S.threadUnread).reduce((n, k) => n + (S.threadUnread[k] || 0), 0);
 
async function loadReads() {
  try {
    const { data, error } = await sb.from("chat_reads").select("*").eq("user_id", S.me.id);
    if (error) { S.readsReady = false; return; }
    S.readsReady = true; S.reads = {};
    (data || []).forEach(r => { S.reads[r.thread] = r.last_read_at; });
  } catch (e) { S.readsReady = false; }
}
/* Counts what arrived after you last opened each conversation. A conversation
   you have never opened only counts the last three days, so nobody comes back
   from leave to a badge of 200. */
async function refreshUnread() {
  if (!S.readsReady) return;
  const { data, error } = await sb.from("messages").select("id,sender,recipient,created_at")
    .order("created_at", { ascending: false }).limit(400);
  if (error) return;
  const fresh = new Date(Date.now() - 3 * 86400e3).toISOString();
  const counts = {};
  (data || []).forEach(m => {
    if (m.sender === S.me.id) return;
    const k = threadKey(m);
    const seen = S.reads[k];
    if (m.created_at <= (seen || fresh)) return;
    counts[k] = (counts[k] || 0) + 1;
  });
  S.threadUnread = counts;
  S.unread = totalUnread();
}
async function markRead(key) {
  const had = S.threadUnread[key] || 0;
  S.threadUnread[key] = 0;
  S.unread = totalUnread();
  paintTabs();
  S.alerts = S.alerts.filter(a => !(a.act === "chat" && a.v === key));
  paintBell();
  if (!S.readsReady) return;
  if (!had && Date.now() - S.lastReadWrite < 8000) return;   // don't write on every keystroke of a live chat
  S.lastReadWrite = Date.now();
  const at = new Date().toISOString();
  S.reads[key] = at;
  try { await sb.from("chat_reads").upsert({ user_id: S.me.id, thread: key, last_read_at: at }, { onConflict: "user_id,thread" }); }
  catch (e) { /* a lost read marker is not worth an error message */ }
}
 
/* ---------- shell ----------------------------------------------------- */
function head(title) {
  return `<div class="apphead">
      <button class="avatarbtn" data-act="profile" aria-label="Your profile">
        <span class="avatar">${esc(initials(S.me.display_name))}</span></button>
      <div class="wordmark">La Habana<span>Staff</span></div>
      <button class="bell${S.alerts.length ? " has" : ""}" data-act="alerts"
        aria-label="${S.alerts.length ? S.alerts.length + " new notifications" : "Notifications"}">${BELL}${
        S.alerts.length ? `<span class="dot">${S.alerts.length > 9 ? "9+" : S.alerts.length}</span>` : ""}</button>
    </div>${title ? `<h2 class="title">${esc(title)}</h2>` : ""}`;
}
function paintBell() {
  const b = document.querySelector(".bell");
  if (!b) return;
  const n = S.alerts.length;
  b.innerHTML = BELL + (n ? `<span class="dot">${n > 9 ? "9+" : n}</span>` : "");
  b.className = "bell" + (n ? " has" : "");
  b.setAttribute("aria-label", n ? n + " new notifications" : "Notifications");
}
function paintTabs() {
  const tabs = [["home", "Home", "⌂"], ["shifts", "Shifts", "◷"], ["report", "Report", "✎"],
    ["board", "Board", "▤"], ["chat", "Chat", "✉"]].concat(isMgr() ? [["manage", "Manage", "⚙"]] : []);
  $("tabbar").style.gridTemplateColumns = "repeat(" + tabs.length + ",1fr)";
  $("tabbar").innerHTML = tabs.map(t => {
    const n = t[0] === "chat" ? S.unread : 0;
    return `<button data-act="tab" data-v="${t[0]}" aria-pressed="${S.tab === t[0] || (t[0] === "manage" && S.tab === "payroll")}">
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
    else if (S.tab === "manage") await viewManage();
    else if (S.tab === "payroll") await viewPayroll();
    refreshAlerts().then(paintBell, () => {});
  } catch (err) {
    screenEl().innerHTML = head("Something went wrong") +
      `<div class="card stack"><p class="sm">${esc(err.message || err)}</p>
       <button class="btn sec" data-act="tab" data-v="${S.tab}">Try again</button></div>`;
  }
}
 
/* ---------- the bell: what needs your attention ----------------------- */
let alertsAt = 0;
async function refreshAlerts(force) {
  if (!force && Date.now() - alertsAt < 45000) return S.alerts;
  const items = [];
  await refreshUnread().catch(() => {});
  Object.keys(S.threadUnread).forEach(k => {
    const n = S.threadUnread[k];
    if (n) items.push({ ic: "✉", t: threadName(k) + " — " + n + " new message" + (n > 1 ? "s" : ""), s: "Chat", act: "chat", v: k });
  });
 
  const [posts, reads] = await Promise.all([
    sb.from("posts").select("id,title,kind,must_read,created_at").order("created_at", { ascending: false }).limit(20),
    sb.from("post_reads").select("post_id").eq("user_id", S.me.id)
  ]);
  const readIds = new Set(((reads && reads.data) || []).map(r => r.post_id));
  ((posts && posts.data) || []).filter(p => p.must_read && !readIds.has(p.id)).forEach(p =>
    items.push({ ic: "▤", t: p.title, s: "Must read · " + p.kind, act: "tab", v: "board" }));
 
  if (S.hr) DOCS.concat([["contract_end", "Contract"]]).forEach(d => {
    const n = daysTo(S.hr[d[0]]);
    if (n !== null && n <= 45) items.push({
      ic: "!", t: "Your " + d[1].toLowerCase() + (n < 0 ? " has expired" : n === 0 ? " expires today" : " expires in " + n + " day" + (n === 1 ? "" : "s")),
      s: fmtDate(S.hr[d[0]]), act: "profile"
    });
  });
 
  /* a payslip published in the last two weeks that you haven't opened on this phone */
  try {
    const { data: slips, error } = await sb.from("payslips").select("id, pay_runs(label,status,published_at)").eq("user_id", S.me.id);
    if (!error) (slips || []).forEach(p => {
      const r = p.pay_runs;
      if (!r || r.status !== "published" || !r.published_at) return;
      if (Date.now() - new Date(r.published_at) > 14 * 86400e3) return;
      let seen = false; try { seen = !!localStorage.getItem("lh-slip-" + p.id); } catch (e) { /* private mode */ }
      if (!seen) items.push({ ic: "Rf", t: "Your payslip for " + r.label + " is ready", s: "Tap to open it", act: "payslip", v: p.id });
    });
  } catch (e) { /* payroll not switched on yet */ }

  if (isMgr()) {
    const [inc, reqs, jobs, hrAll] = await Promise.all([
      sb.from("incidents").select("id").is("reviewed_at", null),
      sb.from("day_off").select("id").eq("status", "pending"),
      sb.from("jobs").select("id").eq("priority", "Urgent").neq("status", "Fixed"),
      S.hrReady ? sb.from("staff_hr").select("*") : Promise.resolve({ data: [] })
    ]);
    const { data: openNow } = await sb.from("shifts").select("*").is("ended_at", null);
    (openNow || []).forEach(o => {
      const mins = (Date.now() - new Date(o.started_at)) / 60000;
      if (mins > 10 * 60) items.push({
        ic: "◷", t: (person(o.user_id).display_name || "Someone") + " is still clocked in — " + hours(mins),
        s: "Probably forgot. Tap to clock them out.", act: "tab", v: "shifts", sub: "timesheet"
      });
    });
    const n1 = ((inc && inc.data) || []).length, n2 = ((reqs && reqs.data) || []).length, n3 = ((jobs && jobs.data) || []).length;
    if (n1) items.push({ ic: "✎", t: n1 + " incident" + (n1 > 1 ? "s" : "") + " to review", s: "Report", act: "tab", v: "report" });
    if (n2) items.push({ ic: "◷", t: n2 + " day-off request" + (n2 > 1 ? "s" : ""), s: "Waiting for you", act: "requests" });
    if (n3) items.push({ ic: "!", t: n3 + " urgent job" + (n3 > 1 ? "s" : "") + " still open", s: "Maintenance", act: "tab", v: "report", sub: "maintenance" });
    ((hrAll && hrAll.data) || []).forEach(h => {
      if (h.user_id === S.me.id) return;
      DOCS.concat([["contract_end", "Contract"]]).forEach(d => {
        const n = daysTo(h[d[0]]);
        if (n !== null && n <= 45) items.push({
          ic: "!", t: (person(h.user_id).display_name || "Someone") + " — " + d[1].toLowerCase() + (n < 0 ? " expired" : " expires in " + n + " day" + (n === 1 ? "" : "s")),
          s: fmtDate(h[d[0]]), act: "docs"
        });
      });
    });
  }
  S.alerts = items; alertsAt = Date.now();
  return items;
}
/* keep the bell honest between refreshes, without another round trip */
function chatAlerts() {
  S.alerts = S.alerts.filter(a => a.act !== "chat");
  Object.keys(S.threadUnread).forEach(k => {
    const n = S.threadUnread[k];
    if (n) S.alerts.unshift({ ic: "\u2709", t: threadName(k) + " — " + n + " new message" + (n > 1 ? "s" : ""), s: "Chat", act: "chat", v: k });
  });
  paintBell();
}
function alertsSheet() {
  const list = S.alerts;
  sheet(`<div style="font-weight:600;font-size:18px">Notifications</div>
    ${list.length ? list.map((a, i) => `<button class="listitem" data-act="alertgo" data-v="${i}">
        <span class="avatar sm">${esc(a.ic)}</span>
        <span class="sm">${esc(a.t)}<br><span class="xs mut">${esc(a.s || "")}</span></span>
        <span class="chip">Open</span></button>`).join("")
      : '<p class="sm mut" style="margin:0">Nothing new. Everything is read and nothing is waiting on you.</p>'}
    <button class="btn sec" data-act="refreshalerts">Check again</button>
    <button class="btn sec" data-act="closesheet">Close</button>`);
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
      <button class="tile" data-act="tab" data-v="manage"><span class="lbl">Manage</span><span class="sm mut">Venue, staff, shifts</span></button></div>`;
  }
 
  screenEl().innerHTML = head("Good evening, " + (S.me.display_name || "").split(" ")[0]) + `
    ${isOwner() ? "" : open ? `<div class="card stack">
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
  const tabs = (isOwner() ? [] : [["clock", "Clock"]]).concat([["schedule", "Schedule"]], isMgr() ? [["timesheet", "Timesheet"]] : []);
  if (!tabs.some(t => t[0] === S.shiftsTab)) S.shiftsTab = tabs[0][0];
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
  const [{ data: shifts }, { data: sched }, { data: rejected }, { data: openNow }] = await Promise.all([
    sb.from("shifts").select("*").gte("started_at", from).lt("started_at", to).order("started_at"),
    sb.from("schedule").select("*").eq("week_start", S.week),
    sb.from("punches").select("*").eq("accepted", false).gte("at", addDays(todayISO(), -30) + "T00:00:00Z").order("at", { ascending: false }).limit(20),
    sb.from("shifts").select("*").is("ended_at", null).order("started_at")
  ]);
  const stillIn = (openNow || []).map(s => {
    const mins = (Date.now() - new Date(s.started_at)) / 60000;
    const long = mins > 10 * 60;
    return `<div class="listitem${long ? " flagged" : ""}">
      <span class="avatar sm">${esc(initials(person(s.user_id).display_name))}</span>
      <span class="sm">${esc(person(s.user_id).display_name)}<br>
        <span class="xs mut">In since ${fmtDayTime(s.started_at)} · ${hours(mins)}${long ? " · probably forgot" : ""}</span></span>
      <button class="chip gold" data-act="forceout" data-v="${s.id}">Clock out</button></div>`;
  }).join("");
  const rows = S.people.filter(p => p.role !== "owner").map(p => {
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
    ${stillIn ? `<h3 class="sec" style="margin-top:0">On shift now</h3><div class="stack">${stillIn}</div>` : ""}
    <h3 class="sec">${stillIn ? "This week" : ""}</h3>
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
      const k = threadKey(m);
      const inThisThread = S.tab === "chat" && S.chat === k;
      if (inThisThread) viewChat();
      else {
        S.threadUnread[k] = (S.threadUnread[k] || 0) + 1;
        S.unread = totalUnread();
        paintTabs(); chatAlerts(); if (S.tab === "chat") viewChat();
      }
    }).subscribe();
}
async function viewChat() {
  const { data, error } = await sb.from("messages").select("*").order("created_at", { ascending: false }).limit(300);
  if (error) throw error;
  const msgs = (data || []).slice().reverse();
  if (!S.chat) {
    paintTabs();
    const threads = [{ id: "all", name: "All staff" }].concat(
      S.people.filter(p => p.id !== S.me.id).map(p => ({ id: p.id, name: p.display_name })));
    /* newest conversation first, but All staff always on top */
    const lastOf = t => {
      const list = t.id === "all" ? msgs.filter(m => !m.recipient)
        : msgs.filter(m => m.recipient && (m.sender === t.id || m.recipient === t.id));
      return list[list.length - 1];
    };
    threads.sort((a, b) => {
      if (a.id === "all") return -1; if (b.id === "all") return 1;
      const la = lastOf(a), lb = lastOf(b);
      return (lb ? lb.created_at : "").localeCompare(la ? la.created_at : "");
    });
    screenEl().innerHTML = head("Chat") + `<div class="stack">${threads.map(t => {
      const last = lastOf(t);
      const n = S.threadUnread[t.id] || 0;
      return `<button class="listitem${n ? " unread" : ""}" data-act="openchat" data-v="${t.id}">
        <span class="avatar sm">${t.id === "all" ? "★" : esc(initials(t.name))}</span>
        <span class="sm">${esc(t.name)}<br><span class="xs mut">${last ? esc(last.body.slice(0, 40)) : "No messages yet"}</span></span>
        <span class="tail">${n ? `<span class="count">${n > 99 ? "99+" : n}</span>` : ""}
          <span class="xs mut mono">${last ? fmtTime(last.created_at) : ""}</span></span></button>`;
    }).join("")}</div>
    <p class="note" style="margin-top:16px">Everyone is in All staff. A private message is only seen by the two of you.</p>`;
    return;
  }
  markRead(S.chat);
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
  if (isOwner()) return toast("The owner doesn't clock in or out.");
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
/* A manager closing a shift somebody forgot to close. The original start is
   untouched, the correction is signed, and the reason is kept for good. */
async function forceOutSheet(id) {
  const { data: sh } = await sb.from("shifts").select("*").eq("id", id).maybeSingle();
  if (!sh) return toast("That shift is already closed.", true);
  const p = person(sh.user_id);
  const mins = (Date.now() - new Date(sh.started_at)) / 60000;
  /* what the schedule says they should have finished today */
  const { data: sc } = await sb.from("schedule").select("*").eq("user_id", sh.user_id)
    .gte("day", sh.started_at.slice(0, 10)).lte("day", todayISO()).order("day", { ascending: false }).limit(1);
  const row = (sc || [])[0];
  const type = row && S.types.find(t => t.id === row.type_id);
  const endStr = type ? type.ends : (row && row.ends) || "";
  let planned = "";
  if (endStr) {
    const startDay = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(sh.started_at));
    const [h] = endStr.split(":").map(Number);
    const startHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date(sh.started_at)));
    const day = h < startHour ? addDays(startDay, 1) : startDay;   // a shift that ends after midnight
    planned = day + "T" + endStr.slice(0, 5);
    const at = new Date(planned + ":00+05:00");
    if (!(at > new Date(sh.started_at) && at.getTime() <= Date.now() + 60000)) planned = "";  // only offer it if it makes sense
  }
  const localNow = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 16);
  sheet(`<div style="font-weight:600;font-size:18px">Clock out ${esc(p.display_name)}</div>
    <div class="sm mut">Clocked in ${fmtDayTime(sh.started_at)} — that is ${hours(mins)} ago.</div>
    <label class="lbl">When did they actually finish?</label>
    <div class="row">
      <button class="chip gold" data-act="outpick" data-v="${localNow}">Now</button>
      ${planned ? `<button class="chip" data-act="outpick" data-v="${planned}">Scheduled finish ${hhmm(endStr)}</button>` : ""}
    </div>
    <input id="oe" type="datetime-local" value="${planned || localNow}">
    <label class="lbl" for="or">Why are you clocking them out?</label>
    <input id="or" value="Forgot to clock out" placeholder="Forgot to clock out — checked with the manager on duty">
    <button class="btn" data-act="saveforceout" data-v="${id}">Clock them out</button>
    <p class="xs mut" style="margin:0">Your name and this reason are saved with the shift, and the hours change on the timesheet.</p>
    <button class="btn sec" data-act="closesheet">Cancel</button>`);
}
async function saveForceOut(id) {
  const reason = $("or").value.trim();
  if (!reason) return toast("Put a reason — it stays on the record.", true);
  const val = $("oe").value;
  if (!val) return toast("Pick the finishing time.", true);
  const ended = new Date(val + ":00+05:00");
  const { data: sh } = await sb.from("shifts").select("*").eq("id", id).maybeSingle();
  if (!sh) return toast("That shift is already closed.", true);
  if (ended <= new Date(sh.started_at)) return toast("The finish has to be after " + fmtDayTime(sh.started_at) + ".", true);
  if (ended.getTime() > Date.now() + 60000) return toast("That time hasn't happened yet.", true);
  busy(true);
  const { error } = await sb.from("shifts").update({
    ended_at: ended.toISOString(), edited_by: S.me.id,
    edit_reason: reason, auto_closed: false
  }).eq("id", id);
  busy(false);
  if (error) return toast(error.message, true);
  closeSheet();
  toast(person(sh.user_id).display_name + " clocked out at " + fmtTime(ended) + ".");
  await refreshAlerts(true); paintBell();
  return render();
}
function fixShiftSheet() {
  sheet(`<div style="font-weight:600;font-size:18px">Forgot to clock out?</div>
    <p class="sm mut" style="margin:0">Send a manager a message with the time you actually finished — they can correct it on the timesheet.</p>
    <button class="btn" data-act="msgmanager">Message a manager</button>
    <button class="btn sec" data-act="closesheet">Close</button>`);
}
/* ---------- your profile ---------------------------------------------- */
const kv = (label, value, chip) =>
  `<div class="kv"><span class="xs mut">${esc(label)}</span><span class="sm">${value ? esc(value) : '<span class="mut">—</span>'}${chip || ""}</span></div>`;
 
async function profileSheet() {
  if (S.hrReady && !S.hr) await loadHr();
  const hr = S.hr || {};
  const roleName = S.me.role === "staff" ? "Staff" : S.me.role === "manager" ? "Manager" : "Owner";
  const dateRow = (label, iso) => kv(label, fmtDate(iso), expChip(iso));
  sheet(`<div class="row" style="gap:14px;align-items:center">
      <span class="avatar" style="width:52px;height:52px;font-size:17px">${esc(initials(S.me.display_name))}</span>
      <span><span style="font-weight:600;font-size:18px">${esc(S.me.full_name || S.me.display_name)}</span><br>
        <span class="sm mut">${esc(S.me.position || "No designation set")} · ${roleName}</span></span></div>
    ${kv("Employee ID", hr.employee_no || "")}
    <h3 class="sec" style="margin:14px 0 0">Details</h3>
    ${kv("Phone", S.me.phone || "")}
    ${kv("Contract start", fmtDate(hr.contract_start))}
    ${dateRow("Contract end", hr.contract_end)}
    ${kv("Available off day", hr.off_day || "")}
    <h3 class="sec" style="margin:14px 0 0">Documents</h3>
    ${DOCS.map(d => dateRow(d[1], hr[d[0]])).join("")}
    ${S.hrReady ? "" : `<p class="xs mut" style="margin:6px 0 0">Employment details aren't switched on yet${isOwner() ? " — run <b>update-1.sql</b> in Supabase → SQL Editor." : " — ask the owner."}</p>`}
    ${S.hrReady && isMgr() ? '<p class="xs mut" style="margin:6px 0 0">Managers fill these in under Manage → Staff.</p>'
      : S.hrReady ? '<p class="xs mut" style="margin:6px 0 0">Your manager keeps these up to date. Tell them if anything here is wrong.</p>' : ""}
    <button class="btn" data-act="mypayslips">My payslips</button>
    <button class="btn sec" data-act="editme">Edit my name and phone</button>
    <button class="btn sec" data-act="signout">Sign out</button>`);
}
function editMeSheet() {
  sheet(`<div style="font-weight:600;font-size:18px">Your name and phone</div>
    <label class="lbl" for="mdn">Short name staff will see</label><input id="mdn" value="${esc(S.me.display_name || "")}">
    <label class="lbl" for="mph">Phone</label><input id="mph" inputmode="tel" value="${esc(S.me.phone || "")}">
    <button class="btn" data-act="saveprofile">Save</button>
    <button class="btn sec" data-act="profile">Back</button>`);
}
 
/* ---------- manage (managers and the owner) --------------------------- */
async function viewManage() {
  const s = S.settings || {};
  const [inc, reqs, hrAll] = await Promise.all([
    sb.from("incidents").select("id").is("reviewed_at", null),
    sb.from("day_off").select("id").eq("status", "pending"),
    S.hrReady ? sb.from("staff_hr").select("*") : Promise.resolve({ data: [] })
  ]);
  const soon = ((hrAll && hrAll.data) || []).reduce((n, h) =>
    n + DOCS.concat([["contract_end", "Contract"]]).filter(d => { const x = daysTo(h[d[0]]); return x !== null && x <= 45; }).length, 0);
  screenEl().innerHTML = head("Manage") + `
    <h3 class="sec" style="margin-top:0">People</h3>
    <div class="grid2">
      <button class="tile" data-act="staff"><span class="lbl">Staff</span><span class="sm mut">${S.people.length} active · roles, details</span></button>
      <button class="tile" data-act="requests"><span class="lbl">${((reqs && reqs.data) || []).length} request${((reqs && reqs.data) || []).length === 1 ? "" : "s"}</span><span class="sm mut">Day off</span></button>
      <button class="tile" data-act="docs"><span class="lbl">Documents</span><span class="sm mut">${soon ? soon + " need attention" : "All in date"}</span></button>
      <button class="tile" data-act="shifttypes"><span class="lbl">Shift types</span><span class="sm mut">${S.types.length} set up</span></button>
    </div>
    <h3 class="sec">Tonight</h3>
    <div class="grid2">
      <button class="tile" data-act="tab" data-v="report"><span class="lbl">${((inc && inc.data) || []).length} to review</span><span class="sm mut">Incidents</span></button>
      <button class="tile" data-act="tab" data-v="shifts" data-sub="timesheet"><span class="lbl">Timesheet</span><span class="sm mut">Hours and corrections</span></button>
    </div>
    ${isOwner() ? `
      <h3 class="sec">Pay</h3>
      <div class="grid2">
        <button class="tile gold" data-act="payroll"><span class="lbl">Payroll</span><span class="sm mut">Months and payslips</span></button>
        <button class="tile" data-act="paysetup"><span class="lbl">Pay setup</span><span class="sm mut">Salaries, rates, allowances</span></button>
      </div>
      <h3 class="sec">Venue</h3>
      <div class="card stack">
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
      </div>
      <h3 class="sec">Clock-in code</h3>
      <div class="card stack">
        <div class="xs mono" style="overflow-wrap:anywhere">${esc(s.site_code || "")}</div>
        <div class="xs mut" style="overflow-wrap:anywhere">QR link: ${esc(location.origin + location.pathname + "?site=" + (s.site_code || ""))}</div>
        <button class="btn sec sm" data-act="qrposter">Show the QR poster</button>
        <button class="btn sec sm" data-act="newcode">New code (old QR stops working)</button>
      </div>` : ""}`;
}
async function docsSheet() {
  if (!S.hrReady) return toast("Run update-1.sql in Supabase first.", true);
  const { data } = await sb.from("staff_hr").select("*");
  const fields = DOCS.concat([["contract_end", "Contract end"]]);
  const rows = [];
  (data || []).forEach(h => fields.forEach(f => {
    const n = daysTo(h[f[0]]);
    if (n !== null && n <= 120) rows.push({ n, who: person(h.user_id).display_name, uid: h.user_id, what: f[1], iso: h[f[0]] });
  }));
  rows.sort((a, b) => a.n - b.n);
  sheet(`<div style="font-weight:600;font-size:18px">Documents</div>
    <p class="xs mut" style="margin:0">Anything expired or running out in the next four months.</p>
    ${rows.length ? rows.map(r => `<button class="listitem" data-act="hr" data-v="${r.uid}">
        <span class="avatar sm">${esc(initials(r.who))}</span>
        <span class="sm">${esc(r.who)} — ${esc(r.what.toLowerCase())}<br><span class="xs mut">${fmtDate(r.iso)}</span></span>
        ${expChip(r.iso) || '<span class="chip">' + r.n + ' days</span>'}</button>`).join("")
      : '<p class="sm mut" style="margin:0">Nothing expiring. Everyone is in date.</p>'}
    <button class="btn sec" data-act="closesheet">Close</button>`);
}
async function hrSheet(uid) {
  const p = person(uid);
  if (!S.hrReady) return toast("Run update-1.sql in Supabase first.", true);
  const { data } = await sb.from("staff_hr").select("*").eq("user_id", uid).maybeSingle();
  const h = data || {};
  const d = (id, label, val) => `<label class="lbl" for="${id}">${label}</label><input id="${id}" type="date" value="${val || ""}">`;
  sheet(`<div style="font-weight:600;font-size:18px">${esc(p.display_name || "Staff")}</div>
    <div class="sm mut">${esc(p.full_name || "")}</div>
    <label class="lbl" for="hno">Employee ID</label><input id="hno" value="${esc(h.employee_no || "")}" placeholder="LH-004">
    <label class="lbl" for="hpos">Designation</label>
    <select id="hpos"><option value="">none</option>${posOptions(p.position)}</select>
    <h3 class="sec" style="margin:14px 0 0">Details</h3>
    ${d("hcs", "Contract start", h.contract_start)}
    ${d("hce", "Contract end", h.contract_end)}
    <label class="lbl" for="hoff">Available off day</label>
    <select id="hoff"><option value="">not set</option>${DAYS.map(x => `<option${h.off_day === x ? " selected" : ""}>${x}</option>`).join("")}</select>
    <h3 class="sec" style="margin:14px 0 0">Documents</h3>
    ${d("hid", "ID / Passport expiry", h.id_expiry)}
    ${d("hins", "Insurance expiry", h.insurance_expiry)}
    ${d("hwp", "Work permit expiry", h.permit_expiry)}
    <label class="lbl" for="hnote">Note (managers only)</label><textarea id="hnote" rows="2">${esc(h.note || "")}</textarea>
    <button class="btn" data-act="savehr" data-v="${uid}">Save details</button>
    <button class="btn sec" data-act="staff">Back to staff</button>`);
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
        <button class="btn sec sm" data-act="hr" data-v="${p.id}">Details</button>
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
 
/* ---------- payroll (owner) and payslips (everyone) -------------------- */
/* Pay rates, pay runs and payslips live in their own tables (update-3-payroll.sql).
   The database does the sums and decides who sees what: only the owner sees
   anyone's pay, and staff see their own payslip only once the month is published. */
const money = n => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cur = run => (run && run.currency) || "MVR";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ADD_KINDS = ["Bonus", "Tips", "Arrears", "Other addition"];
const DED_KINDS = ["Salary advance", "No-pay leave", "Loan repayment", "Breakage", "Other deduction"];
const payMissing = err => {
  const m = ((err && (err.message || err.details)) || "").toLowerCase();
  return (err && (err.code === "42P01" || err.code === "PGRST205" || err.code === "PGRST202")) ||
    m.indexOf("does not exist") > -1 || m.indexOf("schema cache") > -1;
};
const payOff = () => `<div class="card stack"><span class="chip warn">Not switched on yet</span>
  <div class="big">Payroll needs one database update</div>
  <p class="sm mut" style="margin:0">Open Supabase → SQL Editor, paste <b>update-3-payroll.sql</b> and press Run. Run <b>update-2.sql</b> first if you haven't yet.</p></div>`;

/* The lines of a payslip, in the order they are printed. Used on screen and in the PDF. */
function slipLines(p) {
  const earn = [];
  if (p.pay_type === "hourly") earn.push(["Hours worked", money(p.hours) + " h x " + money(p.hourly_rate), p.basic]);
  else earn.push(["Basic salary", p.days_employed < p.days_in_period ? p.days_employed + " of " + p.days_in_period + " days" : "", p.basic]);
  if (Number(p.ot_pay)) earn.push([p.pay_type === "hourly" ? "Overtime premium" : "Overtime",
    money(p.ot_hours) + " h x " + money(p.ot_pay / p.ot_hours), p.ot_pay]);
  if (Number(p.holiday_pay)) earn.push(["Public holiday premium", money(p.holiday_hours) + " h x " + money(p.holiday_pay / p.holiday_hours), p.holiday_pay]);
  (p.allowances || []).forEach(a => earn.push([a.name + " allowance", "", a.amount]));
  if (Number(p.sc_share)) earn.push(["Service charge share", p.days_worked ? p.days_worked + " day" + (p.days_worked === 1 ? "" : "s") + " worked" : "", p.sc_share]);
  (p.additions || []).forEach(a => earn.push([a.name, "", a.amount]));
  const ded = (p.deductions || []).map(d => [d.name, "", d.amount]);
  return { earn, ded };
}
const paySet = x => !!x && (x.pay_type === "hourly" ? Number(x.hourly_rate) > 0 : Number(x.basic_salary) > 0);
/* staff (not the owner) whose salary or hourly rate hasn't been entered */
async function payMissingPeople() {
  const { data } = await sb.from("pay_profiles").select("*");
  return S.people.filter(p => p.role !== "owner" && !paySet((data || []).find(x => x.user_id === p.id)));
}
function missingPaySheet(people, act, label) {
  sheet(`<div style="font-weight:600;font-size:18px">Pay not entered for ${people.length}</div>
    <p class="sm mut" style="margin:0">${esc(people.map(p => p.display_name).join(", "))} ${people.length === 1 ? "has" : "have"} no salary or hourly rate yet.</p>
    <p class="sm mut" style="margin:0">They still get a payslip with their days, service charge share and allowances, but basic pay shows 0.00 until you enter it and recalculate.</p>
    <button class="btn" data-act="${act}" data-v="force">${label}</button>
    <button class="btn sec" data-act="paysetup">Enter their pay first</button>`);
}
const maskAcct = a => a ? (String(a).length > 4 ? "****" + String(a).slice(-4) : String(a)) : "";

/* ---- the Payroll screen (Manage → Payroll) ---- */
async function viewPayroll() {
  if (!isOwner()) { S.tab = isMgr() ? "manage" : "home"; paintTabs(); return isMgr() ? viewManage() : viewHome(); }
  const back = `<button class="chip" data-act="tab" data-v="manage" style="margin-bottom:12px">‹ Manage</button>`;
  if (S.payRun) return payRunView(back);
  const [runs, slips, profs] = await Promise.all([
    sb.from("pay_runs").select("*").order("period_start", { ascending: false }),
    sb.from("payslips").select("run_id,net"),
    sb.from("pay_profiles").select("user_id,pay_type,basic_salary,hourly_rate,active")
  ]);
  if (runs.error) {
    if (payMissing(runs.error)) { screenEl().innerHTML = head("Payroll") + back + payOff(); return; }
    throw runs.error;
  }
  const set = (profs.data || []).filter(p => p.active && paySet(p));
  const notSet = S.people.filter(p => p.role !== "owner" && !set.some(x => x.user_id === p.id));
  const byRun = {};
  (slips.data || []).forEach(s => { const r = byRun[s.run_id] || (byRun[s.run_id] = { n: 0, net: 0 }); r.n++; r.net += Number(s.net); });
  screenEl().innerHTML = head("Payroll") + back + `
    <button class="btn" data-act="newrun">Start a new month</button>
    <div class="grid2" style="margin-top:10px">
      <button class="tile" data-act="paysetup"><span class="lbl">Pay setup</span><span class="sm mut">${set.length} set up${notSet.length ? " · " + notSet.length + " not set" : ""}</span></button>
      <button class="tile" data-act="paysettings"><span class="lbl">Rules</span><span class="sm mut">Overtime, holidays, payslip header</span></button>
      <button class="tile" data-act="findslips"><span class="lbl">Payslips by person</span><span class="sm mut">Download anyone's payslip, any month</span></button>
    </div>
    ${notSet.length ? `<div class="warnbox" style="margin-top:12px"><b>No pay set for ${notSet.length}</b>
      <span>${esc(notSet.map(p => p.display_name).join(", "))} — their payslips show 0.00 basic until it's entered.</span></div>` : ""}
    <h3 class="sec">Months</h3>
    <div class="stack">${(runs.data || []).map(r => `<button class="listitem" data-act="payrun" data-v="${r.id}">
        <span class="chip ${r.status === "published" ? "ok" : "warn"}">${r.status === "published" ? "Published" : "Draft"}</span>
        <span class="sm"><b>${esc(r.label)}</b><br><span class="xs mut">${(byRun[r.id] || { n: 0 }).n} payslips${r.pay_date ? " · paid " + fmtDate(r.pay_date) : ""}</span></span>
        <span class="sm mono">${money((byRun[r.id] || { net: 0 }).net)}</span></button>`).join("")
      || '<p class="sm mut">No months yet. Set everyone\'s pay first, then start a month.</p>'}</div>`;
}

async function payRunView(back) {
  const [{ data: run, error }, { data: slips }] = await Promise.all([
    sb.from("pay_runs").select("*").eq("id", S.payRun).maybeSingle(),
    sb.from("payslips").select("*").eq("run_id", S.payRun).order("full_name")
  ]);
  if (error) throw error;
  if (!run) { S.payRun = null; return viewPayroll(); }
  const from = new Date(run.period_start + "T00:00:00+05:00").toISOString();
  const to = new Date(addDays(run.period_end, 1) + "T00:00:00+05:00").toISOString();
  const { data: sh } = await sb.from("shifts").select("id,ended_at,auto_closed").gte("started_at", from).lt("started_at", to);
  const open = (sh || []).filter(s => !s.ended_at).length, auto = (sh || []).filter(s => s.auto_closed).length;
  const list = slips || [];
  const tot = k => list.reduce((n, s) => n + Number(s[k] || 0), 0);
  const draft = run.status === "draft";
  const scPaid = tot("sc_share");
  const warn = [];
  if (open) warn.push(open + " shift" + (open > 1 ? "s are" : " is") + " still open in this month — their hours aren't counted until someone clocks them out.");
  if (auto) warn.push(auto + " shift" + (auto > 1 ? "s were" : " was") + " auto-closed after 14 hours. Check them on the timesheet.");
  if (Number(run.sc_pool) && Math.abs(scPaid - Number(run.sc_pool)) > 0.001) warn.push("Service charge pool is " + money(run.sc_pool) + " but " + money(scPaid) + " is on the payslips. Press Recalculate.");
  if (!run.calculated_at) warn.push("Not calculated yet. Press Recalculate.");
  list.filter(s => Number(s.net) < 0).forEach(s => warn.push(s.full_name + "'s net pay is below zero."));
  screenEl().innerHTML = head(run.label) + `<button class="chip" data-act="payback" style="margin-bottom:12px">‹ All months</button>
    <div class="card stack">
      <div class="between"><span class="chip ${draft ? "warn" : "ok"}">${draft ? "Draft — staff can't see it" : "Published"}</span>
        <span class="xs mut mono">${fmtDate(run.period_start)} – ${fmtDate(run.period_end)}</span></div>
      ${kv("Payslips", String(list.length))}
      ${kv("Gross pay", cur(run) + " " + money(tot("gross")))}
      ${kv("Deductions", cur(run) + " " + money(tot("total_deductions")))}
      ${kv("Net to pay", cur(run) + " " + money(tot("net")))}
      ${kv("Service charge shared", cur(run) + " " + money(scPaid) + " · by days worked")}
      ${run.pay_date ? kv("Pay date", fmtDate(run.pay_date)) : ""}
      ${run.calculated_at ? `<span class="xs mut">Last calculated ${fmtDayTime(run.calculated_at)}</span>` : ""}
    </div>
    ${warn.length ? `<div class="warnbox" style="margin-top:12px">${warn.map(w => `<span>• ${esc(w)}</span>`).join("")}</div>` : ""}
    ${draft ? `<h3 class="sec">This month</h3><div class="card stack">
      <label class="lbl" for="rsc">Service charge pool to share (${cur(run)})</label>
      <input id="rsc" type="number" inputmode="decimal" min="0" step="0.01" value="${Number(run.sc_pool) || ""}" placeholder="0.00">
      <label class="lbl" for="rpd">Pay date</label><input id="rpd" type="date" value="${run.pay_date || ""}">
      <button class="btn" data-act="recalc">Save and recalculate</button>
      <p class="xs mut" style="margin:0">Recalculating reads the timesheets again. Anything you typed on a payslip — bonuses, advances, notes — stays.</p></div>` : ""}
    <h3 class="sec">Payslips</h3>
    <div class="stack">${list.map(s => `<div class="listitem${Number(s.net) < 0 || !Number(s.basic) ? " flagged" : ""}" style="grid-template-columns:1fr auto">
        <button data-act="slip" data-v="${s.id}" style="display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;text-align:left;padding:0">
          <span class="avatar sm">${esc(initials(s.full_name))}</span>
          <span class="sm">${esc(s.full_name)}<br><span class="xs mut">${esc(s.designation || s.pay_type)} · ${s.days_worked || 0} days${Number(s.ot_hours) ? " · " + money(s.ot_hours) + " h OT" : ""}${!Number(s.basic) ? " · pay not entered" : ""}</span></span>
          <span class="sm mono">${money(s.net)}</span></button>
        <button class="chip gold" data-act="rowpdf" data-v="${s.id}" aria-label="Download ${esc(s.full_name)}'s payslip">PDF</button></div>`).join("")
      || '<p class="sm mut">No payslips yet. Press Save and recalculate.</p>'}</div>
    <div class="stack" style="margin-top:16px">
      ${list.length ? `<button class="btn sec" data-act="slipsall">Download all payslips (PDF)</button>
      <button class="btn sec" data-act="paycsv">Payment list (CSV, with bank details)</button>` : ""}
      ${draft ? `<button class="btn" data-act="publishrun"${list.length && run.calculated_at ? "" : " disabled"}>Publish — staff can see their payslips</button>
        <button class="btn sec" data-act="delrun">Delete this draft</button>`
      : `<button class="btn sec" data-act="reopenrun">Reopen as draft to correct it</button>`}
    </div>`;
  S.payRunRow = run; S.paySlips = list;
}

function newRunSheet() {
  const now = new Date(todayISO() + "T12:00:00Z");
  const val = now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0");
  sheet(`<div style="font-weight:600;font-size:18px">Start a new month</div>
    <label class="lbl" for="rm">Month</label><input id="rm" type="month" value="${val}">
    <label class="lbl" for="rsc2">Service charge pool (${"MVR"}) — you can change it later</label>
    <input id="rsc2" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00">
    <label class="lbl" for="rpd2">Pay date</label><input id="rpd2" type="date">
    <button class="btn" data-act="saverun">Create and calculate</button>
    <p class="xs mut" style="margin:0">It starts as a draft. Nobody sees it until you publish.</p>`);
}
async function saveRun(force) {
  if (!force) {
    const m = $("rm").value;
    if (!/^\d{4}-\d{2}$/.test(m)) return toast("Pick a month.", true);
    S.newRun = { m, pool: parseFloat($("rsc2").value) || 0, payDate: $("rpd2").value || null };
    const missing = await payMissingPeople();
    if (missing.length) return missingPaySheet(missing, "saverun", "Make the payslips anyway");
  }
  const { m, pool, payDate } = S.newRun;
  const [y, mo] = m.split("-").map(Number);
  const start = m + "-01";
  const end = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  busy(true);
  const { data, error } = await sb.from("pay_runs").insert({
    label: MONTHS[mo - 1] + " " + y, period_start: start, period_end: end,
    sc_pool: pool, pay_date: payDate, created_by: S.me.id
  }).select().single();
  if (error) { busy(false); return toast(error.code === "23505" ? "That month already exists — open it from the list." : error.message, true); }
  const calc = await sb.rpc("payroll_calculate", { p_run: data.id });
  busy(false);
  closeSheet();
  if (calc.error) toast(calc.error.message, true); else toast(calc.data.people + " payslips made.");
  S.payRun = data.id; return render();
}
async function recalcRun(force) {
  if (!force) {
    const pool = parseFloat($("rsc").value) || 0;
    if (pool < 0) return toast("The pool can't be negative.", true);
    S.recalc = { pool, payDate: $("rpd").value || null };
    const missing = await payMissingPeople();
    if (missing.length) return missingPaySheet(missing, "recalc", "Recalculate anyway");
  }
  closeSheet();
  busy(true);
  const up = await sb.from("pay_runs").update({ sc_pool: S.recalc.pool, pay_date: S.recalc.payDate }).eq("id", S.payRun);
  if (up.error) { busy(false); return toast(up.error.message, true); }
  const { data, error } = await sb.rpc("payroll_calculate", { p_run: S.payRun });
  busy(false);
  if (error) return toast(error.message, true);
  toast(data.people + " payslips · net " + money(data.net));
  return render();
}

/* ---- one payslip ---- */
function slipHtml(p, run) {
  const { earn, ded } = slipLines(p);
  const line = (l, i, kind, edit) => `<div class="kv"><span class="sm">${esc(l[0])}${l[1] ? `<br><span class="xs mut">${esc(l[1])}</span>` : ""}</span>
      <span class="sm mono">${money(l[2])}${edit ? ` <button class="chip bad" data-act="slipdel" data-v="${kind}|${i}" aria-label="Remove">✕</button>` : ""}</span></div>`;
  const edit = isOwner() && run.status === "draft";
  const nAdd = (p.additions || []).length;
  const base = earn.length - nAdd;
  return `<div class="card stack">
      <div class="between"><span class="sm"><b>${esc(p.full_name)}</b><br><span class="xs mut">${esc([p.employee_no, p.designation].filter(Boolean).join(" · ") || "")}</span></span>
        <span class="xs mut mono">${esc(run.label)}</span></div>
      <div><h3 class="sec" style="margin:6px 0 4px">Earnings</h3>
        ${earn.map((l, i) => line(l, i - base, "add", edit && i >= base)).join("")}
        <div class="kv"><span class="sm"><b>Gross pay</b></span><span class="sm mono"><b>${money(p.gross)}</b></span></div></div>
      ${ded.length ? `<div><h3 class="sec" style="margin:6px 0 4px">Deductions</h3>
        ${ded.map((l, i) => line(l, i, "ded", edit)).join("")}
        <div class="kv"><span class="sm"><b>Total deductions</b></span><span class="sm mono"><b>${money(p.total_deductions)}</b></span></div></div>` : ""}
      <div class="between" style="background:var(--gold-soft);border:1px solid #4A3B1C;border-radius:12px;padding:12px 14px">
        <span class="sm" style="color:var(--gold-ink)"><b>Net pay</b></span>
        <span class="big mono" style="color:var(--gold-ink)">${cur(run)} ${money(p.net)}</span></div>
      <span class="xs mut">${money(p.hours)} hours clocked${Number(p.ot_hours) ? " · " + money(p.ot_hours) + " h overtime" : ""}${p.pay_method ? " · " + esc(p.pay_method) : ""}${p.account_no ? " " + esc(maskAcct(p.account_no)) : ""}</span>
      ${p.note ? `<div class="note">${esc(p.note)}</div>` : ""}
    </div>`;
}
async function slipSheet(id) {
  const { data: p, error } = await sb.from("payslips").select("*").eq("id", id).maybeSingle();
  if (error || !p) return toast(error ? error.message : "That payslip is gone.", true);
  const run = S.payRunRow;
  const edit = run.status === "draft";
  S.slipOpen = p;
  sheet(`${slipHtml(p, run)}
    ${edit ? `<div class="card stack"><div class="sm"><b>Add a line</b></div>
      <select id="sk">${ADD_KINDS.map(k => `<option value="add|${k}">+ ${k}</option>`).join("")}${DED_KINDS.map(k => `<option value="ded|${k}">− ${k}</option>`).join("")}</select>
      <input id="sn" placeholder="Details, optional (e.g. 2 days, 12–13 Sep)">
      <input id="sa" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Amount (${cur(run)})">
      <button class="btn sm" data-act="slipadd">Add to payslip</button>
      <label class="lbl" for="snote">Note printed on the payslip</label><textarea id="snote" rows="2">${esc(p.note || "")}</textarea>
      <button class="btn sec sm" data-act="slipnote">Save note</button></div>` : ""}
    <button class="btn" data-act="slippdf" data-v="${p.id}">Download PDF</button>
    <button class="btn sec" data-act="closesheet">Close</button>`);
}
async function slipChange(fn) {
  const p = S.slipOpen; if (!p) return;
  const patch = fn({ additions: (p.additions || []).slice(), deductions: (p.deductions || []).slice(), note: p.note });
  if (!patch) return;
  busy(true);
  const { error } = await sb.from("payslips").update(patch).eq("id", p.id);
  busy(false);
  if (error) return toast(error.message, true);
  await slipSheet(p.id);
  payRunView().catch(() => {});   // keep the list behind in step
}

/* ---- pay setup ---- */
async function paySetupSheet() {
  const [{ data: profs, error }, { data: all }] = await Promise.all([
    sb.from("pay_profiles").select("*"), sb.from("profiles").select("*").order("display_name")
  ]);
  if (error) return toast(payMissing(error) ? "Run update-3-payroll.sql in Supabase first." : error.message, true);
  sheet(`<div style="font-weight:600;font-size:18px">Pay setup</div>
    <p class="xs mut" style="margin:0">Each person's pay. Changes apply to the next calculation, never to a published month.</p>
    <div class="stack">${(all || []).filter(p => p.active || (profs || []).some(x => x.user_id === p.id && x.active)).map(p => {
      const x = (profs || []).find(r => r.user_id === p.id);
      const amt = x && (x.pay_type === "monthly" ? Number(x.basic_salary) : Number(x.hourly_rate));
      const txt = !x || !amt ? "Not set" : x.pay_type === "monthly" ? "Monthly " + money(x.basic_salary) : "Hourly " + money(x.hourly_rate);
      return `<button class="listitem" data-act="payedit" data-v="${p.id}">
        <span class="avatar sm">${esc(initials(p.display_name))}</span>
        <span class="sm">${esc(p.display_name)}<br><span class="xs mut">${esc(p.role === "owner" ? "Owner — optional" : p.position || "")}${x && x.ot_eligible ? " · overtime" : ""}</span></span>
        <span class="chip ${amt ? "gold" : "warn"}">${esc(txt)}</span></button>`;
    }).join("")}</div>
    <button class="btn sec" data-act="closesheet">Close</button>`);
}
async function payEditSheet(uid) {
  const { data } = await sb.from("pay_profiles").select("*").eq("user_id", uid).maybeSingle();
  const x = data || { pay_type: "monthly", basic_salary: 0, hourly_rate: 0, allowances: [], ot_eligible: false, sc_eligible: true, pay_method: "Bank transfer" };
  const p = person(uid);
  const chk = (id, on, label) => `<label class="chip"><input type="checkbox" id="${id}"${on ? " checked" : ""} style="width:auto;margin-right:6px"> ${label}</label>`;
  sheet(`<div style="font-weight:600;font-size:18px">${esc(p.display_name)}</div>
    <div class="sm mut">${esc(p.full_name || "")}</div>
    <label class="lbl" for="xt">Paid</label>
    <select id="xt"><option value="monthly"${x.pay_type === "monthly" ? " selected" : ""}>Monthly salary</option>
      <option value="hourly"${x.pay_type === "hourly" ? " selected" : ""}>By the hour, from the timesheet</option></select>
    <label class="lbl" for="xb">Basic salary per month (MVR)</label><input id="xb" type="number" inputmode="decimal" min="0" step="0.01" value="${Number(x.basic_salary) || ""}">
    <label class="lbl" for="xr">Hourly rate (MVR) — hourly staff only</label><input id="xr" type="number" inputmode="decimal" min="0" step="0.01" value="${Number(x.hourly_rate) || ""}">
    <label class="lbl" for="xa">Monthly allowances, one per line: name = amount</label>
    <textarea id="xa" rows="3" placeholder="Food = 1000&#10;Transport = 500">${esc((x.allowances || []).map(a => a.name + " = " + a.amount).join("\n"))}</textarea>
    <div class="row">${chk("xo", x.ot_eligible, "Gets overtime pay")}${p.role === "owner" ? "" : chk("xs", x.sc_eligible, "Shares service charge")}</div>
    <p class="xs mut" style="margin:0">Overtime is paid only when this is ticked.${p.role === "owner" ? " The owner never shares the service charge." : ""}</p>
    <label class="lbl" for="xm">Paid by</label>
    <select id="xm">${["Bank transfer", "Cash"].map(m => `<option${x.pay_method === m ? " selected" : ""}>${m}</option>`).join("")}</select>
    <label class="lbl" for="xbn">Bank</label><input id="xbn" value="${esc(x.bank_name || "")}" placeholder="BML, MIB …">
    <label class="lbl" for="xan">Account name</label><input id="xan" value="${esc(x.account_name || "")}">
    <label class="lbl" for="xno">Account number</label><input id="xno" inputmode="numeric" value="${esc(x.account_no || "")}">
    <p class="xs mut" style="margin:0">Only you can see these. The payslip shows the last four digits.</p>
    <button class="btn" data-act="paysave" data-v="${uid}">Save</button>
    <button class="btn sec" data-act="personslips" data-v="${uid}">${esc(p.display_name)}'s payslips</button>
    <button class="btn sec" data-act="paysetup">Back</button>`);
}
async function paySave(uid) {
  const allowances = [];
  const bad = [];
  $("xa").value.split("\n").map(l => l.trim()).filter(Boolean).forEach(l => {
    const m = l.match(/^(.+?)\s*[=:\-]\s*([\d,]+(?:\.\d+)?)$/);
    if (!m) return bad.push(l);
    allowances.push({ name: m[1].trim(), amount: parseFloat(m[2].replace(/,/g, "")) });
  });
  if (bad.length) return toast('Allowance lines need "name = amount": ' + bad[0], true);
  const type = $("xt").value;
  const basic = parseFloat($("xb").value) || 0, rate = parseFloat($("xr").value) || 0;
  if (basic < 0 || rate < 0) return toast("Amounts can't be negative.", true);
  busy(true);
  const { error } = await sb.from("pay_profiles").upsert({
    user_id: uid, pay_type: type, basic_salary: basic, hourly_rate: rate, allowances,
    ot_eligible: $("xo").checked, sc_eligible: $("xs") ? $("xs").checked : false, active: true,
    pay_method: $("xm").value,
    bank_name: $("xbn").value.trim() || null, account_name: $("xan").value.trim() || null,
    account_no: $("xno").value.replace(/\s+/g, "") || null
  }, { onConflict: "user_id" });
  busy(false);
  if (error) return toast(error.message, true);
  toast("Pay saved for " + person(uid).display_name + ".");
  if (S.tab === "payroll" && !S.payRun) viewPayroll().catch(() => {});
  return paySetupSheet();
}

/* ---- payroll rules ---- */
async function paySettingsSheet() {
  const { data: s, error } = await sb.from("pay_settings").select("*").eq("id", 1).maybeSingle();
  if (error) return toast(payMissing(error) ? "Run update-3-payroll.sql in Supabase first." : error.message, true);
  sheet(`<div style="font-weight:600;font-size:18px">Payroll rules</div>
    <label class="lbl" for="ze">Employer name on payslips</label><input id="ze" value="${esc(s.employer_name)}">
    <label class="lbl" for="zad">Address on payslips</label><input id="zad" value="${esc(s.employer_address)}">
    <h3 class="sec" style="margin:10px 0 0">Overtime</h3>
    <label class="lbl" for="zw">Normal hours in a week — overtime is anything above</label><input id="zw" type="number" step="0.5" value="${s.week_hours}">
    <label class="lbl" for="zot">Overtime rate (× normal hourly pay)</label><input id="zot" type="number" step="0.05" value="${s.ot_rate}">
    <label class="lbl" for="zmh">Hours in a month, to turn a salary into an hourly rate</label><input id="zmh" type="number" step="1" value="${s.month_hours}">
    <p class="xs mut" style="margin:0">208 = 48 hours × 52 weeks ÷ 12. A 12,000 salary is then 57.69 an hour.</p>
    <h3 class="sec" style="margin:10px 0 0">Public holidays</h3>
    <label class="lbl" for="zhr">Holiday rate (× normal hourly pay)</label><input id="zhr" type="number" step="0.05" value="${s.holiday_rate}">
    <label class="lbl" for="zh">Holiday dates, one per line (YYYY-MM-DD)</label>
    <textarea id="zh" rows="4" placeholder="2026-11-03&#10;2026-11-11">${esc((s.holidays || []).join("\n"))}</textarea>
    <label class="chip"><input type="checkbox" id="zfri"${s.fridays_are_holidays ? " checked" : ""} style="width:auto;margin-right:6px"> Pay Fridays at the holiday rate too</label>
    <h3 class="sec" style="margin:10px 0 0">Service charge</h3>
    <p class="sm mut" style="margin:0">The month's pool is shared by days worked: each person gets pool × their days ÷ everyone's days. A day counts when they clocked in and out. The owner is left out.</p>
    <button class="btn" data-act="paysetsave">Save rules</button>
    <p class="xs mut" style="margin:0">Rules apply the next time a draft month is recalculated. Check the rates against the Employment Act and your contracts.</p>`);
}
async function paySettingsSave() {
  const hol = $("zh").value.split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
  const badDate = hol.find(d => !/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(new Date(d + "T12:00:00Z")));
  if (badDate) return toast("Not a date: " + badDate + " — use YYYY-MM-DD.", true);
  const num = id => parseFloat($(id).value);
  if (!(num("zw") > 0) || !(num("zmh") > 0) || !(num("zot") >= 1) || !(num("zhr") >= 1)) return toast("Hours must be above 0 and rates 1 or more.", true);
  busy(true);
  const { error } = await sb.from("pay_settings").update({
    employer_name: $("ze").value.trim() || "La Habana Lounge", employer_address: $("zad").value.trim(),
    week_hours: num("zw"), ot_rate: num("zot"), month_hours: num("zmh"), holiday_rate: num("zhr"),
    holidays: [...new Set(hol)].sort(), fridays_are_holidays: $("zfri").checked,
    updated_at: new Date().toISOString()
  }).eq("id", 1);
  busy(false);
  if (error) return toast(error.message, true);
  closeSheet(); toast("Rules saved. Recalculate any draft month to apply them.");
}

/* ---- any one person's payslips, any month (owner) ---- */
function findSlipsSheet() {
  sheet(`<div style="font-weight:600;font-size:18px">Payslips by person</div>
    <div class="stack">${S.people.map(p => `<button class="listitem" data-act="personslips" data-v="${p.id}">
      <span class="avatar sm">${esc(initials(p.display_name))}</span>
      <span class="sm">${esc(p.display_name)}<br><span class="xs mut">${esc(p.position || "")}</span></span><span class="chip">Open</span></button>`).join("")}</div>
    <button class="btn sec" data-act="closesheet">Close</button>`);
}
async function personSlipsSheet(uid) {
  const { data, error } = await sb.from("payslips").select("*, pay_runs(*)").eq("user_id", uid);
  if (error) return toast(error.message, true);
  const list = (data || []).filter(x => x.pay_runs).sort((a, b) => b.pay_runs.period_start.localeCompare(a.pay_runs.period_start));
  S.personSlips = list;
  const p = person(uid);
  sheet(`<div style="font-weight:600;font-size:18px">${esc(p.display_name)}'s payslips</div>
    ${list.length ? `<div class="stack">${list.map(x => `<div class="listitem">
        <span class="chip ${x.pay_runs.status === "published" ? "ok" : "warn"}">${x.pay_runs.status === "published" ? "Published" : "Draft"}</span>
        <span class="sm"><b>${esc(x.pay_runs.label)}</b><br><span class="xs mut">Net ${cur(x.pay_runs)} ${money(x.net)}</span></span>
        <button class="chip gold" data-act="pslippdf" data-v="${x.id}">PDF</button></div>`).join("")}</div>`
      : '<p class="sm mut" style="margin:0">No payslips for this person yet.</p>'}
    <button class="btn sec" data-act="findslips">Someone else</button>`);
}

/* ---- my payslips (everyone) ---- */
async function myPayslipsSheet() {
  const { data, error } = await sb.from("payslips").select("*, pay_runs(*)").eq("user_id", S.me.id);
  if (error) return toast(payMissing(error) ? "Payslips aren't switched on yet." : error.message, true);
  const mine = (data || []).filter(p => p.pay_runs && p.pay_runs.status === "published")
    .sort((a, b) => b.pay_runs.period_start.localeCompare(a.pay_runs.period_start));
  sheet(`<div style="font-weight:600;font-size:18px">My payslips</div>
    ${mine.length ? `<div class="stack">${mine.map(p => `<button class="listitem" data-act="myslip" data-v="${p.id}">
        <span class="chip gold">${esc(p.pay_runs.label.split(" ")[0].slice(0, 3))}</span>
        <span class="sm"><b>${esc(p.pay_runs.label)}</b><br><span class="xs mut">${p.pay_runs.pay_date ? "Paid " + fmtDate(p.pay_runs.pay_date) : "Published " + fmtDate((p.pay_runs.published_at || "").slice(0, 10))}</span></span>
        <span class="sm mono">${money(p.net)}</span></button>`).join("")}</div>`
      : '<p class="sm mut" style="margin:0">No payslips yet. They appear here when the owner publishes the month.</p>'}
    <button class="btn sec" data-act="profile">Back</button>`);
  S.mySlips = mine;
}
function mySlipSheet(id) {
  const p = (S.mySlips || []).find(x => x.id === id);
  if (!p) return;
  try { localStorage.setItem("lh-slip-" + id, "1"); } catch (e) { /* private mode */ }
  S.alerts = S.alerts.filter(a => !(a.act === "payslip" && a.v === id)); paintBell();
  sheet(`${slipHtml(p, p.pay_runs)}
    <button class="btn" data-act="myslippdf" data-v="${id}">Download PDF</button>
    <p class="xs mut" style="margin:0"><b>Private and confidential.</b> No signature required — this is a computer-generated document. Any discrepancies must be reported to the manager within 14 days; otherwise this payslip will be considered accurate.</p>
    <button class="btn sec" data-act="mypayslips">All my payslips</button>`);
}

/* ---- PDF payslips, drawn on the phone ---- */
let pdfLib = null, logoData = null;
function loadPdfLib() {
  if (window.jspdf) return Promise.resolve(window.jspdf);
  if (pdfLib) return pdfLib;
  const srcs = ["https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
    "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"];
  pdfLib = srcs.reduce((p, src) => p.catch(() => new Promise((ok, bad) => {
    const s = document.createElement("script"); s.src = src;
    s.onload = () => window.jspdf ? ok(window.jspdf) : bad(); s.onerror = bad;
    document.head.appendChild(s);
  })), Promise.reject()).catch(() => { pdfLib = null; throw new Error("Couldn't load the PDF maker. Check the internet and try again."); });
  return pdfLib;
}
async function loadLogo() {
  if (logoData !== null) return logoData;
  try {
    const blob = await (await fetch("icon-192.png")).blob();
    logoData = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => ok(""); r.readAsDataURL(blob); });
    if (!/^data:image\/png;base64,.{200}/.test(logoData)) logoData = "";   // a missing logo never stops a payslip
  } catch (e) { logoData = ""; }
  return logoData;
}
/* One A4 page. Plain Helvetica, so every phone and printer gets the same thing. */
function drawSlip(doc, p, run, logo) {
  const W = 595.28, M = 44, R = W - M;
  const gold = "#B8892F", ink = "#1A1712", mut = "#6F675A", line = "#DDD5C5";
  const C = run.currency || "MVR";
  doc.setFillColor("#121110"); doc.rect(0, 0, W, 104, "F");
  let hasLogo = false;
  if (logo) { try { doc.addImage(logo, "PNG", M, 22, 60, 60); hasLogo = true; } catch (e) { /* print without it */ } }
  const tx = hasLogo ? M + 76 : M;
  doc.setTextColor("#E3C377"); doc.setFont("helvetica", "bold"); doc.setFontSize(17);
  doc.text((run.employer_name || "La Habana Lounge").toUpperCase(), tx, 50);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor("#B9AE98");
  doc.text(run.employer_address || "", tx, 66);
  doc.setTextColor("#E3C377"); doc.setFont("helvetica", "bold"); doc.setFontSize(11);
  doc.text("PAYSLIP", R, 46, { align: "right" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor("#F1EBDD");
  doc.text(run.label || "", R, 62, { align: "right" });

  let y = 138;
  const pair = (x, label, val) => {
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(mut); doc.text(label.toUpperCase(), x, y);
    doc.setFontSize(10.5); doc.setTextColor(ink); doc.text(String(val || "-"), x, y + 14);
  };
  const c2 = M + 260;
  pair(M, "Employee", p.full_name); pair(c2, "Pay period", fmtDate(run.period_start) + " to " + fmtDate(run.period_end)); y += 36;
  pair(M, "Employee ID", p.employee_no); pair(c2, "Pay date", run.pay_date ? fmtDate(run.pay_date) : "-"); y += 36;
  pair(M, "Designation", p.designation); pair(c2, "Paid by", [p.pay_method, p.bank_name, maskAcct(p.account_no)].filter(Boolean).join(" · ")); y += 36;
  pair(M, "Pay basis", p.pay_type === "hourly" ? "Hourly, " + C + " " + money(p.hourly_rate) + " an hour" : "Monthly salary");
  pair(c2, "Hours clocked", money(p.hours) + " h" + (Number(p.ot_hours) ? "  (overtime " + money(p.ot_hours) + " h)" : "")); y += 44;

  const { earn, ded } = slipLines(p);
  const table = (title, rows, totalLabel, total) => {
    doc.setFillColor("#F4EFE4"); doc.rect(M, y - 13, R - M, 20, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(ink);
    doc.text(title.toUpperCase(), M + 8, y); doc.text(C, R - 8, y, { align: "right" });
    y += 22;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    rows.forEach(r => {
      doc.setTextColor(ink); doc.text(String(r[0]), M + 8, y);
      if (r[1]) { doc.setTextColor(mut); doc.setFontSize(8.5); doc.text(String(r[1]), M + 250, y); doc.setFontSize(10); doc.setTextColor(ink); }
      doc.text(money(r[2]), R - 8, y, { align: "right" });
      doc.setDrawColor(line); doc.setLineWidth(0.5); doc.line(M, y + 7, R, y + 7);
      y += 21;
    });
    doc.setFont("helvetica", "bold"); doc.text(totalLabel, M + 8, y); doc.text(money(total), R - 8, y, { align: "right" });
    y += 30;
  };
  table("Earnings", earn, "Gross pay", p.gross);
  if (ded.length) table("Deductions", ded, "Total deductions", p.total_deductions);

  doc.setFillColor(gold); doc.roundedRect(M, y - 4, R - M, 44, 6, 6, "F");
  doc.setTextColor("#17140E"); doc.setFont("helvetica", "bold"); doc.setFontSize(11);
  doc.text("NET PAY", M + 14, y + 23);
  doc.setFontSize(16); doc.text(C + " " + money(p.net), R - 14, y + 24, { align: "right" });
  y += 66;
  if (p.note) {
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(ink);
    doc.splitTextToSize("Note: " + p.note, R - M).forEach(l => { doc.text(l, M, y); y += 13; });
    y += 8;
  }
  /* the notice at the foot of every payslip */
  let fy = 732;
  doc.setDrawColor(line); doc.setLineWidth(0.6); doc.line(M, fy - 16, R, fy - 16);
  doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(ink);
  doc.text("PRIVATE AND CONFIDENTIAL", M, fy); fy += 15;
  doc.text("No signature required. This is a computer-generated document.", M, fy); fy += 15;
  doc.setFont("helvetica", "normal"); doc.setTextColor(ink);
  doc.text("I acknowledge receipt of my salary as per this payslip.", M, fy); fy += 15;
  doc.splitTextToSize("Any discrepancies must be reported to the manager within 14 days; otherwise this payslip will be considered accurate.", R - M)
    .forEach(l => { doc.text(l, M, fy); fy += 12; });
  doc.setFontSize(7.5); doc.setTextColor(mut);
  doc.text("Generated " + fmtDayTime(new Date()) + " · La Habana Staff", M, fy + 8);
}
async function slipsPdf(slips, run, filename) {
  busy(true);
  try {
    const [{ jsPDF }, logo] = await Promise.all([loadPdfLib(), loadLogo()]);
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    slips.forEach((p, i) => { if (i) doc.addPage(); drawSlip(doc, p, run, logo); });
    doc.save(filename);
  } catch (e) { toast(e.message || String(e), true); }
  busy(false);
}
const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function payCsv() {
  const run = S.payRunRow, list = S.paySlips || [];
  const head = ["Name", "Employee ID", "Designation", "Pay type", "Hours", "Overtime hours", "Basic", "Overtime", "Holiday premium",
    "Allowances", "Service charge", "Additions", "Gross", "Deductions", "Net", "Paid by", "Bank", "Account name", "Account number"];
  const rows = list.map(p => [p.full_name, p.employee_no || "", p.designation || "", p.pay_type, p.hours, p.ot_hours, p.basic, p.ot_pay, p.holiday_pay,
    p.allowance_total, p.sc_share, (p.additions || []).reduce((n, a) => n + Number(a.amount), 0).toFixed(2),
    p.gross, p.total_deductions, p.net, p.pay_method || "", p.bank_name || "", p.account_name || "", p.account_no || ""]);
  const csv = [head].concat(rows).map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
  a.download = "payroll-" + slug(run.label) + ".csv"; a.click();
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
    case "editme": return editMeSheet();
    case "settings": closeSheet(); S.tab = "manage"; return render();
    case "alerts": return alertsSheet();
    case "refreshalerts": {
      busy(true); await refreshAlerts(true); busy(false);
      paintBell(); return alertsSheet();
    }
    case "alertgo": {
      const a = S.alerts[Number(v)];
      closeSheet();
      if (!a) return;
      if (a.act === "chat") { S.tab = "chat"; S.chat = a.v; return render(); }
      if (a.act === "tab") { S.chat = null; if (a.sub) { S.reportTab = a.sub; S.shiftsTab = a.sub; } S.tab = a.v; return render(); }
      if (a.act === "profile") return profileSheet();
      if (a.act === "requests") return requestsSheet();
      if (a.act === "docs") return docsSheet();
      if (a.act === "payslip") { await myPayslipsSheet(); return mySlipSheet(a.v); }
      return;
    }
    case "docs": return docsSheet();
    case "hr": return hrSheet(v);
    case "savehr": {
      const patch = {
        user_id: v,
        employee_no: $("hno").value.trim() || null,
        contract_start: $("hcs").value || null,
        contract_end: $("hce").value || null,
        off_day: $("hoff").value || null,
        id_expiry: $("hid").value || null,
        insurance_expiry: $("hins").value || null,
        permit_expiry: $("hwp").value || null,
        note: $("hnote").value.trim() || null
      };
      const pos = $("hpos").value || null;
      busy(true);
      const [{ error: e1 }, { error: e2 }] = await Promise.all([
        sb.from("staff_hr").upsert(patch, { onConflict: "user_id" }),
        sb.from("profiles").update({ position: pos }).eq("id", v)
      ]);
      busy(false);
      if (e1 || e2) return toast((e1 || e2).message, true);
      const me = S.people.find(p => p.id === v); if (me) me.position = pos;
      if (v === S.me.id) { S.me.position = pos; await loadHr(); }
      await refreshAlerts(true); paintBell();
      toast("Details saved."); return staffSheet();
    }
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
 
    case "forceout": return forceOutSheet(v);
    case "outpick": { const el = $("oe"); if (el) el.value = v; return; }
    case "saveforceout": return saveForceOut(v);
    case "editshift": return editShiftSheet(v);
    case "saveshift": return saveShift(v);
    case "csv": return csvExport();
 
    case "saveprofile": {
      const patch = { display_name: $("mdn").value.trim(), phone: $("mph").value.trim() };
      const { error } = await sb.from("profiles").update(patch).eq("id", S.me.id);
      if (error) return toast(error.message, true);
      Object.assign(S.me, patch); toast("Saved."); render(); return profileSheet();
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
    case "payroll": closeSheet(); S.tab = "payroll"; S.payRun = null; return render();
    case "payrun": S.payRun = v; return render();
    case "payback": S.payRun = null; return render();
    case "newrun": return newRunSheet();
    case "saverun": return saveRun(v === "force");
    case "recalc": return recalcRun(v === "force");
    case "rowpdf": {
      const p = (S.paySlips || []).find(x => x.id === v); if (!p) return;
      return slipsPdf([p], S.payRunRow, "payslip-" + slug(S.payRunRow.label) + "-" + slug(p.full_name) + ".pdf");
    }
    case "findslips": return findSlipsSheet();
    case "personslips": return personSlipsSheet(v);
    case "pslippdf": {
      const p = (S.personSlips || []).find(x => x.id === v); if (!p) return;
      return slipsPdf([p], p.pay_runs, "payslip-" + slug(p.pay_runs.label) + "-" + slug(p.full_name) + ".pdf");
    }
    case "slip": return slipSheet(v);
    case "slipadd": {
      const amt = parseFloat($("sa").value);
      if (!(amt > 0)) return toast("Put in an amount above zero.", true);
      const [kind, name] = $("sk").value.split("|");
      const det = $("sn").value.trim();
      const item = { name: det ? name + " (" + det + ")" : name, amount: Math.round(amt * 100) / 100 };
      return slipChange(x => kind === "add" ? { additions: x.additions.concat(item) } : { deductions: x.deductions.concat(item) });
    }
    case "slipdel": return slipChange(x => {
      const key = parts[0] === "add" ? "additions" : "deductions";
      const list = x[key]; list.splice(Number(parts[1]), 1); return { [key]: list };
    });
    case "slipnote": return slipChange(() => ({ note: $("snote").value.trim() || null }));
    case "slippdf": {
      const p = S.slipOpen; if (!p) return;
      return slipsPdf([p], S.payRunRow, "payslip-" + slug(S.payRunRow.label) + "-" + slug(p.full_name) + ".pdf");
    }
    case "slipsall": return slipsPdf(S.paySlips || [], S.payRunRow, "payslips-" + slug(S.payRunRow.label) + ".pdf");
    case "paycsv": return payCsv();
    case "publishrun": {
      const run = S.payRunRow, n = (S.paySlips || []).length;
      return sheet(`<div style="font-weight:600;font-size:18px">Publish ${esc(run.label)}?</div>
        <p class="sm mut" style="margin:0">${n} people will see their own payslip in the app, and the month locks. You can reopen it later if something needs fixing.</p>
        <button class="btn" data-act="publishyes">Publish now</button>
        <button class="btn sec" data-act="closesheet">Not yet</button>`);
    }
    case "publishyes": {
      busy(true);
      const { error } = await sb.from("pay_runs").update({ status: "published", published_at: new Date().toISOString(), published_by: S.me.id }).eq("id", S.payRun);
      busy(false);
      if (error) return toast(error.message, true);
      closeSheet(); toast("Published. Staff can open their payslips now."); return render();
    }
    case "reopenrun": {
      const { error } = await sb.from("pay_runs").update({ status: "draft", published_at: null, published_by: null }).eq("id", S.payRun);
      if (error) return toast(error.message, true);
      toast("Back to draft — staff can't see it until you publish again."); return render();
    }
    case "delrun":
      return sheet(`<div style="font-weight:600;font-size:18px">Delete this draft?</div>
        <p class="sm mut" style="margin:0">The draft month and its payslips go, including anything you typed on them. Timesheets and pay setup aren't touched.</p>
        <button class="btn" data-act="delrunyes">Delete the draft</button><button class="btn sec" data-act="closesheet">Keep it</button>`);
    case "delrunyes": {
      const { error } = await sb.from("pay_runs").delete().eq("id", S.payRun);
      if (error) return toast(error.message, true);
      closeSheet(); S.payRun = null; toast("Draft deleted."); return render();
    }
    case "paysetup": return paySetupSheet();
    case "payedit": return payEditSheet(v);
    case "paysave": return paySave(v);
    case "paysettings": return paySettingsSheet();
    case "paysetsave": return paySettingsSave();
    case "mypayslips": return myPayslipsSheet();
    case "myslip": return mySlipSheet(v);
    case "myslippdf": {
      const p = (S.mySlips || []).find(x => x.id === v); if (!p) return;
      return slipsPdf([p], p.pay_runs, "payslip-" + slug(p.pay_runs.label) + ".pdf");
    }
    case "forgot": {
      const email = ($("em") && $("em").value.trim()) || "";
      if (!email) return toast("Type your email first, then tap this.", true);
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href });
      return toast(error ? error.message : "Check your email for a reset link.", !!error);
    }
  }
});
