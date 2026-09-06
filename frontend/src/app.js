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
  // Load instance branding before first render so titles/logos aren't empty
  await loadConfig();

  if (isDemoMode()) {
    // Skip OAuth entirely — backend auto-injects the synthetic user.
    currentUser = {
      id: "demo-user",
      name: "Demo User",
      email: "demo@veer.example",
      image: null,
      isAdmin: false,
    };
  } else {
    // Check auth state
    try {
      const session = await authClient.getSession();
      currentUser = session?.data?.user || null;
      // Enrich with server-side user data (isAdmin, etc.)
      if (currentUser) {
        try {
          const meRes = await fetch("/api/me");
          if (meRes.ok) {
            const { data: meData } = await meRes.json();
            if (meData) currentUser = { ...currentUser, ...meData };
          }
        } catch { /* use basic session data */ }
      }
    } catch {
      currentUser = null;
    }
  }

  const nav = document.getElementById("nav");
  const main = document.getElementById("main");

  renderNavBar(nav, currentUser);

  // Move focus to #main on route changes so screen-reader users land on the new
  // content. Skip this during the initial bootstrap, otherwise the first paint
  // leaves a focus ring on #main (Firefox shows :focus-visible for programmatic
  // focus until the next pointer interaction). The flag must be module-scoped to
  // the bootstrap rather than per-render: the "/" → "/links" redirect renders
  // reentrantly during the first load, and that nested render is still bootstrap.
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

  // Routes
  addRoute("/", () => render((el) => renderHome(el, currentUser)));
  addRoute("/login", () => {
    // Replace rather than push: /login must not sit in history behind /links.
    if (currentUser) return navigate("/links", true);
    render((el) => renderLogin(el));
  });
  addRoute("/links", () => {
    if (!currentUser) return render((el) => renderLogin(el));
    render((el) => renderDashboard(el));
  });
  addRoute("/campaigns", () => {
    if (!currentUser) return render((el) => renderLogin(el));
    render((el) => renderDashboard(el, { activeTab: "campaigns" }));
  });
  addRoute("/links/:id", (params) => {
    if (!currentUser) return render((el) => renderLogin(el));
    render((el) => renderLinkDetail(el, params));
  });
  addRoute("/campaigns/:id", (params) => {
    if (!currentUser) return render((el) => renderLogin(el));
    render((el) => renderCampaignDetail(el, params));
  });
  addRoute("/settings", () => {
    if (!currentUser) return render((el) => renderLogin(el));
    render((el) => renderSettings(el));
  });
  addRoute("/teams", () => {
    if (!currentUser) return render((el) => renderLogin(el));
    render((el) => renderDashboard(el, { activeTab: "teams" }));
  });
  addRoute("/teams/:id", (params) => {
    if (!currentUser) return render((el) => renderLogin(el));
    render((el) => renderDashboard(el, { activeTab: "teams", teamId: params.id }));
  });
  addRoute("/admin", () => {
    if (!currentUser) return render((el) => renderLogin(el));
    if (!currentUser.isAdmin) {
      render((el) => { el.innerHTML = `<div role="alert" class="wa-stack wa-align-items-center"><h2>Access denied</h2><p>You do not have admin access.</p></div>`; });
      return;
    }
    render((el) => renderAdmin(el));
  });
  addRoute("/r/:token", (params) => {
    render((el) => renderReport(el, params));
  });

  addRoute("/invite/:token", (params) => {
    if (!currentUser) return render((el) => renderLogin(el));
    render((el) => renderAcceptInvite(el, params));
  });

  setNotFound(() => {
    render((el) => {
      el.innerHTML = `<div role="alert" class="wa-stack wa-align-items-center"><h2>Page not found</h2><p>The page you're looking for doesn't exist.</p></div>`;
    });
  });

  // Banners render in wa-page's `banner` slot (sticky above the header; the
  // page measures the slot itself, so no manual body padding is needed).
  const page = document.querySelector("wa-page");

  // Impersonation banner (suppressed in demo mode — impersonation isn't a
  // thing without real users, and stacking with the demo banner clips content)
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

// Drop the FOUCE cloak once the app has booted. `.wa-cloak:has(:not(:defined))`
// hides the entire document for 2s every time it starts matching, and nothing
// else removes the class — we import components individually instead of using
// WA's loader, which is what normally clears it. All components this bundle
// registers are defined by the time the module finishes evaluating, so the
// cloak has done its job; leaving it on would re-hide the whole app on any
// later navigation that introduces an element we forgot to import. `finally`
// so a failed boot can't strand the page behind the cloak.
init().finally(() => {
  document.documentElement.classList.remove("wa-cloak");
});
