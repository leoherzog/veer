import { authClient } from "../auth-client.js";
import { navigate } from "../router.js";
import { escapeAttr } from "../lib/escape.js";

export function renderNavBar(container, user) {
  container.innerHTML = `
    <nav class="nav-bar wa-split">
      <div class="nav-left wa-cluster wa-gap-m">
        <a href="${user ? "/links" : "/"}" class="nav-logo" data-link>Veer</a>
      </div>
      <div class="nav-right wa-cluster wa-gap-m">
        ${user
          ? `
            <wa-dropdown placement="bottom-end">
              <wa-button slot="trigger" variant="neutral" appearance="plain" circle>
                <wa-avatar id="user-avatar" image="${escapeAttr(user.image || "")}" label="${escapeAttr(user.name)}" style="--size: 2rem;"></wa-avatar>
              </wa-button>
              <wa-dropdown-item id="theme-toggle">
                <wa-icon slot="icon" name="${document.documentElement.classList.contains("wa-dark") ? "sun" : "moon"}"></wa-icon>
                ${document.documentElement.classList.contains("wa-dark") ? "Light Mode" : "Dark Mode"}
              </wa-dropdown-item>
              <wa-divider></wa-divider>
              <wa-dropdown-item id="logout-btn">
                <wa-icon slot="icon" name="right-from-bracket"></wa-icon>
                Logout
              </wa-dropdown-item>
            </wa-dropdown>
          `
          : `
            <wa-button id="theme-toggle" size="small" variant="neutral" appearance="plain" circle><wa-icon name="${document.documentElement.classList.contains("wa-dark") ? "sun" : "moon"}" label="${document.documentElement.classList.contains("wa-dark") ? "Light Mode" : "Dark Mode"}"></wa-icon></wa-button>
            <wa-button size="small" variant="brand" id="login-btn">Login</wa-button>
          `
        }
      </div>
    </nav>
  `;

  // Avatar dropdown menu
  const dropdown = container.querySelector("wa-dropdown");
  if (dropdown) {
    dropdown.addEventListener("wa-select", async (e) => {
      const item = e.detail.item;
      if (item.id === "theme-toggle") {
        const root = document.documentElement;
        const isDark = root.classList.contains("wa-dark");
        root.classList.remove(isDark ? "wa-dark" : "wa-light");
        root.classList.add(isDark ? "wa-light" : "wa-dark");
        localStorage.setItem("theme", isDark ? "wa-light" : "wa-dark");
        const icon = item.querySelector("wa-icon");
        if (icon) icon.name = isDark ? "moon" : "sun";
        item.lastChild.textContent = isDark ? " Dark Mode" : " Light Mode";
      } else if (item.id === "logout-btn") {
        await authClient.signOut();
        history.replaceState(null, "", "/");
        location.reload();
      }
    });
  }

  // Theme toggle (logged-out state)
  if (!user) {
    container.querySelector("#theme-toggle")?.addEventListener("click", () => {
      const root = document.documentElement;
      const isDark = root.classList.contains("wa-dark");
      root.classList.remove(isDark ? "wa-dark" : "wa-light");
      root.classList.add(isDark ? "wa-light" : "wa-dark");
      localStorage.setItem("theme", isDark ? "wa-light" : "wa-dark");
      const icon = container.querySelector("#theme-toggle wa-icon");
      if (icon) {
        icon.name = isDark ? "moon" : "sun";
        icon.label = isDark ? "Dark Mode" : "Light Mode";
      }
    });
  }

  // Navigation
  container.querySelectorAll("[data-link]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(el.getAttribute("href"));
    });
  });

  container.querySelector("#login-btn")?.addEventListener("click", () => navigate("/login"));
}
