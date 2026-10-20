# 3. Reglas de WhatsApp que el sistema respeta

> Las políticas y precios de Meta cambian. Antes de salir a producción, revisa las páginas oficiales enlazadas.

## Ventana de atención de 24 horas

- Cada vez que un cliente escribe, se abre (o renueva) una **ventana de 24 horas**. Dentro de ella podemos responder con mensajes libres: texto, botones y listas.
- Fuera de esa ventana **solo** se pueden enviar **plantillas aprobadas** por Meta.
- **Cómo lo maneja el sistema:**
  - `customer_sessions.last_inbound_at` guarda la hora del último mensaje del cliente.
  - Al cambiar un estado desde el panel, `admin-order-status` comprueba la ventana (con 10 minutos de margen):
    - Dentro de la ventana → envía el aviso normal.
    - Fuera de la ventana y con plantilla configurada → envía la plantilla `WHATSAPP_TEMPLATE_ORDER_UPDATE`.
    - Fuera de la ventana y sin plantilla → **no envía nada** y el panel muestra "Cliente no avisado", para que la dueña llame.
  - Si Meta responde con el error `131047` (ventana cerrada), se intenta con la plantilla.

Documentación: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages#customer-service-windows

## Plantillas

- La única plantilla prevista es de categoría **Utility** (actualización de un pedido que el cliente hizo).
- **No** se usan plantillas de marketing.
- Ejemplo: `Hola, tu pedido #{{1}} ahora está: {{2}}.`

Documentación: https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates

## Costos (referencial)

Meta cobra **por mensaje de plantilla entregado**, según la categoría y el país. Según la tabla vigente al escribir esta guía:
- Las respuestas libres dentro de la ventana de atención **no tienen costo**.
- Las plantillas *utility* enviadas **dentro** de una ventana abierta tampoco.

Casi todo este sistema funciona dentro de la ventana, porque el cliente siempre escribe primero. **Verifica la tabla actual** en https://developers.facebook.com/docs/whatsapp/pricing.

## Consentimiento y promociones

- El bot **nunca** envía promociones. No hay ningún código que lo haga.
- `customer_sessions.marketing_opt_in` existe y vale `false` por defecto. Si en el futuro se quieren enviar ofertas, primero hay que crear un flujo explícito en el que el cliente acepte (y pueda retirar su aceptación), y usar plantillas de marketing.
- Los avisos de estado (aceptado, listo…) se envían porque el cliente hizo un pedido: son mensajes transaccionales.
- Política de privacidad: plantilla en `admin/public/privacidad.html`, basada en la Ley N.º 29733 de Perú. Complétala antes de publicar.

## Promesas de tiempo

Ningún mensaje promete tiempos de entrega ("en 10 minutos"). El cliente recibe avisos cuando el estado **realmente** cambia.

## Límites técnicos que el código respeta

| Elemento | Límite | Dónde |
|---|---|---|
| Botones por mensaje | 3, título de hasta 20 caracteres | `whatsapp/payloads.ts` |
| Filas de una lista | 10, título de hasta 24 y descripción de hasta 72 caracteres | `payloads.ts`, paginación en el bot |
| Texto de un mensaje interactivo | 1024 caracteres (si es más largo, se envía aparte) | `payloads.ts` |
| Reintentos de envío | 3, con espera creciente, solo para errores 5xx, 429, de límite de velocidad o de red | `whatsapp/client.ts` |
| Reintentos de Meta | si la función responde distinto de 200, Meta reintenta. Solo se responde 500 si la base de datos no está disponible | `whatsapp-webhook/handler.ts` |
| Mensajes muy antiguos | si llegan con más de 15 minutos de retraso (tras una caída), se ignoran para no crear pedidos fuera de tiempo | `handler.ts` |

## Bibliotecas no oficiales

No se usa ninguna biblioteca que automatice WhatsApp Web (whatsapp-web.js, Baileys, etc.). Todo pasa por la Graph API oficial (`graph.facebook.com/{versión}/{phone_number_id}/messages`).

## Nombres de usuario de WhatsApp

Meta está incorporando **nombres de usuario** e identificadores por empresa, de modo que el campo `from` podría dejar de ser un número de teléfono. Hoy el bot solo atiende remitentes con número (8 a 15 dígitos) y descarta el resto, con un registro `webhook_messages_discarded`. Si esto empieza a aparecer en los logs, hay que adaptar el parser según la documentación vigente.
