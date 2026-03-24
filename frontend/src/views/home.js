import { navigate } from "../router.js";

export function renderHome(container, user) {
  if (user) {
    navigate("/links");
    return;
  }

  container.innerHTML = `
    <div class="home-view wa-stack wa-gap-l">
      <h1>Veer</h1>
      <p class="wa-font-size-l">A self-hostable URL shortener built on Cloudflare Workers.</p>
      <p>Shorten links, track clicks, and own your data — deploy to your own Cloudflare account in minutes.</p>
      <wa-button variant="brand" size="large" id="get-started">Get Started</wa-button>
    </div>
  `;
  container.querySelector("#get-started").addEventListener("click", () => navigate("/login"));
}
