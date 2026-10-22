// Local collectors for the dev server.
//
// The browser cannot read VS Code's history folder or Chrome's History database.
// This middleware runs in the Vite process, on this computer, and only when the
// user asks. It returns a minimised payload: file names for VS Code, host names
// for Chrome. Full paths, page titles, and URL paths stay here.

import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_RECORDS = 400;
const SKIP_USERS = new Set(["Public", "Default", "Default User", "All Users"]);

const CHROME_READER = `
import json, pathlib, sqlite3, sys, tempfile, os
src = sys.argv[1]
uri = pathlib.Path(src).as_uri() + "?mode=ro"
source = sqlite3.connect(uri, uri=True)
tmp = tempfile.NamedTemporaryFile(prefix="hub-history-", suffix=".sqlite", delete=False)
tmp.close()
copy = sqlite3.connect(tmp.name)
source.backup(copy)
source.close()
rows = copy.execute(
    """
    SELECT u.url, v.visit_time, v.visit_duration
    FROM visits v
    JOIN urls u ON u.id = v.url
    ORDER BY v.visit_time DESC
    LIMIT 800
    """
).fetchall()
copy.close()
os.remove(tmp.name)
json.dump([[url, visit_time, duration] for url, visit_time, duration in rows], sys.stdout)
`;

export function localConnectorsPlugin() {
  return {
    name: "local-connectors",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split("?")[0];
        if (url !== "/api/connectors/collect") return next();
        if (req.method !== "POST") {
          send(res, 405, { ok: false, error: "Sync uses POST." });
          return;
        }

        try {
          const body = await readJson(req);
          const payload = collect(body?.provider);
          send(res, 200, { ok: true, payload });
        } catch (error) {
          send(res, 500, { ok: false, error: publicMessage(error) });
        }
      });
    },
  };
}

/**
 * @param {string} provider "vscode" or "browser"
 * @returns {{version: number, records: Array<object>}}
 */
export function collect(provider) {
  if (provider === "vscode") return collectVscode();
  if (provider === "browser") return collectBrowser();
  throw new Error("That connector is not available on this computer.");
}

function collectVscode() {
  const folder = newestExisting(vscodeHistoryCandidates());
  if (!folder) {
    throw new Error("VS Code local history was not found on this computer.");
  }

  const records = [];
  for (const bucket of fs.readdirSync(folder)) {
    const file = path.join(folder, bucket, "entries.json");
    if (!fs.existsSync(file)) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const fileName = fileNameFromResource(data?.resource);
    if (!fileName) continue;
    for (const entry of data.entries ?? []) {
      const timestamp = Number(entry?.timestamp);
      if (!Number.isFinite(timestamp)) continue;
      records.push({
        occurred_at: new Date(timestamp).toISOString(),
        file_name: fileName,
      });
    }
  }

  records.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
  return { version: 1, records: records.slice(0, MAX_RECORDS) };
}

function collectBrowser() {
  const database = newestExisting(chromeHistoryCandidates());
  if (!database) {
    throw new Error("Chrome history was not found on this computer.");
  }

  const python = spawnSync("python3", ["-c", CHROME_READER, database], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (python.status !== 0) {
    throw new Error("Chrome history could not be read.");
  }

  let rows;
  try {
    rows = JSON.parse(python.stdout);
  } catch {
    throw new Error("Chrome history could not be read.");
  }

  const records = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const host = hostOf(row[0]);
    const occurredAt = chromeTimeToIso(row[1]);
    if (!host || !occurredAt) continue;
    records.push({
      occurred_at: occurredAt,
      host,
      duration_seconds: durationSeconds(row[2]),
    });
    if (records.length >= MAX_RECORDS) break;
  }

  return { version: 1, records };
}

function vscodeHistoryCandidates() {
  const found = [];
  for (const user of windowsUsers()) {
    found.push(
      path.join("/mnt/c/Users", user, "AppData/Roaming/Code/User/History")
    );
  }
  found.push(path.join(os.homedir(), ".config/Code/User/History"));
  return found;
}

function chromeHistoryCandidates() {
  const found = [];
  for (const user of windowsUsers()) {
    found.push(
      path.join(
        "/mnt/c/Users",
        user,
        "AppData/Local/Google/Chrome/User Data/Default/History"
      )
    );
  }
  found.push(path.join(os.homedir(), ".config/google-chrome/Default/History"));
  return found;
}

function windowsUsers() {
  const root = "/mnt/c/Users";
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => !SKIP_USERS.has(name) && !name.startsWith("."));
}

function newestExisting(candidates) {
  const existing = candidates.filter((candidate) => fs.existsSync(candidate));
  existing.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return existing[0] ?? null;
}

function fileNameFromResource(resource) {
  if (typeof resource !== "string" || resource.trim() === "") return null;
  let pathname = resource;
  try {
    pathname = decodeURIComponent(new URL(resource).pathname);
  } catch {
    pathname = resource;
  }
  const base = pathname.split(/[/\\]/).filter(Boolean).pop() ?? "";
  if (!base || base.includes("..")) return null;
  return base;
}

function hostOf(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function chromeTimeToIso(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  const unixMs = (raw - 11644473600000000) / 1000;
  const date = new Date(unixMs);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function durationSeconds(value) {
  const micros = Number(value);
  if (!Number.isFinite(micros) || micros <= 0) return null;
  const seconds = Math.round(micros / 1_000_000);
  if (seconds <= 0 || seconds > 12 * 60 * 60) return null;
  return seconds;
}

function publicMessage(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\/mnt\/c\/Users\/[^/\s]+/g, "this computer");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("The sync request was not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
