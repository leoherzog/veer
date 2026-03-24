// Web Awesome theme and components (bundled by esbuild)
import "@awesome.me/webawesome/dist/styles/themes/awesome.css";
import "@awesome.me/webawesome/dist/styles/utilities.css";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";
import "@awesome.me/webawesome/dist/components/button-group/button-group.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
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
import "@awesome.me/webawesome/dist/components/relative-time/relative-time.js";
import "@awesome.me/webawesome/dist/components/color-picker/color-picker.js";

import "./styles/app.css";

import { authClient } from "./auth-client.js";
import { addRoute, setNotFound, resolve } from "./router.js";
import { renderNavBar } from "./components/nav-bar.js";
import { renderHome } from "./views/home.js";
import { renderLogin } from "./views/login.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderLinkDetail } from "./views/link-detail.js";
import { renderCampaignDetail } from "./views/campaign-detail.js";
import { renderSettings } from "./views/settings.js";
import { renderReport } from "./views/report.js";

let currentUser = null;

async function init() {
  // Check auth state
  try {
    const session = await authClient.getSession();
    currentUser = session?.data?.user || null;
  } catch {
    currentUser = null;
  }

  const nav = document.getElementById("nav");
  const main = document.getElementById("main");

  renderNavBar(nav, currentUser);

  let initialLoad = true;
  function render(viewFn) {
    main.innerHTML = "";
    Promise.resolve(viewFn(main)).catch((err) => {
      console.error(err);
      main.innerHTML = '<div class="wa-stack wa-align-items-center" style="padding:var(--wa-space-3xl);"><h2>Something went wrong</h2><p>Please try again.</p></div>';
    });
    if (!initialLoad) main.focus();
    initialLoad = false;
  }

  // Routes
  addRoute("/", () => render((el) => renderHome(el, currentUser)));
  addRoute("/login", () => {
    if (currentUser) return render((el) => renderHome(el, currentUser));
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
  addRoute("/r/:token", (params) => {
    render((el) => renderReport(el, params));
  });

  setNotFound(() => {
    render((el) => {
      el.innerHTML = `<div role="alert" class="wa-stack wa-align-items-center" style="padding:var(--wa-space-3xl);"><h2>Page not found</h2><p>The page you're looking for doesn't exist.</p></div>`;
    });
  });

  // Initial resolve
  resolve();
}

init();
