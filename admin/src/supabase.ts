import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** false si falta configurar admin/.env.local */
export const isConfigured = Boolean(url && key);

// Solo la clave pública (anon/publishable). Los permisos los decide RLS.
export const supabase = createClient(url ?? "http://localhost:54321", key ?? "falta-configurar", {
  auth: { persistSession: true, autoRefreshToken: true },
});
