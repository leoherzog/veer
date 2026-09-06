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

export function navigate(path, replace = false) {
  if (replace) {
    history.replaceState(null, "", path);
  } else {
    history.pushState(null, "", path);
  }
  resolve();
}

/** A trailing slash names the same route; "/" keeps its slash. */
function normalizePath(path) {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

export function resolve() {
  const path = normalizePath(location.pathname);
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
