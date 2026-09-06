import { authClient } from "../auth-client.js";
import { navigate } from "../router.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { getInstanceName, isDemoMode } from "../lib/config.js";

/**
 * Swap the theme class on `<html>` and announce it. WA components re-read their
 * custom properties on their own; the `theme-change` event exists for consumers
 * that cache resolved colors, such as `lib/chart-helper.js`.
 */
function toggleTheme(iconEl, labelEl) {
  const root = document.documentElement;
  const isDark = root.classList.contains("wa-dark");
  const theme = isDark ? "wa-light" : "wa-dark";
  root.classList.remove(isDark ? "wa-dark" : "wa-light");
  root.classList.add(theme);
  localStorage.setItem("theme", theme);
  if (iconEl) iconEl.name = isDark ? "moon" : "sun";
  if (labelEl) labelEl.textContent = isDark ? "Dark Mode" : "Light Mode";
  document.dispatchEvent(new CustomEvent("theme-change", { detail: { theme } }));
}

function getInitials(name) {
  if (!name) return "";
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function renderNavBar(container, user) {
  const avatarAttrs = user
    ? `${user.image ? `image="${escapeAttr(user.image)}"` : ""} initials="${escapeAttr(getInitials(user.name))}" label="${escapeAttr(user.name || "")}"`
    : "";
  // #nav is slotted straight into wa-page's `header`, which already supplies
  // display:flex, align-items:center, justify-content:space-between, gap and padding.
  container.innerHTML = `
      <div class="wa-cluster wa-gap-m">
        <a href="${user ? "/links" : "/"}" class="wa-link-plain wa-font-size-l wa-font-weight-bold" data-link>${escapeHtml(getInstanceName())}</a>
      </div>
      <div class="wa-cluster wa-gap-m">
        ${user
          ? `
            <wa-dropdown placement="bottom-end">
              <wa-button slot="trigger" variant="neutral" appearance="plain" pill>
                <wa-avatar id="user-avatar" ${avatarAttrs} style="--size: 2rem;"></wa-avatar>
              </wa-button>
              <wa-dropdown-item id="settings-link">
                <wa-icon slot="icon" name="gear"></wa-icon>
                Settings
              </wa-dropdown-item>
              ${user.isAdmin ? `
              <wa-dropdown-item id="admin-link">
                <wa-icon slot="icon" name="shield-halved"></wa-icon>
                Admin
              </wa-dropdown-item>
              ` : ""}
              <wa-dropdown-item id="theme-toggle">
                <wa-icon slot="icon" name="${document.documentElement.classList.contains("wa-dark") ? "sun" : "moon"}"></wa-icon>
                <span class="theme-label">${document.documentElement.classList.contains("wa-dark") ? "Light Mode" : "Dark Mode"}</span>
              </wa-dropdown-item>
              ${isDemoMode() ? "" : `
              <wa-divider></wa-divider>
              <wa-dropdown-item id="logout-btn">
                <wa-icon slot="icon" name="right-from-bracket"></wa-icon>
                Logout
              </wa-dropdown-item>
              `}
            </wa-dropdown>
          `
          : `
            <wa-button id="theme-toggle" size="s" variant="neutral" appearance="plain" pill><wa-icon name="${document.documentElement.classList.contains("wa-dark") ? "sun" : "moon"}" label="${document.documentElement.classList.contains("wa-dark") ? "Light Mode" : "Dark Mode"}"></wa-icon></wa-button>
            <wa-button size="s" variant="brand" id="login-btn">Login</wa-button>
          `
        }
      </div>
  `;

  // Avatar dropdown menu
  const dropdown = container.querySelector("wa-dropdown");
  if (dropdown) {
    dropdown.addEventListener("wa-select", async (e) => {
      const item = e.detail.item;
      if (item.id === "settings-link") {
        navigate("/settings");
      } else if (item.id === "admin-link") {
        navigate("/admin");
      } else if (item.id === "theme-toggle") {
        toggleTheme(item.querySelector("wa-icon"), item.querySelector(".theme-label"));
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
      const icon = container.querySelector("#theme-toggle wa-icon");
      toggleTheme(icon, null);
      if (icon) icon.label = icon.name === "moon" ? "Dark Mode" : "Light Mode";
    });
  }

  // Navigation ([data-link] elements are handled by a global delegate in app.js)
  container.querySelector("#login-btn")?.addEventListener("click", () => navigate("/login"));
}
