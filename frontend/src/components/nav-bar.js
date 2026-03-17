import { authClient } from "../auth-client.js";
import { navigate } from "../router.js";
import { escapeAttr } from "../lib/escape.js";

export function renderNavBar(container, user) {
  container.innerHTML = `
    <nav class="nav-bar">
      <div class="nav-left">
        <a href="/" class="nav-logo" data-link>Veer</a>
        ${user ? `<a href="/dashboard" class="nav-link" data-link>Dashboard</a>` : ""}
      </div>
      <div class="nav-right">
        <wa-button id="theme-toggle" size="small" variant="neutral" appearance="plain" circle><wa-icon name="circle-half-stroke" label="Toggle theme"></wa-icon></wa-button>
        ${user
          ? `
            <wa-avatar id="user-avatar" image="${escapeAttr(user.image || "")}" label="${escapeAttr(user.name)}" style="--size: 2rem;"></wa-avatar>
            <wa-button size="small" variant="neutral" appearance="outlined" id="logout-btn">Logout</wa-button>
          `
          : `<wa-button size="small" variant="brand" id="login-btn">Login</wa-button>`
        }
      </div>
    </nav>
  `;

  // Theme toggle
  container.querySelector("#theme-toggle")?.addEventListener("click", () => {
    const root = document.documentElement;
    const isDark = root.classList.contains("wa-dark");
    root.classList.remove(isDark ? "wa-dark" : "wa-light");
    root.classList.add(isDark ? "wa-light" : "wa-dark");
    localStorage.setItem("theme", isDark ? "wa-light" : "wa-dark");
  });

  // Navigation
  container.querySelectorAll("[data-link]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(el.getAttribute("href"));
    });
  });

  container.querySelector("#login-btn")?.addEventListener("click", () => navigate("/login"));

  container.querySelector("#logout-btn")?.addEventListener("click", async () => {
    await authClient.signOut();
    history.replaceState(null, "", "/");
    location.reload();
  });
}
