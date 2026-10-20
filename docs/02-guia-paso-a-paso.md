# 2. Guía paso a paso (para quien está aprendiendo)

Sigue las etapas **en orden**. Cada una termina con **"✅ Cómo verificar"**: no pases a la siguiente hasta que la verificación salga bien.

> **Nombres de menús:** Meta y Supabase cambian sus pantallas con frecuencia. Si un botón no se llama exactamente igual, busca uno parecido o revisa la documentación oficial que se enlaza en cada paso.

> **Regla de oro de los secretos:** el token de WhatsApp, el App Secret y la service role key **nunca** se pegan en el código, en GitHub, en el panel ni en un chat. Solo van en *Supabase → Edge Functions → Secrets* (o en tu archivo local `supabase/functions/.env`, que Git ignora).

---

## Etapa 0 · Instalar herramientas

| Herramienta | Para qué | Cómo instalar |
|---|---|---|
| Git | control de versiones | https://git-scm.com/downloads |
| Node.js 22 LTS | panel y CLI de Supabase | https://nodejs.org |
| Deno 2 | pruebas del bot | https://docs.deno.com/runtime/getting_started/installation/ |
| PostgreSQL 16 o 17 (opcional) | pruebas SQL locales | https://www.postgresql.org/download/ |
| Un editor | VS Code u otro | https://code.visualstudio.com |

La CLI de Supabase se usa con `npx supabase …`, sin instalarla globalmente.

**✅ Cómo verificar:** en una terminal, cada uno de estos comandos debe mostrar una versión:

```bash
git --version
node --version      # v22.x
deno --version      # deno 2.x
npx supabase --version
```

---

## Etapa 1 · Descargar el proyecto y correr las pruebas

```bash
git clone https://github.com/danielaapaza-create/jugueriateresita.git
cd jugueriateresita
deno task test
```

Si instalaste PostgreSQL (en Linux o macOS, con un usuario normal, no root):

```bash
./scripts/test-sql.sh
```

**✅ Cómo verificar:**
- `deno task test` termina con `ok | 59 passed | 0 failed` (o más, si agregas pruebas).
- `test-sql.sh` termina con `✅ Pruebas SQL completadas`.
- Si no tienes PostgreSQL, no pasa nada: GitHub Actions ejecuta estas pruebas en cada `git push` (pestaña **Actions** del repositorio).

---

## Etapa 2 · Crear el proyecto en Supabase (gratis)

1. Entra a https://supabase.com y crea una cuenta.
2. **New project**:
   - Name: `jugueria`
   - Database password: genera una larga y **guárdala** en un gestor de contraseñas.
   - Region: la más cercana a Perú (por ejemplo, *South America (São Paulo)*).
3. Espera a que el proyecto termine de crearse.
4. Anota el **Project ref**: es la parte `abcdxyz` de `https://abcdxyz.supabase.co` (lo ves en *Project Settings → General*).

> ⚠️ En el plan gratuito, Supabase **pausa** los proyectos tras un periodo sin actividad. Si el bot deja de responder después de varios días sin pedidos, entra al panel de Supabase y pulsa **Restore**. Revisa la política vigente en https://supabase.com/pricing.

**✅ Cómo verificar:** el proyecto aparece como *Healthy* en el panel de Supabase.

---

## Etapa 3 · Crear las tablas (migraciones)

En la carpeta del proyecto:

```bash
npx supabase login                         # abre el navegador para autorizar
npx supabase link --project-ref TU_REF     # pide la contraseña de la base de datos
npx supabase db push                       # aplica supabase/migrations/*.sql
```

`db push` **no** carga `seed.sql`; ese archivo tiene productos de prueba solo para desarrollo local.

**✅ Cómo verificar:**
1. En Supabase → **Table Editor** ves las tablas `products`, `orders`, `order_items`, `customer_sessions`, `processed_messages`, `business_settings`, `admins` y `order_status_history`.
2. En **SQL Editor**, ejecuta:
   ```sql
   select * from business_settings;
   ```
   Debe devolver una fila con `orders_paused = false`.
3. En **Database → Publications → supabase_realtime**, la tabla `orders` aparece activada. Esto permite que el panel vea los pedidos nuevos al instante.

---

## Etapa 4 · Crear la cuenta de la dueña (administradora)

