// Web Awesome theme and components (bundled by esbuild)
import "@web.awesome.me/webawesome-pro/dist/styles/themes/matter.css";
import "@web.awesome.me/webawesome-pro/dist/styles/utilities.css";
import "@web.awesome.me/webawesome-pro/dist/components/button/button.js";
import "@web.awesome.me/webawesome-pro/dist/components/icon/icon.js";
import "@web.awesome.me/webawesome-pro/dist/components/button-group/button-group.js";
import "@web.awesome.me/webawesome-pro/dist/components/input/input.js";
import "@web.awesome.me/webawesome-pro/dist/components/card/card.js";
import "@web.awesome.me/webawesome-pro/dist/components/details/details.js";
import "@web.awesome.me/webawesome-pro/dist/components/avatar/avatar.js";
import "@web.awesome.me/webawesome-pro/dist/components/spinner/spinner.js";
import "@web.awesome.me/webawesome-pro/dist/components/toast/toast.js";
import "@web.awesome.me/webawesome-pro/dist/components/copy-button/copy-button.js";
import "@web.awesome.me/webawesome-pro/dist/components/radio-group/radio-group.js";
import "@web.awesome.me/webawesome-pro/dist/components/radio/radio.js";
import "@web.awesome.me/webawesome-pro/dist/components/skeleton/skeleton.js";
import "@web.awesome.me/webawesome-pro/dist/components/divider/divider.js";
import "@web.awesome.me/webawesome-pro/dist/components/line-chart/line-chart.js";
import "@web.awesome.me/webawesome-pro/dist/components/bar-chart/bar-chart.js";
import "@web.awesome.me/webawesome-pro/dist/components/doughnut-chart/doughnut-chart.js";
import "@web.awesome.me/webawesome-pro/dist/components/switch/switch.js";
import "@web.awesome.me/webawesome-pro/dist/components/textarea/textarea.js";
import "@web.awesome.me/webawesome-pro/dist/components/qr-code/qr-code.js";
import "@web.awesome.me/webawesome-pro/dist/components/badge/badge.js";
import "@web.awesome.me/webawesome-pro/dist/components/dropdown/dropdown.js";
import "@web.awesome.me/webawesome-pro/dist/components/dropdown-item/dropdown-item.js";

import "./styles/app.css";

import { authClient } from "./auth-client.js";
import { addRoute, setNotFound, resolve } from "./router.js";
import { renderNavBar } from "./components/nav-bar.js";
import { renderHome } from "./views/home.js";
import { renderLogin } from "./views/login.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderLinkDetail } from "./views/link-detail.js";

// Theme initialization
const root = document.documentElement;
const saved = localStorage.getItem("theme");
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
const theme = saved || (prefersDark ? "wa-dark" : "wa-light");
root.classList.remove("wa-light", "wa-dark");
root.classList.add(theme);

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
      main.innerHTML = '<div style="text-align:center;padding:3rem;"><h2>Something went wrong</h2><p>Please try again.</p></div>';
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
  addRoute("/dashboard", () => {
    if (!currentUser) return render((el) => renderLogin(el));
    render((el) => renderDashboard(el));
  });
  addRoute("/links/:id", (params) => {
    if (!currentUser) return render((el) => renderLogin(el));
    render((el) => renderLinkDetail(el, params));
  });

  setNotFound(() => {
    render((el) => {
      el.innerHTML = `<div role="alert" style="text-align:center;padding:3rem;"><h2>Page not found</h2><p>The page you're looking for doesn't exist.</p></div>`;
    });
  });

  // Initial resolve
  resolve();
}

init();
