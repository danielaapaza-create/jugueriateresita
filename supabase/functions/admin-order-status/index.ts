// Edge Function: https://<proyecto>.supabase.co/functions/v1/admin-order-status
// La llama el panel cuando la dueña cambia el estado de un pedido.
//
// Secretos que usa:
//   SUPABASE_URL, SUPABASE_ANON_KEY (los inyecta Supabase automáticamente)
//   WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID
// Opcionales:
//   WHATSAPP_TEMPLATE_ORDER_UPDATE  nombre de la plantilla aprobada (fuera de 24 h)
//   WHATSAPP_TEMPLATE_LANGUAGE      idioma de la plantilla (por defecto "es")
//   ADMIN_PANEL_ORIGIN              URL del panel para CORS (por defecto "*")
//   WHATSAPP_API_VERSION
// NO usa la service role key: actúa con los permisos de la dueña.
import { createClient } from "npm:@supabase/supabase-js@2.117.0";
import { log } from "../_shared/log.ts";
import { createWhatsAppClient } from "../_shared/whatsapp/client.ts";
import { type AdminDb, createAdminHandler, DbRpcError, type StatusChange } from "./handler.ts";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    log("error", "missing_env", { variable: name });
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

const supabaseUrl = requireEnv("SUPABASE_URL");
const anonKey = requireEnv("SUPABASE_ANON_KEY");
const templateName = Deno.env.get("WHATSAPP_TEMPLATE_ORDER_UPDATE");

function dbForUser(authorization: string): AdminDb {
  const db = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async setStatus(orderId, status, note) {
      const { data, error } = await db.rpc("admin_set_order_status", {
        p_order_id: orderId,
        p_status: status,
        p_note: note,
      });
      if (error) throw new DbRpcError(error.message);
      return data as StatusChange;
    },
    async recordNotification(orderId, status, err) {
      const { error } = await db.rpc("admin_record_notification", {
        p_order_id: orderId,
        p_status: status,
        p_error: err,
      });
      if (error) throw new DbRpcError(error.message);
    },
  };
}

Deno.serve(createAdminHandler({
  dbForUser,
  sender: createWhatsAppClient({
    token: requireEnv("WHATSAPP_TOKEN"),
    phoneNumberId: requireEnv("WHATSAPP_PHONE_NUMBER_ID"),
    apiVersion: Deno.env.get("WHATSAPP_API_VERSION") ?? undefined,
  }),
  template: templateName
    ? { name: templateName, language: Deno.env.get("WHATSAPP_TEMPLATE_LANGUAGE") ?? "es" }
    : undefined,
  allowedOrigin: Deno.env.get("ADMIN_PANEL_ORIGIN") ?? "*",
}));
