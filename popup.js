/* ── State ──────────────────────────────────────────── */
let profiles        = {};
let rules           = [];
let bypassList      = "localhost, 127.0.0.1";
let activeProxyState = { mode: "unknown" };
let editingProfileName = "";
let currentTabHost  = "";
let confirmCallback = null;

const SERVER_TYPES = new Set(["PROXY", "HTTPS", "SOCKS", "SOCKS5"]);

/* ── DOM refs ───────────────────────────────────────── */
const headerBadge     = document.getElementById("headerBadge");
const statusDot       = document.getElementById("statusDot");
const statusText      = document.getElementById("statusText");
const profilesList    = document.getElementById("profilesList");
const rulesList       = document.getElementById("rulesList");
const rulesCount      = document.getElementById("rulesCount");
const rulesChevron    = document.getElementById("rulesChevron");
const rulesBody       = document.getElementById("rulesBody");
const ruleProfile     = document.getElementById("ruleProfile");
const ruleDomain      = document.getElementById("ruleDomain");
const addRuleHint     = document.getElementById("addRuleHint");
const errorToast      = document.getElementById("errorToast");
const overlay         = document.getElementById("profileFormOverlay");
const formTitle       = document.getElementById("formTitle");
const formName        = document.getElementById("formName");
const formType        = document.getElementById("formType");
const formHost        = document.getElementById("formHost");
const formPort        = document.getElementById("formPort");
const formError       = document.getElementById("formError");
const bypassInput     = document.getElementById("bypassInput");
const advancedBody    = document.getElementById("advancedBody");
const advancedChevron = document.getElementById("advancedChevron");

/* ── Boot ───────────────────────────────────────────── */
chrome.storage.local.get(["profiles", "rules", "bypassList", "activeProxyState"], (data) => {
  if (data.profiles && typeof data.profiles === "object")       profiles        = data.profiles;
  if (Array.isArray(data.rules))                               rules           = data.rules;
  if (typeof data.bypassList === "string" && data.bypassList)  bypassList      = data.bypassList;
  if (data.activeProxyState && typeof data.activeProxyState === "object")
    activeProxyState = data.activeProxyState;

  bypassInput.value = bypassList;
  updateUI();

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0] && tabs[0].url && tabs[0].url.startsWith("http")) {
      try {
        currentTabHost = new URL(tabs[0].url).hostname.toLowerCase();
        ruleDomain.value = "*." + currentTabHost;
        addRuleHint.textContent = "Current tab · " + currentTabHost;
      } catch (_) {}
    }
    updateUI();
  });
});

/* ── Mode buttons ───────────────────────────────────── */
document.getElementById("btn-direct").addEventListener("click", () =>
  sendAction({ action: "set_direct_proxy" }));

document.getElementById("btn-system").addEventListener("click", () =>
  sendAction({ action: "set_system_proxy" }));

document.getElementById("btn-smart").addEventListener("click", () =>
  sendAction({ action: "apply_smart_routing" }));

/* ── Profile form ───────────────────────────────────── */
document.getElementById("btn-new-profile").addEventListener("click", () => openForm());

document.getElementById("formCancelBtn").addEventListener("click", () => closeForm());

document.getElementById("formSaveBtn").addEventListener("click", () => saveProfile());

/* ── Rules ──────────────────────────────────────────── */
document.getElementById("rulesToggle").addEventListener("click", () => {
  rulesBody.classList.toggle("open");
  rulesChevron.classList.toggle("open");
});

document.getElementById("addRuleBtn").addEventListener("click", () => {
  const domain = normalizeDomainPattern(ruleDomain.value);
  const profileName = ruleProfile.value;

  if (!domain) { showError("Enter a valid domain pattern."); return; }
  if (profileName !== "DIRECT" && !profiles[profileName]) {
    showError("Choose a valid proxy profile.");
    return;
  }

  // Avoid exact duplicate rules
  const exists = rules.some(r => normalizeDomainPattern(r.domain) === domain && r.profileName === profileName);
  if (exists) { showError("This rule already exists."); return; }

  rules.push({ domain, profileName });
  saveLocalState(() => {
    updateUI();
    if (activeProxyState.mode === "smart") {
      sendAction({ action: "apply_smart_routing" }, false);
    }
  });
});

/* ── Advanced / bypass ──────────────────────────────── */
document.getElementById("advancedToggle").addEventListener("click", () => {
  advancedBody.classList.toggle("open");
  advancedChevron.classList.toggle("open");
});

