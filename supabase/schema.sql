-- =====================================================================
--  PORTAL WARGA CLUSTER — SKEMA DATABASE, FUNGSI, RLS & STORAGE
--  Jalankan SELURUH file ini sekali di: Supabase Dashboard → SQL Editor
--  (aman dijalankan ulang untuk sebagian besar objek: memakai IF NOT EXISTS /
--   CREATE OR REPLACE / DROP POLICY IF EXISTS)
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. FUNGSI WAKTU: "hari ini" selalu dihitung dalam zona Asia/Jakarta (WIB)
--    Server Supabase berjalan di UTC; tanpa ini tanggal salah antara
--    pukul 00:00–07:00 WIB.
-- ---------------------------------------------------------------------
create or replace function public.today_wib()
returns date
language sql
stable
as $$
  select (now() at time zone 'Asia/Jakarta')::date;
$$;


-- ---------------------------------------------------------------------
-- 1. TABEL
-- ---------------------------------------------------------------------

-- 1a. Daftar akun pengurus (allowlist admin).
--     Login Supabase Auth saja TIDAK cukup untuk jadi admin; user_id harus
--     tercatat di sini. Isi manual lewat SQL Editor (lihat README).
create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  nama       text,
  created_at timestamptz not null default now()
);

-- 1b. Data warga (1 baris = 1 rumah). Dipakai generator jadwal & validasi.
--     Nomor rumah dinormalisasi: huruf besar, angka, dan tanda minus saja
--     (contoh: A12, B-07). Karakter lain dilarang agar aman dipakai di nama file.
create table if not exists public.warga (
  id          bigint generated always as identity primary key,
  nama        text not null,
  nomor_rumah text not null unique check (nomor_rumah ~ '^[A-Z0-9-]{1,12}$'),
  aktif       boolean not null default true,
  created_at  timestamptz not null default now()
);

-- 1c. Pengumuman & status keamanan (dibaca publik di dashboard)
create table if not exists public.tabel_pengumuman (
  id              bigint generated always as identity primary key,
  judul           text not null,
  isi             text not null,
  kategori        text not null default 'umum'
                  check (kategori in ('umum', 'keamanan', 'penting')),
  -- Diisi bila kategori = 'keamanan'; yang terbaru tampil sebagai status lingkungan
  status_keamanan text check (status_keamanan in ('aman', 'waspada', 'siaga')),
  aktif           boolean not null default true,
  created_at      timestamptz not null default now()
);

-- 1d. Jadwal piket kunci gerbang (1 tanggal = 1 rumah)
create table if not exists public.jadwal_piket (
  id          bigint generated always as identity primary key,
  tanggal     date not null unique,
  hari        text not null,
  nomor_rumah text not null,
  nama_warga  text not null,
  created_at  timestamptz not null default now()
);

-- 1e. Token rahasia per jadwal untuk link notifikasi (?token=...).
--     SENGAJA dipisah dari jadwal_piket: jadwal_piket bisa dibaca publik
--     (dan disiarkan lewat Realtime), sedangkan token TIDAK boleh bocor.
--     Token dibuat otomatis oleh trigger; tidak ada policy untuk anon.
create table if not exists public.token_piket (
  tanggal     date primary key
              references public.jadwal_piket (tanggal) on delete cascade on update cascade,
  nomor_rumah text not null,
  token       text not null unique,
  created_at  timestamptz not null default now()
);

-- 1f. Uang kas
create table if not exists public.uang_kas (
  id         bigint generated always as identity primary key,
  tanggal    date not null default public.today_wib(),
  -- Rumah pembayar (mis. iuran). Boleh kosong untuk pengeluaran/donasi umum.
  nomor_rumah text check (nomor_rumah ~ '^[A-Z0-9-]{1,12}$'),
  -- Bulan iuran yang dibayar (selalu tanggal 1); bisa beda dengan tanggal bayar
  periode_iuran date check (periode_iuran is null or extract(day from periode_iuran) = 1),
  keterangan text not null,
  tipe       text not null check (tipe in ('masuk', 'keluar')),
  jumlah     bigint not null check (jumlah > 0),
  created_at timestamptz not null default now()
);
-- Untuk database yang dibuat sebelum kolom-kolom ini ada (lihat supabase/migrations/003_buku_kas.sql):
alter table public.uang_kas
  add column if not exists nomor_rumah text check (nomor_rumah ~ '^[A-Z0-9-]{1,12}$');
alter table public.uang_kas
  add column if not exists periode_iuran date check (periode_iuran is null or extract(day from periode_iuran) = 1);

