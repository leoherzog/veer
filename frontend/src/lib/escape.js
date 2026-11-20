const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape a value for HTML text or a quoted attribute. Null and undefined become "". */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
}

export { escapeHtml as escapeAttr };
