import { authClient } from "../auth-client.js";
import { navigate } from "../router.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { getInstanceName, isDemoMode } from "../lib/config.js";
import { isDark, toggleTheme } from "../lib/theme.js";

/** Point the theme control at the scheme it switches to. The scheme can also change from the system or another tab. */
function syncThemeToggle() {
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;
  const dark = isDark();
  const action = dark ? "Light Mode" : "Dark Mode";
  const icon = toggle.querySelector("wa-icon");
  icon.name = dark ? "sun" : "moon";
  const text = toggle.querySelector(".theme-label");
  if (text) text.textContent = action;
  else icon.label = action;
}

document.addEventListener("theme-change", syncThemeToggle);

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
      <a href="${user ? "/links" : "/"}" class="wa-link-plain wa-font-size-l wa-font-weight-bold" data-link>${escapeHtml(getInstanceName())}</a>
      <div class="wa-cluster wa-gap-m">
        ${user
          ? `
            <wa-dropdown placement="bottom-end">
              <wa-button slot="trigger" class="avatar-trigger" variant="neutral" appearance="plain" pill>
                <wa-avatar ${avatarAttrs} style="--size: 2rem;"></wa-avatar>
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
                <wa-icon slot="icon"></wa-icon>
                <span class="theme-label"></span>
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
            <wa-button id="theme-toggle" size="s" variant="neutral" appearance="plain" pill><wa-icon></wa-icon></wa-button>
            <wa-button size="s" variant="brand" href="/login" data-link>Login</wa-button>
          `
        }
      </div>
  `;
  syncThemeToggle();

  const dropdown = container.querySelector("wa-dropdown");
  if (dropdown) {
    dropdown.addEventListener("wa-select", async (e) => {
      const item = e.detail.item;
      if (item.id === "settings-link") {
        navigate("/settings");
      } else if (item.id === "admin-link") {
        navigate("/admin");
      } else if (item.id === "theme-toggle") {
        toggleTheme();
      } else if (item.id === "logout-btn") {
        await authClient.signOut();
        location.replace("/");
      }
    });
  } else {
    container.querySelector("#theme-toggle").addEventListener("click", toggleTheme);
  }
}
