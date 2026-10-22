// Central Hub coding tracker.
//
// One extension runs in both Cursor and VS Code. It records active editor time
// (not keystrokes, not file contents, not full paths) and sends heartbeats to
// the signed-in user's Central Hub account. While offline, heartbeats stay in
// the editor's global state and are sent later. Sending them again is safe:
// each heartbeat has a deterministic id.

import vscode from "vscode";
import {
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_IDLE_SECONDS,
  detectEditor,
  fileLabel,
  initialTrackerState,
  languageLabel,
  projectLabel,
  reduceTracker,
} from "./lib/codingTime.js";
import { acknowledgeHeartbeats, enqueueHeartbeats, nextBackoffSeconds } from "./lib/queue.js";
import {
  buildInsertHeartbeatsRequest,
  buildRefreshRequest,
  buildSignInRequest,
  buildUpsertIntegrationRequest,
} from "./lib/transport.js";

const REFRESH_SECRET = "centralHub.refreshToken";
const QUEUE_KEY = "centralHub.queue";
const PAUSED_KEY = "centralHub.paused";

const TICK_MS = 20_000;
const FLUSH_MS = 60_000;
const ACTIVITY_GAP_MS = 1000;

/** @type {vscode.ExtensionContext|null} */
let extensionContext = null;
/** @type {ReturnType<typeof initialTrackerState>} */
let tracker = initialTrackerState();
/** @type {vscode.StatusBarItem|null} */
let statusBar = null;
let failures = 0;
let flushing = false;
let lastActivityNote = 0;
let lastError = "";
let tickTimer = null;
let flushTimer = null;
let retryTimer = null;
/** Serializes queue reads and writes so a flush cannot drop a heartbeat that arrived mid-send. */
let queueChain = Promise.resolve();

export async function activate(context) {
  extensionContext = context;
  tracker = initialTrackerState({
    editor: detectEditor(vscode.env.appName),
    paused: context.globalState.get(PAUSED_KEY) === true,
  });

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "centralHub.status";
  statusBar.show();
  paintStatus();

  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand("centralHub.signIn", () => signIn().catch(showFailure)),
    vscode.commands.registerCommand("centralHub.signOut", () => signOut().catch(showFailure)),
    vscode.commands.registerCommand("centralHub.pause", () => setPaused(true)),
    vscode.commands.registerCommand("centralHub.resume", () => setPaused(false)),
    vscode.commands.registerCommand("centralHub.status", showStatus),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme !== "file" && event.document.uri.scheme !== "untitled") return;
      noteActivity(event.document);
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      const document = event.textEditor?.document;
      if (!document) return;
      if (document.uri.scheme !== "file" && document.uri.scheme !== "untitled") return;
      noteActivity(document);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      noteActivity(editor.document);
    }),
    vscode.window.onDidChangeWindowState((windowState) => {
      dispatch(windowState.focused ? { type: "focus", at: nowSeconds() } : { type: "blur", at: nowSeconds() });
    })
  );

  if (!vscode.window.state.focused) {
    tracker = { ...tracker, focused: false };
  }

  tickTimer = setInterval(() => dispatch({ type: "tick", at: nowSeconds() }), TICK_MS);
  flushTimer = setInterval(() => {
    flush().catch(() => {});
  }, FLUSH_MS);
  context.subscriptions.push({
    dispose() {
      clearInterval(tickTimer);
      clearInterval(flushTimer);
    },
  });
}

export async function deactivate() {
  dispatch({ type: "pause", at: nowSeconds() });
  tracker = { ...tracker, paused: extensionContext?.globalState.get(PAUSED_KEY) === true };
  try {
    await flush();
  } catch {
    // The queue is still on disk. The next launch sends it.
  }
}

function settings() {
  const config = vscode.workspace.getConfiguration("centralHub");
  return {
    url: String(config.get("supabaseUrl") ?? "").trim(),
    anonKey: String(config.get("supabaseAnonKey") ?? "").trim(),
    heartbeatSeconds: numberSetting(config.get("heartbeatSeconds"), DEFAULT_HEARTBEAT_SECONDS),
    idleSeconds: numberSetting(config.get("idleSeconds"), DEFAULT_IDLE_SECONDS),
  };
}

function noteActivity(document) {
  const atMs = Date.now();
  if (atMs - lastActivityNote < ACTIVITY_GAP_MS) return;
  lastActivityNote = atMs;
  const folder = folderFor(document);
  dispatch({
    type: "activity",
    at: atMs / 1000,
    editor: detectEditor(vscode.env.appName),
    projectName: projectLabel(folder),
    fileName: fileFromDocument(document),
    language: languageLabel(document.languageId),
  });
}

