import { authClient } from "../auth-client.js";
import { showToast } from "../components/toast.js";
import { getInstanceName, getLoginOptions } from "../lib/config.js";
import { escapeHtml } from "../lib/escape.js";

/**
 * Where OAuth should return the browser. The login view renders in place on
 * whatever route required auth, so the current location is the deep link the
 * user asked for; /login itself would bounce them straight back here.
 */
function callbackTarget() {
  const path = location.pathname + location.search;
  return path === "/login" || path.startsWith("/login?") ? "/links" : path;
}

const allProviders = [
  { id: "google", name: "Google", icon: "google" },
  { id: "github", name: "GitHub", icon: "github" },
  { id: "microsoft", name: "Microsoft", icon: "microsoft" },
  { id: "discord", name: "Discord", icon: "discord" },
];

function renderButtons(container, providers) {
  const wrapper = container.querySelector("#provider-buttons");
  wrapper.innerHTML = providers.map((p) => `
    <wa-button variant="neutral" appearance="outlined" size="l" data-provider="${p.id}">
      <wa-icon slot="start" name="${p.icon}" family="brands"></wa-icon>
      Continue with ${p.name}
    </wa-button>
  `).join("");

  wrapper.querySelectorAll("[data-provider]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const provider = btn.dataset.provider;
      try {
        await authClient.signIn.social({
          provider,
          callbackURL: callbackTarget(),
        });
      } catch {
        showToast(`Sign in with ${provider} failed`, "danger");
      }
    });
  });
}

function renderPasskeyButton(container, enabled) {
  if (!enabled) return;
  const section = container.querySelector("#passkey-section");
  section.hidden = false;
  const btn = section.querySelector("#passkey-signin");
  btn.addEventListener("click", async () => {
    btn.loading = true;
    try {
      const result = await authClient.signIn.passkey();
      if (result?.error) {
        showToast(result.error.message || "Passkey sign-in failed", "danger");
      } else {
        window.location.href = callbackTarget();
      }
    } catch {
      showToast("Passkey sign-in failed", "danger");
    } finally {
      btn.loading = false;
    }
  });
}

export function renderLogin(container) {
  container.innerHTML = `
    <div class="wa-stack wa-gap-l wa-text-center">
      <h1>Sign in to ${escapeHtml(getInstanceName())}</h1>
      <p id="login-help">Choose a provider to continue</p>
      <div class="wa-stack wa-gap-s" id="provider-buttons"></div>
      <div id="passkey-section" hidden>
        <wa-divider></wa-divider>
        <wa-button id="passkey-signin" variant="brand" size="l" style="width:100%;">
          <wa-icon slot="start" name="key"></wa-icon>
          Sign in with passkey
        </wa-button>
      </div>
    </div>
  `;

  const help = container.querySelector("#login-help");
  const options = getLoginOptions();
  if (!options) {
    help.textContent = "Failed to load login providers. Please refresh to try again.";
    return;
  }
  const { passkey } = options;
  const providers = allProviders.filter((p) => options.providers.includes(p.id));

  // Single provider, no passkey — skip login page and redirect immediately
  if (providers.length === 1 && !passkey) {
    help.textContent = `Redirecting to ${providers[0].name}…`;
    authClient.signIn.social({
      provider: providers[0].id,
      callbackURL: callbackTarget(),
    }).catch(() => {
      showToast(`Sign in with ${providers[0].name} failed`, "danger");
      renderButtons(container, providers);
      help.textContent = "Choose a provider to continue";
    });
    return;
  }

  renderButtons(container, providers);
  renderPasskeyButton(container, passkey);
  if (!providers.length && !passkey) {
    help.textContent = "Have your administrator configure at least one login provider";
  }
}
