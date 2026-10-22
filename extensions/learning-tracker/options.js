const session = document.querySelector("#session");
const urlInput = document.querySelector("#url");
const anonInput = document.querySelector("#anon");
const emailInput = document.querySelector("#email");
const passwordInput = document.querySelector("#password");
const sitesEl = document.querySelector("#sites");
const suggestionsEl = document.querySelector("#suggestions");
const message = document.querySelector("#message");

const SUGGESTIONS = [
  { label: "freeCodeCamp", pattern: "freecodecamp.org/learn" },
  { label: "MDN Web Docs", pattern: "developer.mozilla.org" },
  { label: "javascript.info", pattern: "javascript.info" },
  { label: "The Odin Project", pattern: "theodinproject.com" },
  { label: "Khan Academy", pattern: "khanacademy.org" },
  { label: "Coursera", pattern: "coursera.org" },
];

function note(text, isError) {
  message.hidden = !text;
  message.textContent = text || "";
  message.className = isError ? "error" : "muted";
}

function patternOf(site) {
  const host = site.includeSubdomains ? `*.${site.host}` : site.host;
  return site.pathPrefix ? `${host}${site.pathPrefix}` : host;
}

function render(status) {
  if (!status?.ok) {
    session.textContent = "Could not read the tracker.";
    note(status?.error || "Unknown error.", true);
    return;
  }
  session.textContent = status.signedIn
    ? status.paused
      ? "Signed in. Tracking is paused."
      : "Signed in. Tracking is on."
    : "Not signed in.";
  if (!urlInput.value && status.url) urlInput.value = status.url;
  const sites = Array.isArray(status.sites) ? status.sites : [];
  sitesEl.replaceChildren();
  if (!status.sitesExplicit) {
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "This is the default list. It is saved when you add a site or the extension connects.";
    sitesEl.append(hint);
  }
  if (sites.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No sites are tracked. Time in the browser is not recorded.";
    sitesEl.append(empty);
  }
  for (const site of sites) {
    const row = document.createElement("div");
    row.className = "site";
    const text = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = site.label || site.host;
    const pattern = document.createElement("div");
    pattern.className = "muted";
    pattern.textContent = patternOf(site);
    text.append(name, pattern);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      const next = sites.filter((item) => item.id !== site.id);
      chrome.runtime.sendMessage({ type: "saveSites", sites: next }, (result) => {
        if (!result?.ok) note(result?.error || "Could not save sites.", true);
        else {
          note("Tracked sites saved.", false);
          render(result);
        }
      });
    });
    row.append(text, remove);
    sitesEl.append(row);
  }

  suggestionsEl.replaceChildren();
  for (const suggestion of SUGGESTIONS) {
    const present = sites.some((site) => patternOf(site) === suggestion.pattern);
    if (present) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Add ${suggestion.label}`;
    button.addEventListener("click", () => addPattern(suggestion.pattern, suggestion.label));
    suggestionsEl.append(button);
  }
}

function addPattern(pattern, label) {
  note("", false);
  chrome.runtime.sendMessage({ type: "addSite", pattern, label }, (result) => {
    if (chrome.runtime.lastError) {
      note(chrome.runtime.lastError.message, true);
      return;
    }
    if (!result?.ok) {
      note(result?.error || "Could not add that site.", true);
      return;
    }
    document.querySelector("#pattern").value = "";
    document.querySelector("#label").value = "";
    note("Tracked sites saved.", false);
    render(result);
  });
}

document.querySelector("#add").addEventListener("click", () => {
  addPattern(document.querySelector("#pattern").value, document.querySelector("#label").value);
});

document.querySelector("#sign-in").addEventListener("click", () => {
  note("", false);
  const password = passwordInput.value;
  chrome.runtime.sendMessage(
    {
      type: "signIn",
      url: urlInput.value,
      anonKey: anonInput.value,
      email: emailInput.value,
      password,
    },
    (result) => {
      passwordInput.value = "";
      if (!result?.ok) note(result?.error || "Sign-in failed.", true);
      else {
        note("Signed in.", false);
        render(result);
      }
    }
  );
});

document.querySelector("#sign-out").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "signOut" }, (result) => {
    if (!result?.ok) note(result?.error || "Could not sign out.", true);
    else {
      note("Signed out. Queued time stays on this computer until you sign in again.", false);
      render(result);
    }
  });
});

chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
  if (chrome.runtime.lastError) {
    render({ ok: false, error: chrome.runtime.lastError.message });
    return;
  }
  render(status);
});
