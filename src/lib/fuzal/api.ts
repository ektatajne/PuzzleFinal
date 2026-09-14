/** REST client for Fuzal (frontend/src/services/api.js equivalent). */

export interface CreatedLobby {
  code: string;
  lobbyId: string;
  hostToken: string;
  maxPlayers: number;
  gridSize?: number;
  gridCols: number;
  gridRows: number;
  pieceCount?: number;
}

export interface JoinedPlayer {
  id: string;
  name: string;
  token: string;
  score: number;
  slot: number;
}

export type ApiError = Error & {
  status?: number;
  code?: string;
};

async function parseError(res: Response): Promise<ApiError> {
  try {
    const data = await res.json();
    const err = new Error(data.message ?? "Something went wrong. Please try again.") as ApiError;
    err.status = res.status;
    if (typeof data.error === "string") err.code = data.error;
    if (typeof data.code === "string") err.code = data.code;
    return err;
  } catch {
    const err = new Error("Something went wrong. Please try again.") as ApiError;
    err.status = res.status;
    return err;
  }
}

export async function createLobby(opts?: {
  gridSize?: number;
  maxPlayers?: number;
  memorySeconds?: number;
  puzzleSeconds?: number;
}): Promise<CreatedLobby> {
  const res = await fetch("/api/lobbies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function updateLobbyConfig(
  code: string,
  token: string,
  opts: {
    gridSize?: number;
    maxPlayers?: number;
    memorySeconds?: number;
    puzzleSeconds?: number;
  },
) {
  const res = await fetch(`/api/lobbies/${code}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...opts }),
  });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function getHostOverview() {
  const res = await fetch("/api/host/overview", { cache: "no-store" });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function getHostHistory(params?: {
  page?: number;
  limit?: number;
  grid?: number;
  status?: string;
  search?: string;
  date?: string;
}) {
  const q = new URLSearchParams();
  if (params?.page) q.set("page", String(params.page));
  if (params?.limit) q.set("limit", String(params.limit));
  if (params?.grid) q.set("grid", String(params.grid));
  if (params?.status) q.set("status", params.status);
  if (params?.search) q.set("search", params.search);
  if (params?.date) q.set("date", params.date);

  const res = await fetch(`/api/host/history?${q.toString()}`, { cache: "no-store" });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function getGameDetail(gameId: string) {
  const res = await fetch(`/api/host/history/${gameId}`, { cache: "no-store" });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function getHostPuzzles() {
  const res = await fetch("/api/host/puzzles", { cache: "no-store" });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function uploadPuzzleImage(formData: FormData) {
  const res = await fetch("/api/host/puzzles/images", {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function getHostPlayers(search?: string) {
  const q = search ? `?search=${encodeURIComponent(search)}` : "";
  const res = await fetch(`/api/host/players${q}`, { cache: "no-store" });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function getLobby(code: string) {
  const res = await fetch(`/api/lobbies/${code}`, { cache: "no-store" });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function joinLobby(
  code: string,
  name: string,
): Promise<{ player: JoinedPlayer; lobby: unknown }> {
  const res = await fetch(`/api/lobbies/${code}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function postAction<T = Record<string, unknown>>(
  code: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`/api/lobbies/${code}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json().catch(() => ({}))) as T;
}

export function pieceUrl(
  code: string,
  pieceId: number,
  playerId: string,
  token: string,
): string {
  return `/api/lobbies/${code}/piece/${pieceId}?p=${encodeURIComponent(
    playerId,
  )}&t=${encodeURIComponent(token)}`;
}

import { getJoinUrl } from "@/lib/urls";

/** QR payload — uses canonical site URL priority: NEXT_PUBLIC_SITE_URL > VERCEL_URL > origin. */
export function joinUrlFor(code: string): string {
  return getJoinUrl(code);
}

const KEY_PREFIX = "fuzal:v1:";

/**
 * Tab-scoped session storage for player identity.
 * Uses sessionStorage so multiple tabs on the same browser/device
 * never collide or overwrite each other's player sessions.
 */
export const sessionStore = {
  get<T>(key: string): T | null {
    if (typeof window === "undefined") return null;
    try {
      // 1. Check sessionStorage first (tab-isolated)
      const sessionRaw = sessionStorage.getItem(KEY_PREFIX + key);
      if (sessionRaw) {
        return JSON.parse(sessionRaw) as T;
      }
      // 2. Host tokens can fall back to localStorage for convenience across windows
      if (key.startsWith("host:")) {
        const localRaw = localStorage.getItem(KEY_PREFIX + key);
        return localRaw ? (JSON.parse(localRaw) as T) : null;
      }
      return null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown) {
    if (typeof window === "undefined") return;
    try {
      const serialized = JSON.stringify(value);
      // Player sessions are stored strictly in sessionStorage to prevent tab collisions
      sessionStorage.setItem(KEY_PREFIX + key, serialized);
      if (key.startsWith("host:")) {
        localStorage.setItem(KEY_PREFIX + key, serialized);
      }
    } catch {
      /* private mode etc. */
    }
  },
  remove(key: string) {
    if (typeof window === "undefined") return;
    try {
      sessionStorage.removeItem(KEY_PREFIX + key);
      if (key.startsWith("host:")) {
        localStorage.removeItem(KEY_PREFIX + key);
      }
    } catch {
      /* noop */
    }
  },
};

