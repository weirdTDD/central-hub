// Saves the learning allowlist on the learning_tracker connection.
//
// The extension reads this list. An explicit array, including an empty one,
// is the owner's choice. Other connection settings (paused, browser) stay.

import { LEARNING_PROVIDER, normalizeSiteList } from "../../../extensions/learning-tracker/lib/sites.js";
import { getIntegrationByProvider, upsertIntegration } from "../../lib/integrations";

/**
 * @param {Array<object>} sites
 * @returns {Promise<object>} the stored connection
 */
export async function saveTrackedSites(sites) {
  const normalized = normalizeSiteList(sites);
  const existing = await getIntegrationByProvider(LEARNING_PROVIDER);
  const previous =
    existing?.config && typeof existing.config === "object" && !Array.isArray(existing.config)
      ? existing.config
      : {};
  return upsertIntegration({
    provider: LEARNING_PROVIDER,
    label: existing?.label || "Learning tracker",
    status: existing?.status ?? "disconnected",
    config: { ...previous, sites: normalized },
    lastError: existing?.last_error ?? null,
    lastSyncAt: existing?.last_sync_at ?? null,
  });
}
