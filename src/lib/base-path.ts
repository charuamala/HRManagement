/**
 * Sub-path the app is served under (e.g. "/HRmanagement"); empty when served at the domain root.
 * Set NEXT_PUBLIC_BASE_PATH at build time. Next <Link>, router and redirect() add it automatically;
 * raw fetch() calls and window.location assignments go through withBase().
 */
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");

export const withBase = (path: string) => (path.startsWith("/") && !path.startsWith(`${BASE_PATH}/`) ? `${BASE_PATH}${path}` : path);
