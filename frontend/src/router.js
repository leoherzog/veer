const routes = [];
let notFoundHandler = null;

export function addRoute(path, handler) {
  const paramNames = [];
  const pattern = path.replace(/:([^/]+)/g, (_, name) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  routes.push({ pattern: new RegExp(`^${pattern}$`), paramNames, handler });
}

export function setNotFound(handler) {
  notFoundHandler = handler;
}

/** Go to `path` and render it. Navigating to the current URL replaces its history entry instead of stacking a duplicate. */
export function navigate(path, replace = false) {
  if (replace || path === location.pathname + location.search) {
    history.replaceState(null, "", path);
  } else {
    history.pushState(null, "", path);
  }
  resolve();
}

export function resolve() {
  const path = location.pathname;
  for (const route of routes) {
    const match = path.match(route.pattern);
    if (match) {
      const params = {};
      route.paramNames.forEach((name, i) => {
        params[name] = match[i + 1];
      });
      route.handler(params);
      return;
    }
  }
  if (notFoundHandler) notFoundHandler();
}

// Handle back/forward
window.addEventListener("popstate", resolve);
