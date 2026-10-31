-- =====================================================================
--  MIGRASI 003 — Buku kas format tabel (iuran per warga per bulan)
--  Jalankan SEKALI di Supabase → SQL Editor dengan role: postgres.
--  Sudah mencakup migrasi 002, jadi cukup jalankan file ini saja.
--  Aman dijalankan ulang.
-- =====================================================================

-- 1. Rumah pembayar (dari migrasi 002)
alter table public.uang_kas
  add column if not exists nomor_rumah text
  check (nomor_rumah ~ '^[A-Z0-9-]{1,12}$');

-- 2. Bulan yang dibayar (selalu tanggal 1). Bisa berbeda dengan tanggal bayar,
--    mis. dibayar 3 Maret untuk iuran Januari & Februari.
alter table public.uang_kas
  add column if not exists periode_iuran date
  check (periode_iuran is null or extract(day from periode_iuran) = 1);

-- Isi periode untuk iuran lama yang sudah punya nomor rumah
update public.uang_kas
set periode_iuran = date_trunc('month', tanggal)::date
where tipe = 'masuk' and nomor_rumah is not null and periode_iuran is null;

create index if not exists idx_uang_kas_nomor_rumah on public.uang_kas (nomor_rumah);
create index if not exists idx_uang_kas_periode     on public.uang_kas (periode_iuran);

-- 3. Daftar nama warga untuk kolom "Nama" di tabel kas publik.
--    Tabel warga tetap tertutup; fungsi ini hanya membuka nama & nomor rumah
--    (yang memang sudah tampil di jadwal piket).
create or replace function public.daftar_warga_publik()
returns table (nomor_rumah text, nama text, aktif boolean)
language sql
stable
security definer
set search_path = public
as $$
  select w.nomor_rumah, w.nama, w.aktif from public.warga w order by w.id;
$$;

grant execute on function public.daftar_warga_publik() to anon, authenticated;

-- Cek hasil:
-- select * from public.daftar_warga_publik();
