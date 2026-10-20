// Edge Function: https://<proyecto>.supabase.co/functions/v1/whatsapp-webhook
// Recibe los webhooks de WhatsApp Cloud API y responde a los clientes.
//
// Secretos que usa (configurados en Supabase, nunca en el código):
//   WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN,
//   WHATSAPP_APP_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Opcional: WHATSAPP_API_VERSION (por defecto v23.0)
//
// Debe desplegarse SIN verificación JWT (Meta no envía tokens de Supabase):
//   supabase functions deploy whatsapp-webhook --no-verify-jwt
// La autenticidad se valida con la firma X-Hub-Signature-256.
import { createClient } from "npm:@supabase/supabase-js@2.117.0";
import {
  createSupabaseMessageLedger,
  createSupabaseRepository,
  createSupabaseSessionStore,
} from "../_shared/bot/supabase-repository.ts";
import { log } from "../_shared/log.ts";
import { createWhatsAppClient } from "../_shared/whatsapp/client.ts";
import { createWebhookHandler } from "./handler.ts";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    log("error", "missing_env", { variable: name });
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

const db = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const handler = createWebhookHandler({
  config: {
    verifyToken: requireEnv("WHATSAPP_VERIFY_TOKEN"),
    appSecret: requireEnv("WHATSAPP_APP_SECRET"),
    phoneNumberId: requireEnv("WHATSAPP_PHONE_NUMBER_ID"),
  },
  ledger: createSupabaseMessageLedger(db),
  sessions: createSupabaseSessionStore(db),
  repo: createSupabaseRepository(db),
  sender: createWhatsAppClient({
    token: requireEnv("WHATSAPP_TOKEN"),
    phoneNumberId: requireEnv("WHATSAPP_PHONE_NUMBER_ID"),
    apiVersion: Deno.env.get("WHATSAPP_API_VERSION") ?? undefined,
  }),
});

Deno.serve(handler);
