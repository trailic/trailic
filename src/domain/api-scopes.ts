/** What an API key may do. Only reading figures so far: a dashboard's key gets numbers, never people. */
export const API_SCOPES = ["figures:read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_NAMES: Record<ApiScope, string> = { "figures:read": "Read figures" };

export const onlyScopes = (values: readonly unknown[]): ApiScope[] => API_SCOPES.filter((scope) => values.includes(scope));