1. **Cerrar el registro público** (nadie debe poder crearse una cuenta): Supabase → **Authentication → Sign In / Providers** → desactiva **Allow new users to sign up**.
2. **Crear el usuario**: **Authentication → Users → Add user → Create new user**. Escribe el correo y una contraseña fuerte, y marca **Auto Confirm User**.
3. **Darle permisos de administradora**: en **SQL Editor** ejecuta (cambia el correo):
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'correo-de-la-duena@ejemplo.com';
   ```

**✅ Cómo verificar:**
```sql
select u.email from public.admins a join auth.users u on u.id = a.user_id;
```
Debe mostrar el correo de la dueña.

---

## Etapa 5 · Preparar Meta con el NÚMERO DE PRUEBA

Antes de usar el número real de la juguería, todo se prueba con el número gratuito que da Meta.

1. Entra a https://developers.facebook.com con la cuenta de Facebook del negocio → **My Apps → Create App**.
2. Elige el caso de uso **"Connect with customers through WhatsApp"** (o tipo *Business*) y asocia o crea un **portfolio comercial** (Business portfolio).
3. En la app, ve a **WhatsApp → API Setup** (Configuración de la API). Ahí verás:
   - **Test phone number**: el número de prueba de Meta.
   - **Phone number ID** → será `WHATSAPP_PHONE_NUMBER_ID`.
   - **WhatsApp Business Account ID** (anótalo).
   - **Temporary access token** (dura unas 24 h) → **solo para esta prueba inicial**.
4. En **To** (destinatarios), agrega **tu celular** y confírmalo con el código que te llega. El número de prueba solo conversa con hasta 5 números verificados.
5. Ve a **App settings → Basic** → **App secret → Show** → será `WHATSAPP_APP_SECRET`.
6. Inventa un **verify token**: una frase larga y aleatoria, por ejemplo la salida de:
   ```bash
   deno eval "console.log(crypto.randomUUID() + crypto.randomUUID())"
   ```
   Será `WHATSAPP_VERIFY_TOKEN`.

Documentación oficial: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started

**✅ Cómo verificar:** en *API Setup*, envía la plantilla de ejemplo `hello_world` a tu celular con el botón **Send message**. Te debe llegar un WhatsApp de Meta. Esto solo prueba que tu número de destino está bien; todavía no prueba nuestro bot.

---

## Etapa 6 · Desplegar las Edge Functions y guardar los secretos

1. Copia la plantilla de secretos (este archivo **no** se sube a GitHub):
   ```bash
   cp supabase/functions/.env.example supabase/functions/.env
   ```
2. Abre `supabase/functions/.env` y completa:
   ```
   WHATSAPP_TOKEN=            # por ahora, el token temporal
   WHATSAPP_PHONE_NUMBER_ID=  # Phone number ID del número de PRUEBA
   WHATSAPP_VERIFY_TOKEN=     # el que inventaste
   WHATSAPP_APP_SECRET=       # App secret
   ```
   `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` **no** se escriben: Supabase los inyecta automáticamente en las funciones (y no permite crear secretos que empiecen por `SUPABASE_`).
3. Sube los secretos y despliega:
   ```bash
   npx supabase secrets set --env-file supabase/functions/.env
   npx supabase functions deploy whatsapp-webhook --no-verify-jwt
   npx supabase functions deploy admin-order-status
   ```
   `--no-verify-jwt` es necesario porque Meta no envía tokens de Supabase. La función se protege con la firma de Meta.

**✅ Cómo verificar:**
```bash
# Debe responder exactamente: 1234
curl "https://TU_REF.supabase.co/functions/v1/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=TU_VERIFY_TOKEN&hub.challenge=1234"

# Con un token incorrecto debe responder: Forbidden
curl "https://TU_REF.supabase.co/functions/v1/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1234"
```

**Prueba firmada opcional:** simula un webhook firmado como lo haría Meta. Es una simulación: **no** demuestra que WhatsApp esté conectado.
```bash
export WEBHOOK_URL=https://TU_REF.supabase.co/functions/v1/whatsapp-webhook
export WHATSAPP_APP_SECRET=...  WHATSAPP_PHONE_NUMBER_ID=...  TEST_FROM=51TU_CELULAR
deno run --allow-env --allow-net scripts/send-test-webhook.ts "hola"
```
Debe mostrar `HTTP 200` con firma correcta y `HTTP 401` con firma falsa. Como tu número está en la lista de destinatarios de prueba, además te llegará el menú por WhatsApp.

Para ver los registros: Supabase → **Edge Functions → whatsapp-webhook → Logs**. Los teléfonos aparecen enmascarados (`51******321`) y nunca se registran tokens ni textos de mensajes.

---

## Etapa 7 · Conectar el webhook en Meta y hacer la PRUEBA REAL

1. En la app de Meta → **WhatsApp → Configuration** → **Webhook → Edit**:
   - **Callback URL:** `https://TU_REF.supabase.co/functions/v1/whatsapp-webhook`
   - **Verify token:** el mismo `WHATSAPP_VERIFY_TOKEN`
   - **Verify and save**. Meta llama al GET de la etapa 6; si falla, revisa que el token sea idéntico.