-- 1g. Log bukti foto gerbang. Karena warga (anon) tidak boleh membaca
--     storage, tabel inilah yang dipakai untuk mendeteksi "sudah upload hari ini".
create table if not exists public.bukti_gerbang (
  id          bigint generated always as identity primary key,
  nomor_rumah text not null,
  tanggal     date not null default public.today_wib(),
  path        text not null unique,
  created_at  timestamptz not null default now(),
  unique (nomor_rumah, tanggal)          -- pencegahan upload ganda di level DB
);

create index if not exists idx_uang_kas_tanggal      on public.uang_kas (tanggal desc);
create index if not exists idx_bukti_gerbang_tanggal on public.bukti_gerbang (tanggal);


-- ---------------------------------------------------------------------
-- 2. FUNGSI KEAMANAN (SECURITY DEFINER = berjalan dengan hak pemilik,
--    sehingga bisa membaca tabel yang tertutup bagi anon, tapi hanya
--    mengembalikan jawaban minimal yang aman)
-- ---------------------------------------------------------------------

-- Apakah user yang sedang login terdaftar sebagai pengurus?
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- Validasi token dari link notifikasi. Hanya berlaku untuk tanggal hari ini.
create or replace function public.cek_token(p_token text)
returns table (nomor_rumah text, nama_warga text, tanggal date)
language sql
stable
security definer
set search_path = public
as $$
  select j.nomor_rumah, j.nama_warga, j.tanggal
  from public.token_piket t
  join public.jadwal_piket j on j.tanggal = t.tanggal
  where t.token = p_token
    and t.tanggal = public.today_wib()
  limit 1;
$$;

-- Apakah rumah ini sudah mengunggah bukti hari ini?
create or replace function public.sudah_upload(p_nomor text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.bukti_gerbang
    where nomor_rumah = upper(trim(p_nomor))
      and tanggal = public.today_wib()
  );
$$;

-- Apakah nomor rumah terdaftar sebagai warga aktif? (dipakai saat daftar notifikasi)
create or replace function public.rumah_terdaftar(p_nomor text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.warga
    where nomor_rumah = upper(trim(p_nomor)) and aktif
  );
$$;

-- Nama & nomor rumah untuk kolom "Nama" di tabel kas publik (tabel warga tetap tertutup)
create or replace function public.daftar_warga_publik()
returns table (nomor_rumah text, nama text, aktif boolean)
language sql
stable
security definer
set search_path = public
as $$
  select w.nomor_rumah, w.nama, w.aktif from public.warga w order by w.id;
$$;

-- Dipakai policy storage: nama file harus PERSIS "NomorRumah_YYYY-MM-DD.jpg"
-- milik rumah yang terjadwal HARI INI, dan rumah itu belum tercatat upload.
create or replace function public.boleh_upload_file(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.jadwal_piket j
    where j.tanggal = public.today_wib()
      and p_name = j.nomor_rumah || '_' || to_char(j.tanggal, 'YYYY-MM-DD') || '.jpg'
      and not exists (
        select 1 from public.bukti_gerbang b
        where b.nomor_rumah = j.nomor_rumah and b.tanggal = j.tanggal
      )
  );
$$;


-- ---------------------------------------------------------------------
-- 3. TRIGGER: buat token otomatis setiap jadwal dibuat / diubah
--    Contoh token: A12_9f3c1b7e20d4
-- ---------------------------------------------------------------------
create or replace function public.buat_token_piket()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.token_piket (tanggal, nomor_rumah, token)
  values (
    new.tanggal,
    new.nomor_rumah,
    new.nomor_rumah || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
  )
  on conflict (tanggal) do update
    set nomor_rumah = excluded.nomor_rumah,
        token       = excluded.token,
        created_at  = now();
  return new;
end;
$$;

drop trigger if exists trg_buat_token_piket on public.jadwal_piket;
create trigger trg_buat_token_piket
after insert or update of nomor_rumah, tanggal on public.jadwal_piket
for each row execute function public.buat_token_piket();


-- ---------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY (RLS)
--    Publik (anon)  : SELECT pengumuman, jadwal, kas; INSERT log bukti.
--    Admin          : FULL (SELECT/INSERT/UPDATE/DELETE) via is_admin().
--    Catatan: "authenticated" saja TIDAK dianggap admin, supaya orang yang
--    iseng mendaftar akun tidak otomatis jadi pengurus.
-- ---------------------------------------------------------------------
alter table public.admins           enable row level security;
alter table public.warga            enable row level security;
alter table public.tabel_pengumuman enable row level security;
alter table public.jadwal_piket     enable row level security;
alter table public.token_piket      enable row level security;
alter table public.uang_kas         enable row level security;
alter table public.bukti_gerbang    enable row level security;

