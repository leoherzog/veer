import { renderLinkForm } from "../components/link-form.js";
import { navigate } from "../router.js";

export function renderHome(container, user) {
  if (user) {
    container.innerHTML = `
      <div class="home-view wa-stack wa-gap-l" style="max-width:600px;margin:2rem auto;">
        <h1>Create a Short Link</h1>
        <div id="create-form"></div>
      </div>
    `;
    renderLinkForm(container.querySelector("#create-form"));
  } else {
    container.innerHTML = `
      <div class="home-view wa-stack wa-gap-l" style="max-width:600px;margin:3rem auto;text-align:center;">
        <h1>Veer</h1>
        <p style="font-size:1.25rem;">A self-hostable URL shortener built on Cloudflare Workers.</p>
        <wa-button variant="brand" size="large" id="get-started">Get Started</wa-button>
      </div>
    `;
    container.querySelector("#get-started").addEventListener("click", () => navigate("/login"));
  }
}
