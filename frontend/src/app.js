// Web Awesome theme and components (bundled by esbuild)
import "@awesome.me/webawesome/dist/styles/native.css";
import "@awesome.me/webawesome/dist/styles/themes/awesome.css";
import "@awesome.me/webawesome/dist/styles/utilities.css";
import "@awesome.me/webawesome/dist/components/page/page.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";
import "@awesome.me/webawesome/dist/components/button-group/button-group.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/number-input/number-input.js";
import "@awesome.me/webawesome/dist/components/card/card.js";
import "@awesome.me/webawesome/dist/components/details/details.js";
import "@awesome.me/webawesome/dist/components/avatar/avatar.js";
import "@awesome.me/webawesome/dist/components/spinner/spinner.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";
import "@awesome.me/webawesome/dist/components/copy-button/copy-button.js";
import "@awesome.me/webawesome/dist/components/radio-group/radio-group.js";
import "@awesome.me/webawesome/dist/components/radio/radio.js";
import "@awesome.me/webawesome/dist/components/skeleton/skeleton.js";
import "@awesome.me/webawesome/dist/components/divider/divider.js";
import "@awesome.me/webawesome/dist/components/switch/switch.js";
import "@awesome.me/webawesome/dist/components/textarea/textarea.js";
import "@awesome.me/webawesome/dist/components/qr-code/qr-code.js";
import "@awesome.me/webawesome/dist/components/badge/badge.js";
import "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/option/option.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import "@awesome.me/webawesome/dist/components/tab/tab.js";
import "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";
import "@awesome.me/webawesome/dist/components/tooltip/tooltip.js";
import "@awesome.me/webawesome/dist/components/pagination/pagination.js";
import "@awesome.me/webawesome/dist/components/toast/toast.js";
import "@awesome.me/webawesome/dist/components/toast-item/toast-item.js";
import "@awesome.me/webawesome/dist/components/relative-time/relative-time.js";
import "@awesome.me/webawesome/dist/components/format-number/format-number.js";
import "@awesome.me/webawesome/dist/components/color-picker/color-picker.js";

import "./styles/app.css";

import { authClient } from "./auth-client.js";
import { loadConfig, isDemoMode } from "./lib/config.js";
import { addRoute, setNotFound, resolve, navigate } from "./router.js";
import { renderNavBar } from "./components/nav-bar.js";
import { showNotice } from "./components/toast.js";
import { renderHome } from "./views/home.js";
import { renderLogin } from "./views/login.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderLinkDetail } from "./views/link-detail.js";
import { renderCampaignDetail } from "./views/campaign-detail.js";
import { renderSettings } from "./views/settings.js";
import { renderReport } from "./views/report.js";
import { renderAdmin, isImpersonating, getImpersonationBanner, bindImpersonationBanner } from "./views/admin.js";
import { renderAcceptInvite } from "./views/accept-invite.js";

let currentUser = null;

async function init() {
  // The title, nav brand and login view read the instance config synchronously.
  await loadConfig();

  // Outside demo mode, the client get-session call is the only request that
  // rolls the session cookie and refills the cookie cache, because the
  // server-side session check drops its Set-Cookie headers.
  try {
    const signedIn = isDemoMode() || (await authClient.getSession())?.data?.user;
    const res = signedIn ? await fetch("/api/me") : null;
    currentUser = res?.ok ? (await res.json()).data : null;
  } catch {
    currentUser = null;
  }

  const nav = document.getElementById("nav");
  const main = document.getElementById("main");

  renderNavBar(nav, currentUser);

  // Focus #main on navigation for screen readers, but not during bootstrap,
  // where it leaves a focus ring on first paint. The flag spans the whole
  // bootstrap, not one render, because the "/" to "/links" redirect renders
  // reentrantly during first load.
  let bootstrapping = true;
  function render(viewFn) {
    // Each render owns a fresh element, so a view that resolves after a newer
    // navigation writes into a node already detached from #main.
    const view = document.createElement("div");
    main.replaceChildren(view);
    Promise.resolve(viewFn(view)).catch((err) => {
      console.error(err);
      view.innerHTML = '<div class="wa-stack wa-align-items-center"><h2>Something went wrong</h2><p>Please try again.</p></div>';
    });
    if (!bootstrapping) main.focus();
  }

  // A signed-out visit renders the login view in place, so the URL survives as
  // the OAuth callbackURL.
  const authed = (view) => (params) => render(currentUser ? (el) => view(el, params) : renderLogin);

  addRoute("/", () => render((el) => renderHome(el, currentUser)));
  addRoute("/login", () => {
    // Replace rather than push: /login must not sit in history behind /links.
    if (currentUser) return navigate("/links", true);
    render(renderLogin);
  });
  addRoute("/links", authed((el) => renderDashboard(el, { user: currentUser })));
  addRoute("/campaigns", authed((el) => renderDashboard(el, { activeTab: "campaigns", user: currentUser })));
  addRoute("/links/:id", authed(renderLinkDetail));
  addRoute("/campaigns/:id", authed(renderCampaignDetail));
  addRoute("/settings", authed((el) => renderSettings(el, { user: currentUser })));
  addRoute("/teams", authed((el) => renderDashboard(el, { activeTab: "teams", user: currentUser })));
  addRoute("/teams/:id", authed((el, params) => renderDashboard(el, { activeTab: "teams", teamId: params.id, user: currentUser })));
  addRoute("/admin", authed((el) => {
    if (currentUser.isAdmin) return renderAdmin(el);
    el.innerHTML = `<div role="alert" class="wa-stack wa-align-items-center"><h2>Access denied</h2><p>You do not have admin access.</p></div>`;
  }));
  addRoute("/r/:token", (params) => render((el) => renderReport(el, params)));
  addRoute("/invite/:token", authed(renderAcceptInvite));

  setNotFound(() => {
    render((el) => {
      el.innerHTML = `<div role="alert" class="wa-stack wa-align-items-center"><h2>Page not found</h2><p>The page you're looking for doesn't exist.</p></div>`;
    });
  });

  // The impersonation banner goes in wa-page's sticky banner slot.
  const page = document.querySelector("wa-page");

  // Impersonation is meaningless in demo mode.
  if (isImpersonating() && !isDemoMode()) {
    page.insertAdjacentHTML("afterbegin", getImpersonationBanner());
    bindImpersonationBanner();
  } else if (isDemoMode() && isImpersonating()) {
    sessionStorage.removeItem("veer_impersonating_from");
  }

  // Demo mode: persistent notice + body class for CSS-based button hiding.
  if (isDemoMode()) {
    document.body.classList.add("demo-mode");
    showNotice(
      `Demo instance — write actions are disabled.
       <a href="https://github.com/leoherzog/veer" target="_blank" rel="noopener noreferrer">Clone the repo</a> to host your own.`,
      "brand",
    );
  }

  // Initial resolve. resolve() runs synchronously (including any bootstrap
  // redirect like "/" → "/links"), so clearing the flag afterward leaves the
  // first paint focus-free while later navigations still move focus to #main.
  resolve();
  bootstrapping = false;
}

document.addEventListener("click", (e) => {
  const link = e.target.closest("[data-link]");
  if (!link) return;
  e.preventDefault();
  navigate(link.getAttribute("href"));
});

// Nothing else clears the FOUCE cloak when components are imported
// individually. Left on, it re-hides the page for 2s whenever an undefined
// element appears. `finally` so a failed boot cannot strand the page behind it.
init().finally(() => {
  document.documentElement.classList.remove("wa-cloak");
});