document.getElementById("bypassSaveBtn").addEventListener("click", () => {
  bypassList = bypassInput.value;
  chrome.storage.local.set({ bypassList }, () => {
    if (chrome.runtime.lastError) {
      showError(chrome.runtime.lastError.message);
      return;
    }
    if (activeProxyState.mode === "smart") {
      sendAction({ action: "apply_smart_routing" }, false);
    }
    showSuccess("Bypass list saved.");
  });
});

/* ── Custom confirm dialog ──────────────────────────── */
document.getElementById("confirmYes").addEventListener("click", () => {
  document.getElementById("confirmDialog").classList.remove("open");
  if (typeof confirmCallback === "function") confirmCallback();
  confirmCallback = null;
});

document.getElementById("confirmNo").addEventListener("click", () => {
  document.getElementById("confirmDialog").classList.remove("open");
  confirmCallback = null;
});

function showConfirm(message, callback) {
  document.getElementById("confirmMsg").textContent = message;
  confirmCallback = callback;
  document.getElementById("confirmDialog").classList.add("open");
}

/* ── UI update ──────────────────────────────────────── */
function updateUI() {
  updateStatus();
  updateModeButtons();
  updateProfileList();
  updateRulesList();
}

function updateStatus() {
  const mode = activeProxyState.mode;

  // Header badge
  headerBadge.className = "header-badge badge-" + (mode || "unknown");
  const badgeLabels = {
    direct: "Direct", system: "System", smart: "Smart routing",
    global: "Global proxy", unknown: "Unknown"
  };
  headerBadge.textContent = badgeLabels[mode] || "Unknown";

  // Status sentence
  statusDot.className = "status-dot";
  let dotClass = "dot-gray";
  let sentence = "";

  if (mode === "direct") {
    sentence = "All connections going <b>direct</b>, no proxy.";
    dotClass = "dot-gray";
  } else if (mode === "system") {
    sentence = "Using <b>system</b> proxy settings.";
    dotClass = "dot-orange";
  } else if (mode === "global") {
    const pn = activeProxyState.profileName;
    const exists = pn && profiles[pn];
    if (exists) {
      const p = profiles[pn];
      sentence = `All traffic → <b>${pn}</b> (${p.serverType} ${p.host}:${p.port}).`;
    } else if (pn) {
      sentence = `Global profile <b>${pn}</b> is deleted — choose another.`;
      dotClass = "dot-gray";
    } else {
      sentence = "Global proxy active.";
    }
    dotClass = exists ? "dot-green" : "dot-gray";
  } else if (mode === "smart") {
    const match = getSmartMatchForHost(currentTabHost);
    if (!currentTabHost) {
      sentence = "Smart routing active. No web tab focused.";
      dotClass = "dot-green";
    } else if (!match) {
      sentence = `<b>${currentTabHost}</b> → DIRECT (no matching rule).`;
      dotClass = "dot-gray";
    } else if (match.profileName === "DIRECT") {
      sentence = `<b>${currentTabHost}</b> → DIRECT via rule <code>${match.domain}</code>.`;
      dotClass = "dot-gray";
    } else {
      sentence = `<b>${currentTabHost}</b> → <b>${match.profileName}</b> via rule <code>${match.domain}</code>.`;
      dotClass = "dot-green";
    }
  } else {
    sentence = "Status unknown. Choose a connection mode.";
  }

  statusDot.classList.add(dotClass);
  statusText.innerHTML = sentence;
}

function updateModeButtons() {
  ["btn-direct", "btn-system", "btn-smart"].forEach(id => {
    document.getElementById(id).classList.remove("active");
  });
  const map = { direct: "btn-direct", system: "btn-system", smart: "btn-smart" };
  if (map[activeProxyState.mode]) {
    document.getElementById(map[activeProxyState.mode]).classList.add("active");
  }
}