2. En **Webhook fields → Manage**, suscríbete (Subscribe) al campo **`messages`**.
3. Desde **tu celular** (el que verificaste en la etapa 5), escribe `hola` al **número de prueba** de Meta.

**✅ Cómo verificar (prueba real de envío y recepción):**
- [ ] Recibes la bienvenida con los botones *Hacer pedido / Ver carta y precios / Mis pedidos*.
- [ ] Antes de esto, carga 2 o 3 productos reales desde el panel (etapa 8) o, temporalmente, desde **Table Editor → products**. Luego haz un pedido completo y recibes **"Pedido #N RECIBIDO"**.
- [ ] El pedido aparece en **Table Editor → orders** con estado `pending`.
- [ ] En los *Logs* de la función aparece `message_processed` sin errores.

**Solo cuando todos estos puntos se cumplan, WhatsApp está conectado.** Si no recibes nada, revisa la sección de *Problemas frecuentes* al final.

---

## Etapa 8 · Publicar el panel de la dueña

### 8.1 Probarlo en tu computadora
```bash
cd admin
cp .env.example .env.local
# Edita .env.local con:
#   VITE_SUPABASE_URL      = https://TU_REF.supabase.co
#   VITE_SUPABASE_ANON_KEY = Project Settings → API Keys → anon (o publishable)
npm install
npm run dev
```
Abre la dirección que muestra la terminal (por ejemplo, http://localhost:5173) e inicia sesión con la cuenta de la dueña.

### 8.2 Publicarlo gratis en GitHub Pages
1. En GitHub → **Settings → Pages → Source: GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables → New repository variable**:
   - `VITE_SUPABASE_URL` = `https://TU_REF.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = la clave anon/publishable. Es pública, por eso va como *variable* y no como secreto.
3. **Actions → Publicar panel → Run workflow**.
4. El panel quedará en `https://TU_USUARIO.github.io/jugueriateresita/`.
5. En Supabase → **Authentication → URL Configuration**, pon esa dirección en **Site URL**.
6. Opcional, para restringir quién llama a la función: añade el secreto `ADMIN_PANEL_ORIGIN=https://TU_USUARIO.github.io` y vuelve a desplegar `admin-order-status`.

> GitHub Pages es gratis en repositorios **públicos**. Si el repositorio es privado y tu plan no incluye Pages, publica la carpeta `admin/dist` en Cloudflare Pages o Netlify (también gratis), con las mismas dos variables.

En el celular de la dueña: abre el enlace y usa **"Agregar a pantalla de inicio"** para tenerlo como una app.

**✅ Cómo verificar:**
- [ ] Con la cuenta de la dueña ves *Pedidos / Productos / Ajustes*.
- [ ] Con otra cuenta (créala y **no** la agregues a `admins`) ves "Sin autorización".
- [ ] Al **Aceptar** el pedido de prueba, te llega por WhatsApp: "✅ ¡Tu pedido #N fue ACEPTADO!".
- [ ] Al marcar un producto como **AGOTADO**, desaparece de la carta en WhatsApp.
- [ ] Al **Pausar pedidos**, el bot responde con el mensaje de pausa.

---

## Etapa 9 · Token PERMANENTE (obligatorio antes de usarlo de verdad)

El token temporal vence en unas 24 horas. **No lo uses como configuración permanente.**

1. Entra a https://business.facebook.com → **Settings** (Configuración del negocio) → **Users → System users** → **Add**. Crea un usuario de sistema con rol **Admin**.
2. **Assign assets** (Asignar activos): la **app** (control total) y la **cuenta de WhatsApp** (control total).
3. **Generate new token**: elige la app, expiración **Never**, y los permisos `whatsapp_business_messaging` y `whatsapp_business_management`.
4. Copia el token **una sola vez** y actualiza el secreto:
   ```bash
   npx supabase secrets set WHATSAPP_TOKEN=EL_TOKEN_NUEVO
   ```
   No hace falta volver a desplegar: las funciones leen el nuevo valor en sus siguientes invocaciones.

Documentación: https://developers.facebook.com/docs/whatsapp/business-management-api/get-started#system-user-access-tokens

**✅ Cómo verificar:** al día siguiente (con el token temporal ya vencido) el bot sigue respondiendo.

---

## Etapa 10 · Pasar al número real de la juguería

1. **El número**: debe poder recibir un SMS o una llamada para verificarlo. Si hoy ese número usa la app de WhatsApp o WhatsApp Business, tienes dos caminos:
   - **Migrarlo** a la plataforma (deja de funcionar en la app); o
   - Usar la **coexistencia** (app de WhatsApp Business y Cloud API en el mismo número), si Meta la ofrece en Perú para tu cuenta. Revisa la documentación vigente antes de decidir.
2. En **WhatsApp → API Setup → Add phone number**, registra el número y el **nombre visible** (display name), que Meta revisa.
3. Agrega un **método de pago** en el Business Manager. Responder dentro de la ventana de 24 h no tiene costo según la tabla vigente, pero las plantillas fuera de esa ventana pueden cobrarse (ver [reglas](03-reglas-whatsapp.md)).
4. Publica la política de privacidad (`admin/public/privacidad.html`, completa los datos entre corchetes). Quedará en `https://TU_USUARIO.github.io/jugueriateresita/privacidad.html`. Ponla en **App settings → Basic → Privacy Policy URL** y cambia la app a modo **Live** (Publicada).
5. Si Meta lo exige para tus límites, completa la **verificación del negocio**.
6. Actualiza el secreto con el **Phone number ID del número real**:
   ```bash
   npx supabase secrets set WHATSAPP_PHONE_NUMBER_ID=ID_DEL_NUMERO_REAL
   ```
7. Comprueba que la cuenta de WhatsApp (WABA) tiene tu app suscrita. Si el webhook no recibe mensajes del número real, ejecuta (con el token permanente):
   ```bash
   curl -X POST "https://graph.facebook.com/v23.0/TU_WABA_ID/subscribed_apps" \
        -H "Authorization: Bearer $WHATSAPP_TOKEN"
   ```

**✅ Cómo verificar:** repite la checklist de la etapa 7 escribiendo **al número real** desde un celular que no sea de prueba.

---

## Etapa 11 (opcional) · Plantilla para avisos fuera de 24 h

Si un cliente no escribió en las últimas 24 h, WhatsApp no permite enviarle mensajes libres. Para avisarle que su pedido está listo:

1. En **WhatsApp Manager → Message templates → Create template**:
   - Categoría: **Utility** (utilidad). Nunca marketing.
   - Nombre: `actualizacion_pedido`
   - Idioma: Spanish (`es`)
   - Cuerpo: `Hola, tu pedido #{{1}} ahora está: {{2}}.`
2. Espera la aprobación.
3. Configura los secretos:
   ```bash
   npx supabase secrets set WHATSAPP_TEMPLATE_ORDER_UPDATE=actualizacion_pedido WHATSAPP_TEMPLATE_LANGUAGE=es
   ```

Sin plantilla, el panel muestra "⚠️ Cliente no avisado… Avísale por llamada", con su teléfono a un toque.

---

## Mantenimiento

- **Actualizar el código:** `git pull`, luego `npx supabase db push` (si hay migraciones nuevas) y `npx supabase functions deploy …`.
- **Limpiar la deduplicación** (opcional, una vez al mes, en SQL Editor):
  ```sql
  select public.purge_old_processed_messages();
  ```
- **Cambiar la versión de la Graph API:** Meta retira versiones con el tiempo. Cuando la actual se acerque a su fecha de retiro, define `WHATSAPP_API_VERSION=vXX.0` con una versión vigente.
- **Rotar secretos** si sospechas una filtración: genera un nuevo token o App Secret en Meta, actualízalo con `npx supabase secrets set …`, y revoca el anterior.

## Problemas frecuentes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Meta: "The callback URL or verify token couldn't be validated" | Token distinto, o la función se desplegó con verificación JWT | Revisa `WHATSAPP_VERIFY_TOKEN` y vuelve a desplegar con `--no-verify-jwt` |
| Logs: `webhook_invalid_signature` | `WHATSAPP_APP_SECRET` incorrecto | Copia de nuevo el App Secret de *App settings → Basic* |
| Logs: `webhook_messages_discarded` | El `WHATSAPP_PHONE_NUMBER_ID` no coincide con el número que recibe | Usa el Phone number ID del número al que escriben |
| Logs: `whatsapp_send_failed` con code `190` | Token vencido o inválido | Genera el token permanente (etapa 9) |
| code `131030` | Con el número de prueba, el destinatario no está en la lista | Agrégalo en *API Setup → To* |
| code `131047` | Pasaron más de 24 h desde el último mensaje del cliente | Normal; configura la plantilla (etapa 11) |
| El bot no responde nada | Proyecto de Supabase pausado o webhook sin suscripción a `messages` | Restaura el proyecto; revisa *Webhook fields* |
| El panel dice "Sin autorización" | Falta la fila en `admins` | Repite la etapa 4.3 |
