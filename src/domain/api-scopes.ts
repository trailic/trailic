/** What an API key may do. Only reading figures so far: a dashboard's key gets numbers, never people. */
export const API_SCOPES = ["figures:read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_NAMES: Record<ApiScope, string> = { "figures:read": "Read figures" };

/** What a key made through an assistant gets: reading, and nothing else. Should a scope that changes something come, it's given by a person, on the screen, since what visitors send can carry instructions. */
export const READ_SCOPES = API_SCOPES.filter((scope) => scope.endsWith(":read"));

export const onlyScopes = (values: readonly unknown[]): ApiScope[] => API_SCOPES.filter((scope) => values.includes(scope));
