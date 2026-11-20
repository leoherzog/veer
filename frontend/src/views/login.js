import { authClient, isPasskeyCancel } from "../auth-client.js";
import { showToast } from "../components/toast.js";
import { getInstanceName, getLoginOptions } from "../lib/config.js";
import { escapeHtml } from "../lib/escape.js";
import { withLoadingBtn } from "../lib/ui.js";

/**
 * Where OAuth should return the browser. The login view renders in place on
 * whatever route required auth, so the current location is the deep link the
 * user asked for; /login itself would bounce them straight back here.
 */
function callbackTarget() {
  return location.pathname === "/login" ? "/links" : location.pathname + location.search;
}

const allProviders = [
  { id: "google", name: "Google" },
  { id: "github", name: "GitHub" },
  { id: "microsoft", name: "Microsoft" },
  { id: "discord", name: "Discord" },
];

/**
 * Start OAuth with provider `p`. The client resolves `{ error }` on an HTTP
 * failure and throws only on a network failure; both toast.
 * @returns {Promise<boolean>} false when sign-in failed to start.
 */
async function socialSignIn(p) {
  const { error } = await authClient.signIn.social({ provider: p.id, callbackURL: callbackTarget() })
    .catch((e) => ({ error: e }));
  if (error) showToast(`Sign in with ${p.name} failed`, "danger");
  return !error;
}

function renderButtons(container, providers) {
  const wrapper = container.querySelector("#provider-buttons");
  wrapper.innerHTML = providers.map((p) => `
    <wa-button variant="neutral" appearance="outlined" size="l" data-provider="${p.id}">
      <wa-icon slot="start" name="${p.id}" family="brands"></wa-icon>
      Continue with ${p.name}
    </wa-button>
  `).join("");

  for (const p of providers) {
    wrapper.querySelector(`[data-provider="${p.id}"]`).addEventListener("click", () => socialSignIn(p));
  }
}

function bindPasskeyButton(btn) {
  btn.addEventListener("click", () => withLoadingBtn(btn, async () => {
    const { error } = await authClient.signIn.passkey().catch((e) => ({ error: e }));
    if (!error) {
      location.href = callbackTarget();
    } else if (isPasskeyCancel(error)) {
      showToast("Passkey sign-in cancelled", "warning");
    } else {
      showToast(error.message || "Passkey sign-in failed", "danger");
    }
  }));
}

export function renderLogin(container) {
  const options = getLoginOptions();
  const passkey = options?.passkey === true;
  const providers = allProviders.filter((p) => options?.providers.includes(p.id));

  let help = "Choose a provider to continue";
  if (!options) help = "Failed to load login providers. Please refresh to try again.";
  else if (!providers.length) help = passkey ? "Sign in with your passkey to continue" : "Have your administrator configure at least one login provider";

  container.innerHTML = `
    <div class="wa-stack wa-gap-l wa-text-center">
      <h1>Sign in to ${escapeHtml(getInstanceName())}</h1>
      <p id="login-help">${help}</p>
      ${providers.length ? `<div class="wa-stack wa-gap-s" id="provider-buttons"></div>` : ""}
      ${passkey ? `
        ${providers.length ? "<wa-divider></wa-divider>" : ""}
        <wa-button id="passkey-signin" variant="brand" size="l">
          <wa-icon slot="start" name="key"></wa-icon>
          Sign in with passkey
        </wa-button>
      ` : ""}
    </div>
  `;

  // Single provider, no passkey: go straight to the provider, and fall back to
  // the button if the redirect fails to start.
  if (providers.length === 1 && !passkey) {
    const helpEl = container.querySelector("#login-help");
    helpEl.textContent = `Redirecting to ${providers[0].name}…`;
    socialSignIn(providers[0]).then((ok) => {
      if (ok) return;
      renderButtons(container, providers);
      helpEl.textContent = help;
    });
    return;
  }

  if (providers.length) renderButtons(container, providers);
  if (passkey) bindPasskeyButton(container.querySelector("#passkey-signin"));
}