function updateProfileList() {
  profilesList.replaceChildren();
  ruleProfile.replaceChildren(new Option("DIRECT", "DIRECT"));

  const activeProfileName = getActiveGlobalProfileName();
  const keys = Object.keys(profiles);

  if (keys.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-profiles";
    empty.textContent = "No profiles yet — add one above.";
    profilesList.appendChild(empty);
    return;
  }

  for (const name of keys) {
    const profile = profiles[name];
    ruleProfile.appendChild(new Option(name, name));

    const isActive = name === activeProfileName;

    const row = document.createElement("div");
    row.className = "profile-item" + (isActive ? " active-profile" : "");

    const dot = document.createElement("div");
    dot.className = "profile-indicator" + (isActive ? " active-dot" : "");

    const info = document.createElement("div");
    info.className = "profile-info";
    info.title = "Click to apply globally";

    const nameEl = document.createElement("div");
    nameEl.className = "profile-name";
    nameEl.textContent = name;

    const detail = document.createElement("div");
    detail.className = "profile-detail";
    detail.textContent = `${profile.serverType || "?"} · ${profile.host || "?"}:${profile.port || "?"}`;

    info.append(nameEl, detail);
    info.addEventListener("click", () => applyGlobalProxy(name, profile));

    const actions = document.createElement("div");
    actions.className = "profile-actions";

    // Only show Apply button if not the currently active global profile
    if (!isActive || activeProxyState.mode !== "global") {
      const applyBtn = mkBtn("Apply", "", () => applyGlobalProxy(name, profile));
      actions.appendChild(applyBtn);
    }

    const editBtn = mkBtn("Edit", "", () => openForm(name));
    const delBtn  = mkBtn("✕", "del", () => deleteProfile(name));
    actions.append(editBtn, delBtn);

    row.append(dot, info, actions);
    profilesList.appendChild(row);
  }
}

function updateRulesList() {
  rulesList.replaceChildren();
  rulesCount.textContent = rules.length;

  if (rules.length === 0) {
    const empty = document.createElement("div");
    empty.className = "no-rules";
    empty.textContent = "No rules yet — add one below.";
    rulesList.appendChild(empty);
    return;
  }

  rules.forEach((rule, idx) => {
    const item = document.createElement("div");
    item.className = "rule-item";

    const domain = document.createElement("span");
    domain.className = "rule-domain";
    domain.textContent = rule.domain;

    const via = document.createElement("span");
    via.className = "rule-via " + (rule.profileName === "DIRECT" ? "via-direct" : "via-proxy");
    via.textContent = rule.profileName;

    const del = document.createElement("button");
    del.className = "rule-del-btn";
    del.title = "Remove rule";
    del.textContent = "✕";
    del.addEventListener("click", () => deleteRule(idx));

    item.append(domain, via, del);
    rulesList.appendChild(item);
  });
}

/* ── Profile form ───────────────────────────────────── */
function openForm(profileName) {
  clearFormError();
  editingProfileName = profileName || "";
  formTitle.textContent = editingProfileName ? "Edit profile" : "New profile";
  formName.value = editingProfileName;

  if (editingProfileName && profiles[editingProfileName]) {
    const p = profiles[editingProfileName];
    formType.value = p.serverType || "PROXY";
    formHost.value = p.host || "";
    formPort.value = p.port || "";
  } else {
    formType.value = "PROXY";
    formHost.value = "";
    formPort.value = "";
  }

  overlay.classList.add("open");
  formName.focus();
}

function closeForm() {
  overlay.classList.remove("open");
  clearFormError();
  editingProfileName = "";
}

function saveProfile() {
  const name       = formName.value.trim();
  const serverType = formType.value.trim().toUpperCase();
  const host       = formHost.value.trim();
  const port       = formPort.value;

  const validation = validateProfileInput({ name, serverType, host, port });
  if (!validation.ok) { showFormError(validation.error); return; }

  if (editingProfileName && editingProfileName !== name && profiles[name]) {
    showFormError("A profile with that name already exists.");
    return;
  }

  if (editingProfileName && editingProfileName !== name) {
    delete profiles[editingProfileName];
    rules = rules.map(r => r.profileName !== editingProfileName ? r : { ...r, profileName: name });
    if (activeProxyState.mode === "global" && activeProxyState.profileName === editingProfileName) {
      activeProxyState = { ...activeProxyState, profileName: name };
    }
  }

  profiles[name] = {
    serverType: validation.value.serverType,
    host: validation.value.host,
    port: validation.value.port
  };

  const shouldReapply =
    activeProxyState.mode === "global" &&
    (activeProxyState.profileName === name || activeProxyState.profileName === editingProfileName);

  saveLocalState(() => {
    closeForm();
    updateUI();
    if (shouldReapply) applyGlobalProxy(name, profiles[name]);
  });
}

/* ── Delete helpers ─────────────────────────────────── */
function deleteProfile(name) {
  const isActive = activeProxyState.mode === "global" && activeProxyState.profileName === name;
  const msg = isActive
    ? `Delete active profile "${name}"? The proxy will stay until you choose another mode.`
    : `Delete profile "${name}"? Rules using it will also be removed.`;

  showConfirm(msg, () => {
    delete profiles[name];
    rules = rules.filter(r => r.profileName !== name);
    saveLocalState(() => updateUI());
  });
}

