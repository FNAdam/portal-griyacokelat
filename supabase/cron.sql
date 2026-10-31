-- =====================================================================
--  CRON JOB (pg_cron + pg_net) — jalankan SETELAH Edge Function di-deploy
--  Supabase Dashboard → SQL Editor
--
--  Catatan zona waktu: pg_cron di Supabase memakai UTC.
--    10:00 UTC = 17:00 WIB
--    00:00 UTC = 07:00 WIB
-- =====================================================================

-- 1. Aktifkan ekstensi (bisa juga lewat Database → Extensions)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2. Simpan URL proyek & secret cron di Vault (JANGAN hardcode di job).
--    Ganti nilainya. CRON_SECRET harus SAMA dengan secret Edge Function:
--      supabase secrets set CRON_SECRET=...
select vault.create_secret('https://PROJECT_REF.supabase.co', 'project_url');
select vault.create_secret('GANTI_DENGAN_STRING_ACAK_PANJANG', 'cron_secret');


-- 3. PEMBERSIHAN BULANAN — setiap tanggal 1 pukul 07:00 WIB
--    Memanggil Edge Function "bersih-foto" yang:
--      a) menghapus FILE foto > 30 hari dari bucket foto-gerbang (via Storage API)
--      b) menghapus RECORD bukti_gerbang & token_piket > 30 hari
--    File dihapus lewat Storage API, BUKAN "delete from storage.objects",
--    karena delete SQL hanya menghapus metadata dan meninggalkan file yatim.
select cron.schedule(
  'bersih-foto-bulanan',
  '0 0 1 * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/bersih-foto',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);


-- 4. NOTIFIKASI HARIAN — setiap hari 17:00 WIB
--    Memanggil Edge Function "notif-harian" yang mengirim push ke HP rumah
--    yang terjadwal hari ini (filter tag nomor_rumah) berisi link
--    upload.html?token=XXXX (jalur utama tanpa mengetik).
select cron.schedule(
  'notif-piket-harian',
  '0 10 * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/notif-harian',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);


-- =====================================================================
--  UTILITAS
-- =====================================================================
-- Lihat daftar job:
--   select jobid, jobname, schedule, active from cron.job;
-- Riwayat eksekusi:
--   select * from cron.job_run_details order by start_time desc limit 20;
-- Respons HTTP dari pg_net:
--   select id, status_code, content from net._http_response order by created desc limit 10;
-- Hapus job:
--   select cron.unschedule('bersih-foto-bulanan');
--
-- Alternatif SQL murni (HANYA record, tidak menghapus file fisik) —
-- tidak disarankan sebagai satu-satunya mekanisme:
--   delete from public.bukti_gerbang where tanggal < public.today_wib() - 30;
--   delete from public.token_piket   where tanggal < public.today_wib() - 30;
