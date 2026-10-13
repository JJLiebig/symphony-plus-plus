declare global {
  interface Window {
    SYMPP_DASHBOARD_CONFIG?: {
      apiBase?: string;
      basePath?: string;
      logoUrl?: string;
    };
  }
}

// The packaged backend tells its page where the operator API and the page's own files live.
// A development server has neither setting and uses the defaults.
const config = typeof window === "undefined" ? undefined : window.SYMPP_DASHBOARD_CONFIG;

export function api(path: string) {
  return `${config?.apiBase || "/api/v1/sympp/operator"}${path}`;
}

export function asset(url: string) {
  return `${config?.basePath || ""}${url}`;
}