function deleteRule(idx) {
  rules.splice(idx, 1);
  saveLocalState(() => {
    updateUI();
    if (activeProxyState.mode === "smart") {
      sendAction({ action: "apply_smart_routing" }, false);
    }
  });
}

/* ── Proxy actions ──────────────────────────────────── */
function applyGlobalProxy(name, profile) {
  sendAction({ action: "set_global_proxy", profileName: name, profile });
}

function sendAction(message, closeAfter) {
  clearError();
  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) { showError(chrome.runtime.lastError.message); return; }
    if (!response || !response.ok) { showError(response?.error || "Proxy setting failed."); return; }

    if (message.action === "set_direct_proxy")    activeProxyState = { mode: "direct" };
    if (message.action === "set_system_proxy")    activeProxyState = { mode: "system" };
    if (message.action === "apply_smart_routing") activeProxyState = { mode: "smart" };
    if (message.action === "set_global_proxy") {
      activeProxyState = {
        mode: "global",
        profileName: message.profileName || "",
        profile: message.profile
      };
    }

    // Persist activeProxyState
    chrome.storage.local.set({ activeProxyState });
    updateUI();
    if (closeAfter !== false) window.close();
  });
}

/* ── Storage ─────────────────────────────────────────── */
function saveLocalState(callback) {
  chrome.storage.local.set({ profiles, rules, bypassList, activeProxyState }, () => {
    if (chrome.runtime.lastError) { showError(chrome.runtime.lastError.message); return; }
    callback();
  });
}

/* ── Error / feedback ───────────────────────────────── */
function showError(msg) {
  errorToast.textContent = msg;
  errorToast.style.display = "block";
  errorToast.style.background = "var(--red-bg)";
  errorToast.style.color = "var(--red)";
  errorToast.style.border = "1px solid var(--red-dim)";
}

function showSuccess(msg) {
  errorToast.textContent = msg;
  errorToast.style.display = "block";
  errorToast.style.background = "var(--green-bg)";
  errorToast.style.color = "var(--green)";
  errorToast.style.border = "1px solid var(--green-dim)";
  setTimeout(clearError, 2000);
}

function clearError() {
  errorToast.textContent = "";
  errorToast.style.display = "none";
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.style.display = "block";
}

function clearFormError() {
  formError.textContent = "";
  formError.style.display = "none";
}

/* ── Smart routing helpers ──────────────────────────── */
function getActiveGlobalProfileName() {
  if (activeProxyState.mode === "global") return activeProxyState.profileName || "";
  if (activeProxyState.mode === "smart") {
    const match = getSmartMatchForHost(currentTabHost);
    if (match && match.profileName !== "DIRECT") return match.profileName;
  }
  return "";
}

function getSmartMatchForHost(host) {
  if (!host) return null;
  for (const rule of rules) {
    const domain = normalizeDomainPattern(rule.domain);
    if (domain && hostMatchesPattern(host, domain)) {
      return { domain, profileName: rule.profileName };
    }
  }
  return null;
}

function hostMatchesPattern(host, pattern) {
  if (pattern.startsWith("*.")) {
    const apex = pattern.slice(2);
    return host === apex || host.endsWith("." + apex);
  }
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("^" + escaped + "$").test(host);
  }
  return host === pattern;
}

/* ── Validation ─────────────────────────────────────── */
function validateProfileInput({ name, serverType, host, port }) {
  if (!name)                          return { ok: false, error: "Profile name is required." };
  if (!SERVER_TYPES.has(serverType))  return { ok: false, error: "Choose a valid proxy type." };
  const h = normalizeHost(host);
  if (!h)                             return { ok: false, error: "Enter a valid proxy host." };
  const p = normalizePort(port);
  if (!p)                             return { ok: false, error: "Port must be 1 – 65535." };
  return { ok: true, value: { serverType, host: h, port: p } };
}

function normalizeHost(host) {
  if (typeof host !== "string") return "";
  const n = host.trim();
  if (!n || n.length > 255 || /[\s"'`\\/<>{}()[\];]/.test(n)) return "";
  return n;
}

function normalizePort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 0;
  return n;
}

function normalizeDomainPattern(domain) {
  if (typeof domain !== "string") return "";
  const n = domain.trim().toLowerCase();
  if (!n || n.length > 255 || n.includes("://") || /[\s"'`\\/<>{}()[\];]/.test(n)) return "";
  return n;
}

/* ── Util ───────────────────────────────────────────── */
function mkBtn(label, extraClass, onClick) {
  const btn = document.createElement("button");
  btn.className = "act-btn" + (extraClass ? " " + extraClass : "");
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return btn;
}
