// =====================================================================
// Utilitas bersama Edge Functions: CORS, respons JSON, kirim OneSignal.
// Secret yang dibutuhkan (supabase secrets set ...):
//   ONESIGNAL_APP_ID, ONESIGNAL_REST_API_KEY, SITE_URL, CRON_SECRET
// REST API Key TIDAK PERNAH dikirim ke browser — hanya ada di server ini.
// =====================================================================

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Tanggal hari ini (YYYY-MM-DD) dalam zona Asia/Jakarta. */
export function todayWIB(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Validasi header x-cron-secret untuk fungsi yang dipanggil pg_cron. */
export function cronSecretValid(req: Request): boolean {
  const expected = Deno.env.get("CRON_SECRET");
  return !!expected && req.headers.get("x-cron-secret") === expected;
}

type Target =
  | { segments: string[] }
  | { filters: Record<string, string>[] };

/**
 * Kirim push notification via OneSignal REST API.
 * Docs: https://documentation.onesignal.com/reference/push-notification
 */
export async function kirimOneSignal(
  target: Target,
  judul: string,
  pesan: string,
  url?: string,
) {
  const appId = Deno.env.get("ONESIGNAL_APP_ID");
  const apiKey = Deno.env.get("ONESIGNAL_REST_API_KEY");
  if (!appId || !apiKey) throw new Error("Secret OneSignal belum diset");

  const body: Record<string, unknown> = {
    app_id: appId,
    target_channel: "push",
    headings: { en: judul, id: judul },
    contents: { en: pesan, id: pesan },
    ...("segments" in target
      ? { included_segments: target.segments }
      : { filters: target.filters }),
  };
  if (url) body.web_url = url;

  const res = await fetch("https://api.onesignal.com/notifications?c=push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OneSignal ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