-- admins: pengurus hanya bisa melihat barisnya sendiri (isi via SQL Editor)
drop policy if exists "admins_lihat_diri_sendiri" on public.admins;
create policy "admins_lihat_diri_sendiri" on public.admins
  for select to authenticated using (user_id = auth.uid());

-- warga: hanya admin (data pribadi tidak dibuka ke publik)
drop policy if exists "warga_admin_full" on public.warga;
create policy "warga_admin_full" on public.warga
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- tabel_pengumuman: publik baca, admin full
drop policy if exists "pengumuman_publik_baca" on public.tabel_pengumuman;
create policy "pengumuman_publik_baca" on public.tabel_pengumuman
  for select to anon, authenticated using (true);
drop policy if exists "pengumuman_admin_full" on public.tabel_pengumuman;
create policy "pengumuman_admin_full" on public.tabel_pengumuman
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- jadwal_piket: publik baca, admin full
drop policy if exists "jadwal_publik_baca" on public.jadwal_piket;
create policy "jadwal_publik_baca" on public.jadwal_piket
  for select to anon, authenticated using (true);
drop policy if exists "jadwal_admin_full" on public.jadwal_piket;
create policy "jadwal_admin_full" on public.jadwal_piket
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- token_piket: TIDAK ada akses anon sama sekali. Admin boleh baca (debug).
drop policy if exists "token_admin_baca" on public.token_piket;
create policy "token_admin_baca" on public.token_piket
  for select to authenticated using (public.is_admin());

-- uang_kas: publik baca, admin (bendahara) full
drop policy if exists "kas_publik_baca" on public.uang_kas;
create policy "kas_publik_baca" on public.uang_kas
  for select to anon, authenticated using (true);
drop policy if exists "kas_admin_full" on public.uang_kas;
create policy "kas_admin_full" on public.uang_kas
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- bukti_gerbang: publik hanya INSERT, dan hanya untuk rumah terjadwal hari ini
-- dengan path yang benar. Tidak bisa melihat/menghapus log rumah lain.
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
  );
drop policy if exists "bukti_admin_full" on public.bukti_gerbang;
create policy "bukti_admin_full" on public.bukti_gerbang
  for all to authenticated using (public.is_admin()) with check (public.is_admin());


-- ---------------------------------------------------------------------
-- 5. STORAGE: bucket PRIVAT "foto-gerbang"
--    - Privat: foto tidak bisa dibuka lewat URL publik.
--    - Maks 2 MB, hanya JPEG (aplikasi sudah mengompres foto sebelum upload).
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('foto-gerbang', 'foto-gerbang', false, 2097152, array['image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Publik: hanya INSERT, dengan nama file yang valid untuk jadwal hari ini.
-- Tanpa policy SELECT/UPDATE/DELETE → tidak bisa melihat, menimpa,
-- atau menghapus foto rumah lain. (Upload memakai upsert:false.)
drop policy if exists "foto_publik_insert" on storage.objects;
create policy "foto_publik_insert" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'foto-gerbang'
    and public.boleh_upload_file(name)
  );

-- Admin: full akses ke bucket foto-gerbang
drop policy if exists "foto_admin_full" on storage.objects;
create policy "foto_admin_full" on storage.objects
  for all to authenticated
  using (bucket_id = 'foto-gerbang' and public.is_admin())
  with check (bucket_id = 'foto-gerbang' and public.is_admin());


-- ---------------------------------------------------------------------
-- 6. REALTIME: daftarkan tabel yang perlu siaran perubahan langsung.
--    Tanpa ini, subscription di browser tersambung tapi tidak pernah menerima event.
--    (token_piket & bukti_gerbang sengaja TIDAK didaftarkan)
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['tabel_pengumuman', 'jadwal_piket', 'uang_kas'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;


-- ---------------------------------------------------------------------
-- 7. DATA CONTOH (opsional — hapus bagian ini jika tidak perlu)
-- ---------------------------------------------------------------------
insert into public.tabel_pengumuman (judul, isi, kategori, status_keamanan)
values
  ('Selamat datang di Portal Warga',
   'Portal ini berisi informasi cluster, jadwal piket kunci gerbang, dan laporan kas warga.',
   'umum', null),
  ('Status Lingkungan',
   'Lingkungan dalam kondisi aman dan kondusif. Tetap kunci pintu dan pagar rumah di malam hari.',
   'keamanan', 'aman');


-- ---------------------------------------------------------------------
-- 8. MENJADIKAN AKUN SEBAGAI ADMIN (jalankan terpisah setelah membuat user
--    di Authentication → Users). Ganti email di bawah:
--
--    insert into public.admins (user_id, nama)
--    select id, 'Ketua RT' from auth.users where email = 'pengurus@contoh.com';
-- ---------------------------------------------------------------------
