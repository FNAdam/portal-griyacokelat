// =====================================================================
// Edge Function: bersih-foto
// Dipanggil pg_cron setiap awal bulan (lihat supabase/cron.sql).
//   1) Hapus FILE di bucket "foto-gerbang" yang berusia > 30 hari
//      (lewat Storage API agar file fisik benar-benar terhapus)
//   2) Hapus RECORD bukti_gerbang & token_piket yang berusia > 30 hari
//
// Deploy: supabase functions deploy bersih-foto --no-verify-jwt
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, cronSecretValid, json, todayWIB } from "../_shared/onesignal.ts";

const BUCKET = "foto-gerbang";
const BATAS_HARI = 30;
const HALAMAN = 1000; // jumlah objek per halaman list
const CHUNK_HAPUS = 100; // jumlah file per panggilan remove()

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!cronSecretValid(req)) return json({ error: "Unauthorized" }, 401);

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const batasWaktu = Date.now() - BATAS_HARI * 24 * 60 * 60 * 1000;

    // Batas tanggal (WIB) untuk record: hari ini - 30 hari
    const [y, m, d] = todayWIB().split("-").map(Number);
    const batasTanggal = new Date(Date.UTC(y, m - 1, d - BATAS_HARI)).toISOString().slice(0, 10);

    // --- 1. Kumpulkan file lama (diurutkan dari yang paling tua) ---
    const fileLama: string[] = [];
    for (let offset = 0; ; offset += HALAMAN) {
      const { data, error } = await admin.storage.from(BUCKET).list("", {
        limit: HALAMAN,
        offset,
        sortBy: { column: "created_at", order: "asc" },
      });
      if (error) throw error;
      if (!data || data.length === 0) break;

      let ketemuBaru = false;
      for (const obj of data) {
        if (!obj.id) continue; // lewati "folder"
        if (new Date(obj.created_at).getTime() < batasWaktu) fileLama.push(obj.name);
        else { ketemuBaru = true; break; } // sisanya pasti lebih baru
      }
      if (ketemuBaru || data.length < HALAMAN) break;
    }

    // --- 2. Hapus file per batch ---
    let fileTerhapus = 0;
    for (let i = 0; i < fileLama.length; i += CHUNK_HAPUS) {
      const batch = fileLama.slice(i, i + CHUNK_HAPUS);
      const { data, error } = await admin.storage.from(BUCKET).remove(batch);
      if (error) throw error;
      fileTerhapus += data?.length ?? 0;
    }

    // --- 3. Hapus record lama ---
    const { count: logTerhapus, error: e1 } = await admin
      .from("bukti_gerbang")
      .delete({ count: "exact" })
      .lt("tanggal", batasTanggal);
    if (e1) throw e1;

    const { count: tokenTerhapus, error: e2 } = await admin
      .from("token_piket")
      .delete({ count: "exact" })
      .lt("tanggal", batasTanggal);
    if (e2) throw e2;

    return json({ ok: true, batasTanggal, fileTerhapus, logTerhapus, tokenTerhapus });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
