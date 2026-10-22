import { createClient } from "@supabase/supabase-js";

// `import.meta.env` is injected by Vite. It does not exist in plain Node (the
// verification scripts) or in Deno (the Edge Function), so the environment is
// read defensively: the module must LOAD everywhere, and a project without
// Supabase must degrade to "not configured" rather than to a crash at import
// time. In the browser Vite's values win; outside it, `process.env` is used, so
// the same module can be pointed at a local database by a test harness.
const viteEnv = (typeof import.meta !== "undefined" && import.meta.env) || {};
// `globalThis.process` rather than `process`: the browser has no `process`, and
// a bare reference to it is a `no-undef` error even behind a `typeof` guard.
const nodeEnv =
  (typeof globalThis !== "undefined" && globalThis.process?.env) || {};
const env = { ...nodeEnv, ...viteEnv };
const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY;

/**
 * True when both Supabase env vars are present.
 *
 * createClient() THROWS ("supabaseUrl is required.") when the URL is missing, so the
 * client must not be constructed eagerly in an unconfigured project — otherwise the
 * import graph fails at module load and the whole app renders a blank screen.
 */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export const SUPABASE_NOT_CONFIGURED_MESSAGE =
  "Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your .env file and restart the dev server.";
