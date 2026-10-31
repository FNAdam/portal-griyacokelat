/* =====================================================================
 * KONFIGURASI APLIKASI — satu-satunya file yang WAJIB Anda ubah.
 *
 * Aman untuk dipublikasikan di repo publik GitHub Pages:
 *  - SUPABASE_ANON_KEY memang kunci publik; keamanan dijaga oleh RLS.
 *  - ONESIGNAL_APP_ID juga publik.
 * JANGAN PERNAH menaruh service_role key atau OneSignal REST API Key di sini.
 * ===================================================================== */
window.APP_CONFIG = {
  // Supabase → Project Settings → API
  SUPABASE_URL: "https://vjvgjwxarusxrmauouks.supabase.co",
  // Isi dengan "anon public" key (legacy) ATAU "publishable" key (sb_publishable_...)
  // JANGAN PERNAH isi dengan secret key (sb_secret_...)
  SUPABASE_ANON_KEY: "sb_publishable_hPdOjoVmTxcrHLKqxKfXRQ_EiMH9ZB5",

  // OneSignal → Settings → Keys & IDs
  ONESIGNAL_APP_ID: "4957da47-e06d-4cd2-8874-9dd4b80afab9",

  // Identitas cluster
  NAMA_CLUSTER: "Cluster Griya Cokelat",
  ALAMAT_CLUSTER: "Jl. Griya Cokelat Raya, Kota Anda",
  KONTAK_SATPAM: "0812-0000-0000",

  // Aturan jam gerbang (WIB)
  JAM_BUKA: "05:00",
  JAM_TUTUP: "23:00",

  // Nama bucket Supabase Storage
  BUCKET_FOTO: "foto-gerbang",
};
