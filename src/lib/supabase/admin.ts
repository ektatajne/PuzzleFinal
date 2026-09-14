// ============================================================================
// SERVER ONLY: NEVER IMPORT THIS MODULE INTO CLIENT COMPONENTS ('use client')
// Uses privileged SUPABASE_SERVICE_ROLE_KEY to bypass Row Level Security.
// ============================================================================
import { createClient } from "@supabase/supabase-js";

function sanitizeUrl(raw?: string): string {
  if (!raw) return "https://placeholder.supabase.co";
  let u = raw.trim().replace(/^['"]|['"]$/g, "");
  if (u.endsWith("/")) u = u.slice(0, -1);
  return u;
}

function sanitizeKey(raw?: string): string {
  if (!raw) return "placeholder-key";
  return raw.trim().replace(/^['"]|['"]$/g, "");
}

const supabaseUrl = sanitizeUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
const serviceRoleKey = sanitizeKey(process.env.SUPABASE_SERVICE_ROLE_KEY);

export function isSupabaseConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Boolean(
    url &&
    key &&
    !url.includes("placeholder") &&
    key !== "placeholder-key"
  );
}

if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as any).WebSocket = class {};
}

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});


