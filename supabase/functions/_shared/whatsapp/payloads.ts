// Convierte las respuestas del bot al formato de la Cloud API de WhatsApp,
// respetando sus límites (si no, Meta rechaza el mensaje con error 131009).
// https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages
// https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages
import type { Reply } from "../bot/types.ts";
import { truncate } from "../bot/text.ts";

export const LIMITS = {
  textBody: 4096,
  interactiveBody: 1024,
  buttonTitle: 20,
  maxButtons: 3,
  listButton: 20,
  rowTitle: 24,
  rowDescription: 72,
  sectionTitle: 24,
  maxRows: 10,
  id: 200,
} as const;

export type WhatsAppPayload = Record<string, unknown>;

/**
 * Una respuesta puede convertirse en 1 o 2 mensajes: si el texto es más largo
 * que lo permitido en un mensaje interactivo, se envía primero como texto.
 */
export function toPayloads(to: string, reply: Reply): WhatsAppPayload[] {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };

  if (reply.type === "text") {
    return [{ ...base, type: "text", text: { preview_url: false, body: truncate(reply.body, LIMITS.textBody) } }];
  }

  const out: WhatsAppPayload[] = [];
  let body = reply.body;
  if (Array.from(body).length > LIMITS.interactiveBody) {
    out.push({ ...base, type: "text", text: { preview_url: false, body: truncate(body, LIMITS.textBody) } });
    body = "Elige una opción 👇";
  }

  if (reply.type === "buttons") {
    out.push({
      ...base,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: reply.buttons.slice(0, LIMITS.maxButtons).map((b) => ({
            type: "reply",
            reply: { id: truncate(b.id, LIMITS.id), title: truncate(b.title, LIMITS.buttonTitle) },
          })),
        },
      },
    });
    return out;
  }

  let remaining: number = LIMITS.maxRows;
  const sections = reply.sections.map((section) => {
    const rows = section.rows.slice(0, Math.max(remaining, 0));
    remaining -= rows.length;
    return {
      title: truncate(section.title, LIMITS.sectionTitle),
      rows: rows.map((r) => ({
        id: truncate(r.id, LIMITS.id),
        title: truncate(r.title, LIMITS.rowTitle),
        ...(r.description ? { description: truncate(r.description, LIMITS.rowDescription) } : {}),
      })),
    };
  }).filter((s) => s.rows.length > 0);

  out.push({
    ...base,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body },
      action: { button: truncate(reply.buttonLabel, LIMITS.listButton), sections },
    },
  });
  return out;
}
