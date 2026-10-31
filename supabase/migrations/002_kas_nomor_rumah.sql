-- =====================================================================
--  MIGRASI 002 — Tambah kolom nomor_rumah pada uang_kas
--  Jalankan SEKALI di Supabase → SQL Editor (role: postgres) bila
--  schema.sql sudah pernah dijalankan sebelum perubahan ini.
--  Aman dijalankan ulang.
-- =====================================================================
alter table public.uang_kas
  add column if not exists nomor_rumah text
  check (nomor_rumah ~ '^[A-Z0-9-]{1,12}$');

create index if not exists idx_uang_kas_nomor_rumah on public.uang_kas (nomor_rumah);

-- Cek hasil:
-- select column_name, data_type from information_schema.columns
-- where table_schema = 'public' and table_name = 'uang_kas';
