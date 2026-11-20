import { createAuthClient } from "better-auth/client";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
  plugins: [passkeyClient()],
});

/**
 * Codes the passkey client returns when the browser prompt was dismissed, timed
 * out (a WebAuthn NotAllowedError) or aborted.
 */
const CANCELLED_CEREMONY = new Set(["ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", "ERROR_CEREMONY_ABORTED"]);

/** True when a passkey client `error` means the user cancelled the ceremony. */
export function isPasskeyCancel(error) {
  return CANCELLED_CEREMONY.has(error?.code);
}