function fileFromDocument(document) {
  if (!document) return null;
  if (document.uri.scheme === "file") return fileLabel(document.uri.fsPath);
  if (document.uri.scheme === "untitled") return fileLabel(document.fileName);
  return null;
}

function folderFor(document) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return null;
  const path = document?.uri?.scheme === "file" ? document.uri.fsPath : "";
  const match = path
    ? folders.find((folder) => path === folder.uri.fsPath || path.startsWith(folder.uri.fsPath + separatorOf(folder.uri.fsPath)))
    : null;
  return (match ?? folders[0]).uri.fsPath;
}

function separatorOf(folderPath) {
  return folderPath.includes("\\") ? "\\" : "/";
}

function dispatch(event) {
  const { heartbeatSeconds, idleSeconds } = settings();
  const result = reduceTracker(tracker, event, { heartbeatSeconds, idleSeconds });
  tracker = result.state;
  if (result.heartbeats.length > 0) {
    mutateQueue((current) => enqueueHeartbeats(current, result.heartbeats))
      .then((next) => {
        if (next.dropped > 0) {
          lastError = `${next.dropped} heartbeats were dropped because the offline queue is full.`;
          paintStatus();
        }
      })
      .catch(() => {});
  }
  paintStatus();
}

function mutateQueue(mutator) {
  const run = queueChain.then(async () => {
    const current = extensionContext?.globalState.get(QUEUE_KEY) ?? [];
    const next = mutator(current);
    const queue = Array.isArray(next) ? next : next.queue;
    const dropped = Array.isArray(next) ? 0 : next.dropped ?? 0;
    await extensionContext?.globalState.update(QUEUE_KEY, queue);
    return { queue, dropped };
  });
  queueChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

function setPaused(paused) {
  dispatch(paused ? { type: "pause", at: nowSeconds() } : { type: "resume", at: nowSeconds() });
  if (!paused) tracker = { ...tracker, paused: false };
  extensionContext?.globalState.update(PAUSED_KEY, paused);
  paintStatus();
}

function paintStatus() {
  if (!statusBar || !extensionContext) return;
  const queued = (extensionContext.globalState.get(QUEUE_KEY) ?? []).length;
  const editor = detectEditor(vscode.env.appName) === "cursor" ? "Cursor" : "VS Code";
  let text = `Central Hub: ${editor}`;
  let detail = "Tracking active coding time.";
  if (tracker.paused) {
    text = "Central Hub: paused";
    detail = "Tracking is paused. Resume from the command palette.";
  } else if (lastError) {
    text = "Central Hub: sync error";
    detail = lastError;
  } else if (queued > 0) {
    text = `Central Hub: ${queued} queued`;
    detail = "Heartbeats are waiting to be sent.";
  }
  statusBar.text = text;
  statusBar.tooltip = detail;
}

async function showStatus() {
  const queued = (extensionContext?.globalState.get(QUEUE_KEY) ?? []).length;
  const signedIn = Boolean(await extensionContext?.secrets.get(REFRESH_SECRET));
  const lines = [
    tracker.paused ? "Tracking is paused." : "Tracking is on.",
    signedIn ? "Signed in to Central Hub." : "Not signed in. Run Central Hub: Sign In.",
    queued > 0 ? `${queued} heartbeats are waiting to be sent.` : "Nothing is waiting to be sent.",
  ];
  if (lastError) lines.push(lastError);
  vscode.window.showInformationMessage(lines.join(" "));
}

async function signIn() {
  const config = vscode.workspace.getConfiguration("centralHub");
  const url = await ask(config.get("supabaseUrl"), {
    title: "Supabase URL",
    prompt: "The same project URL as VITE_SUPABASE_URL",
    placeHolder: "https://your-project.supabase.co",
  });
  if (!url) return;
  const anonKey = await ask(config.get("supabaseAnonKey"), {
    title: "Supabase anon key",
    prompt: "The public anon key (VITE_SUPABASE_ANON_KEY). Not the service role key.",
    password: true,
  });
  if (!anonKey) return;
  const email = await vscode.window.showInputBox({
    title: "Central Hub email",
    prompt: "The email you use to sign in to Central Hub",
    ignoreFocusOut: true,
  });
  if (!email) return;
  const password = await vscode.window.showInputBox({
    title: "Central Hub password",
    prompt: "Used once to sign in. It is not stored.",
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) return;

  const request = buildSignInRequest({ url, anonKey, email, password });
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.refresh_token) {
    throw new Error(body.error_description || body.msg || "Sign-in failed.");
  }
  await extensionContext.secrets.store(REFRESH_SECRET, body.refresh_token);
  await config.update("supabaseUrl", url.trim(), vscode.ConfigurationTarget.Global);
  await config.update("supabaseAnonKey", anonKey.trim(), vscode.ConfigurationTarget.Global);
  lastError = "";
  failures = 0;
  paintStatus();
  vscode.window.showInformationMessage("Central Hub coding tracker is signed in.");
  await flush();
}

async function signOut() {
  await extensionContext?.secrets.delete(REFRESH_SECRET);
  lastError = "";
  paintStatus();
  vscode.window.showInformationMessage("Central Hub coding tracker was signed out. Queued heartbeats stay on this computer until you sign in again.");
}

async function flush() {
  if (!extensionContext || flushing) return;
  const { url, anonKey, heartbeatSeconds, idleSeconds } = settings();
  if (!url || !anonKey) {
    if ((extensionContext.globalState.get(QUEUE_KEY) ?? []).length > 0) {
      lastError = "Add the Supabase URL and anon key, then run Central Hub: Sign In.";
      paintStatus();
    }
    return;
  }
  const refreshToken = await extensionContext.secrets.get(REFRESH_SECRET);
  if (!refreshToken) {
    paintStatus();
    return;
  }

  flushing = true;
  try {
    const accessToken = await refreshAccessToken(url, anonKey, refreshToken);
    const editor = detectEditor(vscode.env.appName);
    const config = {
      editor,
      heartbeatSeconds,
      idleSeconds,
      paused: tracker.paused === true,
    };
    let guard = 0;
    for (;;) {
      const queued = (await mutateQueue((current) => current)).queue;
      const integration = await send(
        buildUpsertIntegrationRequest({
          url,
          anonKey,
          accessToken,
          status: queued.length > 0 ? "syncing" : "connected",
          config,
        })
      );
      const connection = Array.isArray(integration) ? integration[0] : integration;
      if (!connection?.id) {
        throw new Error("Central Hub did not return the coding tracker connection.");
      }
      if (queued.length === 0) break;
      const batch = queued.slice(0, 100);
      await send(
        buildInsertHeartbeatsRequest({
          url,
          anonKey,
          accessToken,
          connectionId: connection.id,
          heartbeats: batch,
        })
      );
      const remaining = (await mutateQueue((current) => acknowledgeHeartbeats(current, batch))).queue;
      await send(
        buildUpsertIntegrationRequest({
          url,
          anonKey,
          accessToken,
          status: "connected",
          lastError: null,
          lastSyncAt: new Date().toISOString(),
          config,
        })
      );
      guard += 1;
      if (remaining.length === 0 || guard >= 50) break;
    }
    failures = 0;
    lastError = "";
    paintStatus();
  } catch (error) {
    failures += 1;
    lastError = publicError(error);
    paintStatus();
    const token = await extensionContext.secrets.get(REFRESH_SECRET).catch(() => null);
    if (token && url && anonKey) {
      try {
        const accessToken = await refreshAccessToken(url, anonKey, token);
        await send(
          buildUpsertIntegrationRequest({
            url,
            anonKey,
            accessToken,
            status: "error",
            lastError,
            config: {
              editor: detectEditor(vscode.env.appName),
              heartbeatSeconds,
              idleSeconds,
              paused: tracker.paused === true,
            },
          })
        );
      } catch {
        // The status bar already shows the failure. A second failure is not a new fact.
      }
    }
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      flush().catch(() => {});
    }, nextBackoffSeconds(failures) * 1000);
  } finally {
    flushing = false;
  }
}

async function refreshAccessToken(url, anonKey, refreshToken) {
  const request = buildRefreshRequest({ url, anonKey, refreshToken });
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description || body.msg || "The Central Hub session expired. Sign in again.");
  }
  if (body.refresh_token) {
    await extensionContext.secrets.store(REFRESH_SECRET, body.refresh_token);
  }
  return body.access_token;
}

async function send(request) {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const message =
      (body && (body.message || body.error_description || body.msg || body.error)) ||
      `Central Hub returned ${response.status}.`;
    throw new Error(typeof message === "string" ? message : "Central Hub rejected the coding heartbeat.");
  }
  return body;
}

function ask(current, options) {
  const existing = String(current ?? "").trim();
  if (existing) return Promise.resolve(existing);
  return vscode.window.showInputBox({ ...options, ignoreFocusOut: true });
}

function showFailure(error) {
  lastError = publicError(error);
  paintStatus();
  vscode.window.showErrorMessage(lastError);
}

function publicError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/bearer\s+[a-z0-9._-]+/gi, "bearer [redacted]").slice(0, 300);
}

function numberSetting(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nowSeconds() {
  return Date.now() / 1000;
}
