/* =====================================================================
 * common.js — Utilitas bersama untuk semua halaman
 *  - Inisialisasi Supabase client
 *  - Fungsi tanggal/waktu WIB (Asia/Jakarta)
 *  - Format Rupiah, escape HTML, normalisasi nomor rumah, toast
 * ===================================================================== */

const CFG = window.APP_CONFIG;

// Supabase client global (library dimuat dari CDN sebagai window.supabase)
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

const TZ = "Asia/Jakarta";
const NAMA_HARI = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];

/* ---------------------------------------------------------------------
 * TANGGAL & WAKTU (semua dihitung di WIB, bukan zona waktu perangkat)
 * Catatan: jangan pakai new Date().toISOString() untuk "hari ini" —
 * hasilnya tanggal UTC dan salah antara pukul 00:00–07:00 WIB.
 * ------------------------------------------------------------------- */

/** "YYYY-MM-DD" hari ini di WIB */
function todayWIB() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** Jam & menit sekarang di WIB → { jam, menit, teks: "HH:MM:SS" } */
function nowWIB() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    jam: Number(get("hour")),
    menit: Number(get("minute")),
    teks: `${get("hour")}:${get("minute")}:${get("second")}`,
  };
}

/** "HH:MM" → jumlah menit sejak 00:00 */
function keMenit(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Status gerbang saat ini berdasarkan aturan jam buka/tutup */
function statusGerbang() {
  const { jam, menit } = nowWIB();
  const sekarang = jam * 60 + menit;
  const buka = sekarang >= keMenit(CFG.JAM_BUKA) && sekarang < keMenit(CFG.JAM_TUTUP);
  return { buka };
}

/** Tambah n hari ke string "YYYY-MM-DD" (aman dari pergeseran zona waktu) */
function tambahHari(tanggal, n) {
  const [y, m, d] = tanggal.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Indeks hari dengan Senin = 0 ... Minggu = 6 */
function indeksHariSenin(tanggal) {
  const [y, m, d] = tanggal.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Senin dari pekan yang memuat tanggal tsb */
function seninPekanIni(tanggal = todayWIB()) {
  return tambahHari(tanggal, -indeksHariSenin(tanggal));
}

/** "2026-10-27" → "Selasa, 27 Oktober 2026" */
function formatTanggal(tanggal, opsi = { weekday: "long", day: "numeric", month: "long", year: "numeric" }) {
  if (!tanggal) return "-";
  const [y, m, d] = String(tanggal).slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", { ...opsi, timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/** Format timestamp lengkap ke WIB, mis. untuk pengumuman */
function formatWaktu(ts) {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: TZ, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(ts)) + " WIB";
}

/* ---------------------------------------------------------------------
 * FORMAT & SANITASI
 * ------------------------------------------------------------------- */

const _rupiah = new Intl.NumberFormat("id-ID", {
  style: "currency", currency: "IDR", maximumFractionDigits: 0,
});
function formatRupiah(n) {
  return _rupiah.format(Number(n) || 0);
}

/** Cegah XSS: selalu escape data dari database sebelum masuk innerHTML */
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/**
 * Normalisasi nomor rumah agar konsisten di DB, tag OneSignal, & nama file.
 * " a 12 " → "A12", "b/07" → "B07", "C-3" → "C-3"
 */
function normalisasiNomorRumah(input) {
  return String(input || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12);
}

/**
 * Ambil SEMUA baris dengan paging (API Supabase membatasi ~1000 baris per query).
 * buatQuery: fungsi yang mengembalikan query builder baru, mis.
 *   () => sb.from("uang_kas").select("tipe, jumlah").order("id")
 */
async function ambilSemua(buatQuery, ukuran = 1000) {
  const hasil = [];
  for (let dari = 0; ; dari += ukuran) {
    const { data, error } = await buatQuery().range(dari, dari + ukuran - 1);
    if (error) return { data: null, error };
    hasil.push(...data);
    if (data.length < ukuran) return { data: hasil, error: null };
  }
}

/** Hitung ringkasan kas dari array transaksi */
function hitungRingkasanKas(rows) {
  let masuk = 0, keluar = 0;
  for (const r of rows) {
    if (r.tipe === "masuk") masuk += Number(r.jumlah);
    else keluar += Number(r.jumlah);
  }
  return { masuk, keluar, saldo: masuk - keluar };
}

/* ---------------------------------------------------------------------
 * UI HELPER
 * ------------------------------------------------------------------- */

/** Notifikasi kecil di pojok layar. tipe: "sukses" | "error" | "info" */
function toast(pesan, tipe = "info") {
  let wadah = document.getElementById("toast-wadah");
  if (!wadah) {
    wadah = document.createElement("div");
    wadah.id = "toast-wadah";
    wadah.className = "fixed top-4 inset-x-4 sm:left-auto sm:right-4 sm:w-96 z-[60] space-y-2";
    document.body.appendChild(wadah);
  }
  const gaya = {
    sukses: ["bg-emerald-600", "fa-circle-check"],
    error: ["bg-rose-600", "fa-circle-exclamation"],
    info: ["bg-stone-800", "fa-circle-info"],
  }[tipe] || ["bg-stone-800", "fa-circle-info"];

  const el = document.createElement("div");
  el.className = `${gaya[0]} text-white px-4 py-3 rounded-xl shadow-lg flex items-start gap-3 text-sm transition-opacity duration-300`;
  el.innerHTML = `<i class="fa-solid ${gaya[1]} mt-0.5"></i><span class="flex-1"></span>`;
  el.querySelector("span").textContent = pesan;
  wadah.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 4000);
}

/** Tampilkan / sembunyikan elemen berdasarkan id */
function tampil(id, ya = true) {
  document.getElementById(id)?.classList.toggle("hidden", !ya);
}

/** Set teks tombol jadi loading & nonaktifkan; kembalikan fungsi untuk memulihkan */
function tombolLoading(btn, teks = "Memproses...") {
  const asli = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>${teks}`;
  return () => { btn.disabled = false; btn.innerHTML = asli; };
}

/** Isi nama cluster di elemen ber-atribut data-nama-cluster */
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-nama-cluster]").forEach((el) => (el.textContent = CFG.NAMA_CLUSTER));
  document.querySelectorAll("[data-tahun]").forEach((el) => (el.textContent = todayWIB().slice(0, 4)));
});
