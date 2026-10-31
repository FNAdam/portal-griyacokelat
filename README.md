# Portal Warga Cluster (Jamstack / Serverless)

Portal warga yang 100% berjalan di sisi client (cocok untuk **GitHub Pages**), dengan
**Supabase** (database, auth, storage, realtime, edge functions, cron) dan **OneSignal** (web push).

## Struktur File

```
├── index.html                 # Portal warga (publik): dashboard, pengumuman, jadwal, kas, daftar notifikasi
├── upload.html                # Upload foto bukti kunci gerbang (token URL / nomor rumah)
├── admin.html                 # Panel pengurus (login): generator jadwal, broadcast, kas, pengumuman, warga, bukti
├── OneSignalSDKWorker.js      # Service worker OneSignal (WAJIB di root)
├── .nojekyll                  # Matikan Jekyll di GitHub Pages
├── assets/js/
│   ├── config.js              # ⚙️ KONFIGURASI — isi URL/key Supabase & App ID OneSignal
│   ├── tailwind-config.js     # Tema warna Tailwind
│   ├── common.js              # Utilitas bersama (Supabase client, tanggal WIB, format Rupiah, toast)
│   ├── index.js               # Logika halaman warga + OneSignal tag
│   ├── upload.js              # Logika upload bukti (alur ganda + anti upload ganda)
│   └── admin.js               # Logika panel pengurus
└── supabase/
    ├── schema.sql             # DDL tabel, fungsi, trigger, RLS, bucket & policy storage, realtime
    ├── cron.sql               # Jadwal pg_cron (pembersihan bulanan & notifikasi harian)
    └── functions/
        ├── _shared/onesignal.ts
        ├── kirim-notifikasi/  # Broadcast dari admin (cek is_admin)
        ├── notif-harian/      # Push harian ke rumah piket + link ?token=
        └── bersih-foto/       # Hapus file & record > 30 hari
```

## Arsitektur Singkat

| Fitur | Cara kerja |
|---|---|
| Pengumuman & status keamanan | `tabel_pengumuman` dibaca publik + **Realtime**. Status keamanan = pengumuman kategori `keamanan` terbaru. |
| Jam gerbang | Dihitung di browser dari jam **WIB** (`Asia/Jakarta`), aturan di `config.js` (05:00–23:00). |
| Jadwal piket | Admin mengacak `warga` aktif (Fisher–Yates) → `upsert` ke `jadwal_piket` → warga melihat via Realtime. |
| Token link notifikasi | Trigger DB membuat token acak per tanggal di tabel **`token_piket`** (tertutup untuk publik). Divalidasi lewat RPC `cek_token()` dan hanya berlaku di hari itu. |
| Notifikasi | Warga klik *Aktifkan* → *Allow* → isi nomor rumah → tag `nomor_rumah`. Banyak HP dengan nomor rumah sama mendapat tag sama sehingga semuanya tersasar filter. |
| Upload bukti | File dikompres ke JPEG, nama `NomorRumah_YYYY-MM-DD.jpg`, `upsert:false`. Dicatat ke `bukti_gerbang` (UNIQUE per rumah per hari). |
| Kunci API rahasia | OneSignal REST API Key & service role **hanya** di Edge Function secrets, tidak pernah di repo/browser. |

## Checklist Urutan Pertama Kali

1. Jalankan `supabase/schema.sql`.
2. Matikan sign-up publik di Supabase Auth.
3. Buat user pengurus dan masukkan barisnya ke tabel `admins`.
4. Isi `assets/js/config.js`, lalu push ke GitHub Pages.
5. Login di `admin.html` → tab **Warga** → masukkan semua rumah.
   (Tanpa data warga, pendaftaran notifikasi menolak semua nomor rumah dan generator tidak bisa mengacak.)
6. Tab **Jadwal** → acak & terbitkan.
7. Set secrets, deploy Edge Functions, lalu jalankan `supabase/cron.sql`.
8. Umumkan ke warga untuk mengaktifkan notifikasi di halaman utama.

## Langkah Setup

### 1. Supabase — database
1. Buat proyek di <https://supabase.com>.
2. **SQL Editor** → tempel & jalankan seluruh isi `supabase/schema.sql`.
   Ini membuat tabel, fungsi, trigger, RLS, bucket privat `foto-gerbang` beserta policy, dan mendaftarkan Realtime.

### 2. Supabase — akun pengurus (PENTING untuk keamanan)
1. **Authentication → Sign In / Providers → Email**: **matikan "Allow new users to sign up"**.
   Tanpa ini siapa pun bisa membuat akun. (RLS tetap aman karena memakai allowlist `admins`, tapi sebaiknya tetap ditutup.)
2. **Authentication → Users → Add user**: buat akun pengurus (email + password, centang *Auto Confirm*).
3. Daftarkan sebagai admin di SQL Editor:
   ```sql
   insert into public.admins (user_id, nama)
   select id, 'Ketua RT' from auth.users where email = 'pengurus@contoh.com';
   ```

