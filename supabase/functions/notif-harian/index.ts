// =====================================================================
// Edge Function: notif-harian
// Dipanggil pg_cron setiap hari (lihat supabase/cron.sql).
// Mengirim push HANYA ke HP yang ber-tag nomor_rumah = rumah piket hari ini,
// berisi link upload.html?token=XXXX → warga langsung bisa upload tanpa mengetik.
// Semua HP dalam 1 rumah (tag sama) menerima notifikasi yang sama.
//
// Deploy: supabase functions deploy notif-harian --no-verify-jwt
//         (diamankan dengan header x-cron-secret, bukan JWT)
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  corsHeaders, cronSecretValid, json, kirimOneSignal, todayWIB,
} from "../_shared/onesignal.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!cronSecretValid(req)) return json({ error: "Unauthorized" }, 401);

  try {
    // Service role: boleh membaca token_piket (tertutup untuk publik)
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const hariIni = todayWIB();

    const { data: jadwal, error: e1 } = await admin
      .from("jadwal_piket")
      .select("nomor_rumah, nama_warga, hari")
      .eq("tanggal", hariIni)
      .maybeSingle();
    if (e1) throw e1;
    if (!jadwal) return json({ ok: true, info: `Tidak ada jadwal untuk ${hariIni}` });

    const { data: tok, error: e2 } = await admin
      .from("token_piket")
      .select("token")
      .eq("tanggal", hariIni)
      .maybeSingle();
    if (e2) throw e2;
    if (!tok) return json({ error: "Token hari ini tidak ditemukan" }, 404);

    const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/?$/, "/");
    const link = `${siteUrl}upload.html?token=${encodeURIComponent(tok.token)}`;

    const hasil = await kirimOneSignal(
      { filters: [{ field: "tag", key: "nomor_rumah", relation: "=", value: jadwal.nomor_rumah }] },
      "Giliran Kunci Gerbang Malam Ini",
      `${jadwal.hari}: rumah ${jadwal.nomor_rumah} (${jadwal.nama_warga}) bertugas mengunci gerbang pukul 23:00. Ketuk untuk upload foto bukti.`,
      link,
    );
    return json({ ok: true, nomor_rumah: jadwal.nomor_rumah, hasil });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
