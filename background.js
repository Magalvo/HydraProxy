const SERVER_TYPES = {
  PROXY: { fixedScheme: "http", pacType: "PROXY" },
  HTTPS: { fixedScheme: "https", pacType: "HTTPS" },
  SOCKS: { fixedScheme: "socks4", pacType: "SOCKS" },
  SOCKS5: { fixedScheme: "socks5", pacType: "SOCKS5" }
};

const DEFAULT_BYPASS_LIST = "localhost, 127.0.0.1";

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || typeof request.action !== "string") {
    sendResponse({ ok: false, error: "Invalid request." });
    return false;
  }

  if (request.action === "apply_smart_routing") {
    applySmartRouting(sendResponse);
    return true;
  }

  if (request.action === "set_system_proxy") {
    setProxySettings(
      { mode: "system" },
      "Reverted to OS System Proxy.",
      sendResponse,
      { mode: "system" }
    );
    return true;
  }

  if (request.action === "set_direct_proxy") {
    setProxySettings(
      { mode: "direct" },
      "Forced Direct Connection.",
      sendResponse,
      { mode: "direct" }
    );
    return true;
  }

  if (request.action === "set_global_proxy") {
    const profile = validateProfile(request.profile);
    if (!profile.ok) {
      sendResponse({ ok: false, error: profile.error });
      return false;
    }

    const config = {
      mode: "fixed_servers",
      rules: {
        singleProxy: {
          scheme: SERVER_TYPES[profile.value.serverType].fixedScheme,
          host: profile.value.host,
          port: profile.value.port
        },
        bypassList: ["localhost", "127.0.0.1"]
      }
    };

    setProxySettings(
      config,
      `Global proxy set to ${profile.value.host}:${profile.value.port}`,
      sendResponse,
      {
        mode: "global",
        profileName: typeof request.profileName === "string" ? request.profileName : "",
        profile: profile.value
      }
    );
    return true;
  }

  sendResponse({ ok: false, error: "Unknown action." });
  return false;
});

function applySmartRouting(sendResponse) {
  chrome.storage.local.get(["profiles", "rules", "bypassList"], (data) => {
    const profiles = data.profiles && typeof data.profiles === "object"
      ? data.profiles
      : {};
    const rules = Array.isArray(data.rules) ? data.rules : [];
    const bypassStr = typeof data.bypassList === "string"
      ? data.bypassList
      : DEFAULT_BYPASS_LIST;

    const pacScript = buildPacScript(profiles, rules, bypassStr);
    const config = {
      mode: "pac_script",
      pacScript: { data: pacScript }
    };

    setProxySettings(config, "Smart routing applied.", sendResponse, { mode: "smart" });
  });
}

function setProxySettings(value, successMessage, sendResponse, activeState) {
  chrome.proxy.settings.set({ value, scope: "regular" }, () => {
    const error = chrome.runtime.lastError;
    if (error) {
      console.warn(error.message);
      sendResponse({ ok: false, error: error.message });
      return;
    }

    const respond = () => {
      console.log(successMessage);
      sendResponse({ ok: true });
    };

    if (!activeState) {
      respond();
      return;
    }

    chrome.storage.local.set({ activeProxyState: activeState }, () => {
      const storageError = chrome.runtime.lastError;
      if (storageError) {
        console.warn(storageError.message);
        sendResponse({ ok: false, error: storageError.message });
        return;
      }

      respond();
    });
  });
}

function buildPacScript(profiles, rules, bypassStr) {
  const lines = ["function FindProxyForURL(url, host) {"];
  const bypassDomains = bypassStr
    .split(",")
    .map((domain) => normalizeDomainPattern(domain))
    .filter(Boolean);

  bypassDomains.forEach((domain) => {
    lines.push(`  if (${hostMatchExpression(domain)}) return "DIRECT";`);
  });

  rules.forEach((rule) => {
    const normalizedRule = validateRule(rule, profiles);
    if (!normalizedRule.ok) return;

    lines.push(
      `  if (${hostMatchExpression(normalizedRule.value.domain)}) return ${JSON.stringify(normalizedRule.value.proxyString)};`
    );
  });

  lines.push('  return "DIRECT";');
  lines.push("}");
  return lines.join("\n");
}

function validateRule(rule, profiles) {
  if (!rule || typeof rule !== "object") {
    return { ok: false, error: "Invalid rule." };
  }

  const domain = normalizeDomainPattern(rule.domain);
  if (!domain) {
    return { ok: false, error: "Invalid rule domain." };
  }

  if (rule.profileName === "DIRECT") {
    return { ok: true, value: { domain, proxyString: "DIRECT" } };
  }

  if (typeof rule.profileName !== "string" || !profiles[rule.profileName]) {
    return { ok: false, error: "Unknown profile." };
  }

  const profile = validateProfile(profiles[rule.profileName]);
  if (!profile.ok) {
    return { ok: false, error: profile.error };
  }

  const proxyString = `${SERVER_TYPES[profile.value.serverType].pacType} ${profile.value.host}:${profile.value.port}`;
  return { ok: true, value: { domain, proxyString } };
}

function validateProfile(profile) {
  if (!profile || typeof profile !== "object") {
    return { ok: false, error: "Invalid proxy profile." };
  }

  const serverType = typeof profile.serverType === "string"
    ? profile.serverType.trim().toUpperCase()
    : "";
  if (!SERVER_TYPES[serverType]) {
    return { ok: false, error: "Invalid proxy type." };
  }

  const host = normalizeHost(profile.host);
  if (!host) {
    return { ok: false, error: "Invalid proxy host." };
  }

  const port = normalizePort(profile.port);
  if (!port) {
    return { ok: false, error: "Port must be between 1 and 65535." };
  }

  return { ok: true, value: { serverType, host, port } };
}

function normalizeHost(host) {
  if (typeof host !== "string") return "";

  const normalized = host.trim();
  if (
    !normalized ||
    normalized.length > 255 ||
    /[\s"'`\\/<>{}()[\];]/.test(normalized)
  ) {
    return "";
  }

  return normalized;
}

function normalizePort(port) {
  const normalized = Number(port);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 65535) {
    return 0;
  }

  return normalized;
}

function normalizeDomainPattern(domain) {
  if (typeof domain !== "string") return "";

  const normalized = domain.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > 255 ||
    normalized.includes("://") ||
    /[\s"'`\\/<>{}()[\];]/.test(normalized)
  ) {
    return "";
  }

  return normalized;
}

function hostMatchExpression(pattern) {
  if (pattern.startsWith("*.")) {
    const apex = pattern.slice(2);
    if (!apex) return "false";

    return `host === ${JSON.stringify(apex)} || shExpMatch(host, ${JSON.stringify(pattern)})`;
  }

  return `shExpMatch(host, ${JSON.stringify(pattern)})`;
}
