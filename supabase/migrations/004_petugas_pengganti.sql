-- =====================================================================
--  MIGRASI 004 — Petugas pengganti & status piket
--  Jalankan SEKALI di Supabase → SQL Editor dengan role: postgres.
--  Aman dijalankan ulang.
--
--  Kasus: yang mengunci gerbang bukan rumah yang terjadwal. Rumah pengganti
--  (harus terdaftar sebagai warga aktif) boleh mengunggah bukti atas nama
--  jadwal hari itu. Tetap 1 foto per hari; nama file tetap milik rumah terjadwal.
-- =====================================================================

-- 1. Siapa yang sebenarnya mengunggah (nomor rumah). Sama dengan nomor_rumah
--    bila petugas terjadwal sendiri; berbeda bila pengganti.
alter table public.bukti_gerbang
  add column if not exists diunggah_oleh text
  check (diunggah_oleh ~ '^[A-Z0-9-]{1,12}$');

-- 2. Policy insert publik: pengganti harus warga aktif terdaftar
drop policy if exists "bukti_publik_insert" on public.bukti_gerbang;
create policy "bukti_publik_insert" on public.bukti_gerbang
  for insert to anon, authenticated
  with check (
    tanggal = public.today_wib()
    and path = nomor_rumah || '_' || to_char(tanggal, 'YYYY-MM-DD') || '.jpg'
    and exists (
      select 1 from public.jadwal_piket j
      where j.tanggal = bukti_gerbang.tanggal
        and j.nomor_rumah = bukti_gerbang.nomor_rumah
    )
    and (
      diunggah_oleh is null
      or diunggah_oleh = nomor_rumah
      or public.rumah_terdaftar(diunggah_oleh)
    )
  );

-- 3. Status piket untuk tampilan publik (tanpa foto): siapa yang mengunci & jam upload.
--    Rentang dibatasi maks. 62 hari per panggilan.
create or replace function public.status_piket(p_dari date, p_sampai date)
returns table (tanggal date, nomor_rumah text, diunggah_oleh text, waktu_upload timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select b.tanggal, b.nomor_rumah, coalesce(b.diunggah_oleh, b.nomor_rumah), b.created_at
  from public.bukti_gerbang b
  where b.tanggal between p_dari and p_sampai
    and p_sampai - p_dari <= 62;
$$;

grant execute on function public.status_piket(date, date) to anon, authenticated;

-- Cek hasil:
-- select * from public.status_piket(public.today_wib() - 7, public.today_wib());
