// Sentral Hub — the AI provider registry.
//
// Serves MASTER_SPEC Section 7G: "the app MUST fully work with AI disabled or
// unconfigured". The registry is how that promise is kept: the on-device
// provider is always present and always available, and every other provider is
// an OPTION. Nothing in the app may depend on a provider that might be missing.
//
// This module is deliberately PURE so its rules can be verified with plain Node
// assertions — see scripts/verify-ai.mjs.

import { localProvider, PROVIDER_ID as LOCAL_PROVIDER_ID } from "./localProvider.js";
import { xaiProvider, PROVIDER_ID as XAI_PROVIDER_ID } from "./xaiProvider.js";
import { DEFAULT_PROVIDER_ID } from "./contract.js";

/** Every provider the app knows. */
const PROVIDERS = [localProvider, xaiProvider];

/**
 * Every registered provider.
 *
 * @returns {import("./contract.js").AiProvider[]}
 */
export function listProviders() {
  return [...PROVIDERS];
}

/**
 * One provider by its id.
 *
 * @param {string} id
 * @returns {import("./contract.js").AiProvider|null} the provider, or null when
 *   the id is unknown
 */
export function getProvider(id) {
  return PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/**
 * The provider to use for a request.
 *
 * An unknown or unavailable provider FALLS BACK to the on-device provider
 * rather than failing: the app has to keep working when AI is off.
 *
 * @param {string} id the preferred provider id
 * @returns {import("./contract.js").AiProvider}
 */
export function resolveProvider(id) {
  const preferred = getProvider(id);
  if (preferred && isProviderAvailable(preferred)) return preferred;
  return localProvider;
}

/**
 * True when a provider can actually be used right now.
 *
 * @param {import("./contract.js").AiProvider} provider
 * @returns {boolean}
 */
export function isProviderAvailable(provider) {
  if (!provider) return false;
  if (typeof provider.available !== "function") return true;
  try {
    return provider.available() === true;
  } catch {
    return false;
  }
}

/**
 * True when the given provider id would actually be used.
 *
 * This is what the UI asks before offering a provider: a provider that is
 * registered but not available is not something the user can select.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isAiConfigured(id) {
  const provider = getProvider(id);
  return isProviderAvailable(provider);
}

/**
 * True when the app is running WITHOUT an AI provider — the on-device one.
 *
 * The UI states this plainly rather than implying a model was involved.
 *
 * @param {string} id the selected provider id
 * @returns {boolean}
 */
export function isOnDeviceOnly(id) {
  return (id ?? DEFAULT_PROVIDER_ID) === LOCAL_PROVIDER_ID;
}

export { LOCAL_PROVIDER_ID, XAI_PROVIDER_ID, DEFAULT_PROVIDER_ID };
