// Extrae los mensajes entrantes del JSON que envía Meta.
// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
import type { Incoming } from "../bot/types.ts";

export interface InboundMessage {
  id: string;
  /** wa_id del remitente: solo dígitos, con código de país. */
  from: string;
  timestamp: Date;
  input: Incoming;
  /** Nombre de perfil de WhatsApp (solo como sugerencia). */
  profileName?: string;
  /** Tipos que se ignoran sin responder (reacciones, avisos del sistema). */
  ignore: boolean;
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  /** Cantidad de avisos de entrega/lectura recibidos (no requieren respuesta). */
  statusCount: number;
  /** Mensajes descartados por venir de otro número de la cuenta o mal formados. */
  discarded: number;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const IGNORED_TYPES = new Set(["reaction", "system", "ephemeral", "unsupported_ephemeral", "request_welcome"]);

export function parseWebhook(payload: unknown, phoneNumberId: string): ParsedWebhook {
  const result: ParsedWebhook = { messages: [], statusCount: 0, discarded: 0 };
  if (!isObj(payload) || payload.object !== "whatsapp_business_account") return result;
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    if (!isObj(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isObj(change) || change.field !== "messages" || !isObj(change.value)) continue;
      const value = change.value;
      const metadata = isObj(value.metadata) ? value.metadata : {};
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      const messages = Array.isArray(value.messages) ? value.messages : [];

      // Solo atendemos mensajes dirigidos a NUESTRO número.
      if (str(metadata.phone_number_id) !== phoneNumberId) {
        result.discarded += messages.length;
        continue;
      }
      result.statusCount += statuses.length;

      const contacts = Array.isArray(value.contacts) ? value.contacts.filter(isObj) : [];
      for (const msg of messages) {
        const parsed = parseMessage(msg, contacts);
        if (parsed) result.messages.push(parsed);
        else result.discarded++;
      }
    }
  }
  return result;
}

function parseMessage(msg: unknown, contacts: Json[]): InboundMessage | null {
  if (!isObj(msg)) return null;
  const id = str(msg.id);
  const from = str(msg.from);
  const type = str(msg.type) ?? "unknown";
  const ts = Number(str(msg.timestamp));
  if (!id || id.length > 200 || !from || !/^\d{8,15}$/.test(from) || !Number.isFinite(ts)) return null;

  const contact = contacts.find((c) => str(c.wa_id) === from);
  const profile = contact && isObj(contact.profile) ? str(contact.profile.name) : undefined;

  const base = { id, from, timestamp: new Date(ts * 1000), profileName: profile?.slice(0, 60), ignore: false };

  if (IGNORED_TYPES.has(type)) return { ...base, input: { type: "unsupported", kind: type }, ignore: true };

  if (type === "text" && isObj(msg.text) && typeof msg.text.body === "string") {
    return { ...base, input: { type: "text", text: msg.text.body } };
  }
  if (type === "interactive" && isObj(msg.interactive)) {
    const reply = isObj(msg.interactive.button_reply)
      ? msg.interactive.button_reply
      : isObj(msg.interactive.list_reply)
      ? msg.interactive.list_reply
      : null;
    const choiceId = reply ? str(reply.id) : undefined;
    if (reply && choiceId) {
      return { ...base, input: { type: "choice", id: choiceId, title: str(reply.title) ?? "" } };
    }
  }
  // Botón de respuesta rápida de una plantilla
  if (type === "button" && isObj(msg.button)) {
    const text = str(msg.button.text) ?? "";
    return { ...base, input: { type: "text", text } };
  }
  return { ...base, input: { type: "unsupported", kind: type } };
}
