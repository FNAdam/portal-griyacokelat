// =====================================================================
// Edge Function: kirim-notifikasi
// Dipanggil dari admin.html (tombol "Kirim Notifikasi Broadcast").
// Hanya pengurus (terdaftar di tabel admins) yang boleh memicu broadcast.
//
// Deploy: supabase functions deploy kirim-notifikasi
// Body  : { "judul": "...", "pesan": "...", "url": "https://..." }
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json, kirimOneSignal } from "../_shared/onesignal.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method tidak diizinkan" }, 405);

  try {
    // Client yang bertindak SEBAGAI user pemanggil (JWT dari header),
    // sehingga is_admin() mengevaluasi auth.uid() milik user tersebut.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );

    const { data: isAdmin, error } = await supabase.rpc("is_admin");
    if (error || !isAdmin) {
      return json({ error: "Hanya pengurus yang boleh mengirim notifikasi" }, 403);
    }

    const { judul, pesan, url } = await req.json();
    if (!judul || !pesan) return json({ error: "Judul dan pesan wajib diisi" }, 400);

    // "Total Subscriptions" = segmen bawaan OneSignal berisi semua pelanggan
    const hasil = await kirimOneSignal(
      { segments: ["Total Subscriptions"] },
      String(judul).slice(0, 100),
      String(pesan).slice(0, 500),
      url || Deno.env.get("SITE_URL"),
    );
    return json({ ok: true, hasil });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
