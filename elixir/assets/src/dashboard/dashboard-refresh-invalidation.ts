export type DashboardRefreshInvalidation = {
  publish: () => void;
  subscribe: (listener: () => void) => () => void;
};

export function createDashboardRefreshInvalidation(): DashboardRefreshInvalidation {
  const listeners = new Set<() => void>();

  return {
    publish() {
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
