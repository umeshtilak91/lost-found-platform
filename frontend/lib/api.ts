"use client";

// Browser API client. Calls go to same-origin /api (proxied to the API), with
// the session cookie and the CSRF token on every state-changing request.

export class ApiError extends Error {
  status: number;
  code: string;
  fields: { path: string; message: string }[];
  details: Record<string, unknown>;
  constructor(status: number, code: string, message: string, fields: { path: string; message: string }[] = [], details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.details = details;
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

type Options = { method?: string; json?: unknown; form?: FormData; signal?: AbortSignal };

export async function api<T = unknown>(path: string, { method = "GET", json, form, signal }: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  let body: BodyInit | undefined;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method, headers, body, credentials: "same-origin", signal });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError(0, "network", "network");
  }

  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = data?.error || {};
    throw new ApiError(response.status, err.code || "error", err.message || "error", err.fields || [], err.details || {});
  }
  return data as T;
}

export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  return Object.fromEntries(error.fields.map((field) => [field.path, field.message]));
}