### 3. OneSignal
1. Buat app di <https://onesignal.com> → platform **Web** → *Typical Site*.
2. **Site URL** = origin saja, mis. `https://username.github.io` (tanpa nama repo).
3. Catat **App ID** dan buat **App API Key** (Settings → Keys & IDs).
4. File `OneSignalSDKWorker.js` sudah tersedia di root repo. Kode `index.js` otomatis
   menyetel `serviceWorkerPath` & `scope` sesuai sub-path GitHub Pages (`/nama-repo/`).
   Di dashboard OneSignal, bila diminta path service worker, isi sesuai sub-path tersebut.

### 4. Edge Functions & secrets (butuh [Supabase CLI](https://supabase.com/docs/guides/cli))
```bash
supabase login
supabase link --project-ref PROJECT_REF

supabase secrets set \
  ONESIGNAL_APP_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  ONESIGNAL_REST_API_KEY=os_v2_app_xxxxxxxx \
  SITE_URL=https://username.github.io/nama-repo/ \
  CRON_SECRET=string-acak-panjang-yang-sama-dengan-di-vault

supabase functions deploy kirim-notifikasi
supabase functions deploy notif-harian --no-verify-jwt
supabase functions deploy bersih-foto  --no-verify-jwt
```
`notif-harian` & `bersih-foto` dilindungi header `x-cron-secret`; `kirim-notifikasi` memeriksa JWT + `is_admin()`.

### 5. Cron Job
Edit nilai di `supabase/cron.sql` (URL proyek & `CRON_SECRET` yang sama), lalu jalankan di SQL Editor.
- `bersih-foto-bulanan` — tanggal 1 tiap bulan 07:00 WIB: hapus **file** foto > 30 hari (via Storage API) dan **record** `bukti_gerbang` + `token_piket` > 30 hari.
- `notif-piket-harian` — tiap hari 17:00 WIB: push ke HP ber-tag rumah piket hari itu dengan link `upload.html?token=...`.

### 6. Frontend & GitHub Pages
1. Isi `assets/js/config.js` (Supabase URL, **anon** key, OneSignal App ID, nama cluster).
2. Push ke GitHub → **Settings → Pages** → Deploy from branch `main` / root.
3. Buka `https://username.github.io/nama-repo/`.

## Ringkasan Hak Akses (RLS)

| Objek | Publik (anon) | Admin (`is_admin()`) |
|---|---|---|
| `tabel_pengumuman`, `jadwal_piket`, `uang_kas` | SELECT | FULL |
| `warga` | — (cek lewat RPC `rumah_terdaftar` → true/false) | FULL |
| `token_piket` | — (cek lewat RPC `cek_token`) | SELECT |
| `bukti_gerbang` | INSERT (hanya rumah terjadwal hari ini) | FULL |
| Storage `foto-gerbang` (privat) | INSERT saja, nama file harus cocok jadwal hari ini; tidak bisa lihat/timpa/hapus | FULL |

> Menyembunyikan tombol di UI bukan pengaman. Semua pembatasan ditegakkan oleh RLS di database.

## Catatan
- **SDK OneSignal v16**: padanan `OneSignal.sendTag()` (v15) adalah `OneSignal.User.addTag()`. Fungsi `sendTagNomorRumah()` di `index.js` menangani keduanya.
- **iPhone/iPad**: web push hanya berfungsi bila situs ditambahkan ke *Home Screen* (iOS 16.4+).
- **Tailwind Play CDN** dipakai agar tanpa proses build. Untuk produksi yang lebih ringan, bisa diganti dengan Tailwind CLI.
- Generator membuat jadwal **1 bulan penuh** sekali klik. Giliran berputar sehingga semua rumah kebagian sebelum ada yang mengulang; rumah yang paling sering bertugas 30 hari terakhir ditaruh di urutan akhir. Tanggal hari ini dan sebelumnya tidak diubah.
- Semua tanggal "hari ini" dihitung dalam **WIB**, baik di browser maupun di database (`today_wib()`).
- Token link & izin upload berlaku sampai **23:59 WIB** di hari jadwal. Upload setelah tengah malam ditolak (sesuai aturan "tanggal hari ini").

## Troubleshooting
- **Broadcast gagal 401** dari `kirim-notifikasi`: proyek baru dengan *publishable key* / JWT asimetris bisa ditolak gateway.
  Deploy ulang dengan `--no-verify-jwt`. Ini tetap aman karena fungsi tetap memeriksa `is_admin()` memakai JWT pemanggil.
- **Broadcast gagal "segment not found"**: cek nama segmen di OneSignal → Audience → Segments. Kode memakai
  `Total Subscriptions`; sesuaikan di `supabase/functions/kirim-notifikasi/index.ts` bila berbeda.
- **Realtime tidak memperbarui halaman**: pastikan bagian 6 `schema.sql` (publication `supabase_realtime`) sudah berjalan.
- **Hasil cron**: `select * from net._http_response order by created desc limit 10;`
