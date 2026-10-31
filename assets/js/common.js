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

/** Jumlah hari dalam bulan "YYYY-MM" */
function jumlahHariBulan(bulan) {
  const [y, m] = bulan.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** "2026-11" → "November 2026" */
function namaBulan(bulan) {
  const [y, m] = bulan.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, 1)));
}

/** Geser bulan "YYYY-MM" sebanyak n bulan (boleh negatif) */
function geserBulan(bulan, n) {
  const [y, m] = bulan.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
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
 * BUKU KAS (format mengikuti buku kas kertas cluster):
 *  1. Iuran warga: NO | Nama | Januari..Desember | Total
 *  2. Pengeluaran uang kas per bulan
 * ------------------------------------------------------------------- */
const NAMA_BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

const _angka = new Intl.NumberFormat("id-ID");
function formatAngka(n) { return _angka.format(Number(n) || 0); }

/**
 * Bulan iuran (1–12) dari sebuah transaksi pada tahun tertentu; null bila
 * bukan iuran. Iuran = pemasukan yang punya nomor_rumah. Bulannya diambil
 * dari periode_iuran (bulan yang dibayar), atau tanggal bila periode kosong.
 */
function bulanIuran(r, tahun) {
  if (r.tipe !== "masuk" || !r.nomor_rumah) return null;
  const p = String(r.periode_iuran || r.tanggal).slice(0, 7); // "YYYY-MM"
  return p.slice(0, 4) === String(tahun) ? Number(p.slice(5, 7)) : null;
}

/** Isi <select> tahun dari data transaksi (+ tahun berjalan), pertahankan pilihan */
function isiPilihanTahun(selectId, transaksi) {
  const sel = document.getElementById(selectId);
  const sekarang = Number(todayWIB().slice(0, 4));
  const daftar = new Set([sekarang]);
  transaksi.forEach((r) => daftar.add(Number(String(r.periode_iuran || r.tanggal).slice(0, 4))));
  const dipilih = Number(sel.value) || sekarang;
  sel.innerHTML = [...daftar].sort((a, b) => b - a)
    .map((t) => `<option value="${t}" ${t === dipilih ? "selected" : ""}>${t}</option>`).join("");
}

/**
 * HTML tabel iuran warga per bulan.
 * warga: [{nomor_rumah, nama, aktif}] (urutan = kolom NO)
 * opsi.admin: sel bisa diklik (atribut data-sel="RUMAH|BULAN") & bulan lewat
 *             yang belum bayar diberi warna merah muda.
 */
function htmlMatriksIuran(warga, transaksi, tahun, opsi = {}) {
  // peta[rumah][bulan] = total dibayar
  const peta = {};
  for (const r of transaksi) {
    const b = bulanIuran(r, tahun);
    if (!b) continue;
    const baris = (peta[r.nomor_rumah] ||= {});
    baris[b] = (baris[b] || 0) + Number(r.jumlah);
  }

  // Baris = warga aktif + warga nonaktif/tak terdaftar yang punya pembayaran di tahun ini
  const daftar = warga.filter((w) => w.aktif || peta[w.nomor_rumah]);
  const dikenal = new Set(warga.map((w) => w.nomor_rumah));
  Object.keys(peta).filter((k) => !dikenal.has(k)).sort()
    .forEach((k) => daftar.push({ nomor_rumah: k, nama: "(tidak terdaftar)" }));

  const [thIni, blnIni] = todayWIB().split("-").map(Number);
  const totalBulan = Array(13).fill(0);
  let totalSemua = 0;

  const kepala = `
    <thead class="bg-brand-800 text-white text-xs">
      <tr>
        <th class="sticky left-0 z-10 bg-brand-800 w-10 min-w-[2.5rem] px-2 py-2 font-medium">No</th>
        <th class="sticky left-10 z-10 bg-brand-800 min-w-[10rem] px-3 py-2 font-medium text-left">Nama</th>
        ${NAMA_BULAN.map((b, i) => `<th class="px-2 py-2 font-medium min-w-[4.5rem] ${tahun === thIni && i + 1 === blnIni ? "bg-brand-600" : ""}">${b}</th>`).join("")}
        <th class="px-3 py-2 font-medium text-right min-w-[5.5rem]">Total</th>
      </tr>
    </thead>`;

  const isi = daftar.map((w, idx) => {
    let totalRumah = 0;
    const sel = NAMA_BULAN.map((_, i) => {
      const b = i + 1;
      const v = peta[w.nomor_rumah]?.[b] || 0;
      totalRumah += v;
      totalBulan[b] += v;
      const lewat = tahun < thIni || (tahun === thIni && b < blnIni);
      const warna = v ? "bg-emerald-50 text-emerald-800 font-medium" : (opsi.admin && lewat ? "bg-rose-50" : "");
      const klik = opsi.admin
        ? `data-sel="${escapeHtml(w.nomor_rumah)}|${b}" title="Klik untuk input/ubah" `
        : "";
      const gayaKlik = opsi.admin ? "cursor-pointer hover:ring-2 hover:ring-inset hover:ring-brand-400" : "";
      const teks = v ? formatAngka(v) : (opsi.admin ? `<span class="text-stone-300">+</span>` : "");
      return `<td ${klik}class="px-2 py-2 text-center whitespace-nowrap border-l border-stone-100 ${warna} ${gayaKlik}">${teks}</td>`;
    }).join("");
    totalSemua += totalRumah;
    return `
      <tr class="border-t border-stone-100">
        <td class="sticky left-0 bg-white px-2 py-2 text-center text-stone-500">${idx + 1}</td>
        <td class="sticky left-10 bg-white px-3 py-2 whitespace-nowrap"
            ${opsi.admin ? `data-pilih-rumah="${escapeHtml(w.nomor_rumah)}" title="Klik untuk bayar iuran sekaligus"` : ""}>
          <span class="font-medium ${opsi.admin ? "cursor-pointer hover:text-brand-700 hover:underline" : ""}">${escapeHtml(w.nama)}</span>
          <span class="ml-1 text-xs font-semibold text-brand-600">${escapeHtml(w.nomor_rumah)}</span>
        </td>
        ${sel}
        <td class="px-3 py-2 text-right font-semibold whitespace-nowrap border-l border-stone-200">${formatAngka(totalRumah)}</td>
      </tr>`;
  }).join("");

  const kaki = `
    <tfoot class="bg-stone-100 font-semibold text-xs">
      <tr class="border-t-2 border-stone-300">
        <td class="sticky left-0 bg-stone-100"></td>
        <td class="sticky left-10 bg-stone-100 px-3 py-2">Total per bulan</td>
        ${NAMA_BULAN.map((_, i) => `<td class="px-2 py-2 text-center whitespace-nowrap">${totalBulan[i + 1] ? formatAngka(totalBulan[i + 1]) : "-"}</td>`).join("")}
        <td class="px-3 py-2 text-right whitespace-nowrap text-emerald-700">${formatRupiah(totalSemua)}</td>
      </tr>
    </tfoot>`;

  const kosong = `<tr><td colspan="15" class="px-4 py-6 text-center text-stone-400">Belum ada data warga.</td></tr>`;
  return `<table class="w-full text-sm">${kepala}<tbody>${daftar.length ? isi : kosong}</tbody>${daftar.length ? kaki : ""}</table>`;
}

/**
 * HTML tabel pengeluaran uang kas per bulan (Januari–Desember).
 * opsi.admin: tampilkan tombol hapus (data-hapus-kas) per item.
 */
function htmlPengeluaran(transaksi, tahun, opsi = {}) {
  const perBulan = NAMA_BULAN.map(() => []);
  transaksi
    .filter((r) => r.tipe === "keluar" && String(r.tanggal).startsWith(`${tahun}-`))
    .sort((a, b) => (a.tanggal < b.tanggal ? -1 : 1))
    .forEach((r) => perBulan[Number(r.tanggal.slice(5, 7)) - 1].push(r));

  let total = 0;
  const isi = NAMA_BULAN.map((nama, i) => {
    const item = perBulan[i];
    const sub = item.reduce((s, r) => s + Number(r.jumlah), 0);
    total += sub;
    const ket = item.length
      ? item.map((r) => `
          <div class="flex items-start justify-between gap-3 py-0.5">
            <span>${escapeHtml(r.keterangan)} <span class="text-xs text-stone-400">(${formatTanggal(r.tanggal, { day: "numeric", month: "short" })})</span></span>
            <span class="whitespace-nowrap text-stone-600">${formatRupiah(r.jumlah)}${opsi.admin
              ? ` <button data-hapus-kas="${r.id}" class="ml-1 text-rose-400 hover:text-rose-700" title="Hapus"><i class="fa-solid fa-trash text-xs"></i></button>` : ""}</span>
          </div>`).join("")
      : `<span class="text-stone-300">—</span>`;
    return `
      <tr class="border-t border-stone-100 align-top">
        <td class="px-3 py-2 text-center text-stone-500">${i + 1}</td>
        <td class="px-3 py-2 font-medium whitespace-nowrap">${nama}</td>
        <td class="px-3 py-2">${ket}</td>
        <td class="px-3 py-2 text-right font-semibold whitespace-nowrap text-rose-700">${sub ? formatRupiah(sub) : ""}</td>
      </tr>`;
  }).join("");

  return `
    <table class="w-full text-sm min-w-[560px]">
      <thead class="bg-stone-50 text-stone-500 text-left text-xs">
        <tr>
          <th class="px-3 py-2 font-medium w-12 text-center">No</th>
          <th class="px-3 py-2 font-medium w-28">Bulan</th>
          <th class="px-3 py-2 font-medium">Keterangan</th>
          <th class="px-3 py-2 font-medium text-right w-36">Jumlah</th>
        </tr>
      </thead>
      <tbody>${isi}</tbody>
      <tfoot class="bg-stone-100 font-semibold">
        <tr class="border-t-2 border-stone-300">
          <td colspan="3" class="px-3 py-2 text-right">Total pengeluaran ${tahun}</td>
          <td class="px-3 py-2 text-right whitespace-nowrap text-rose-700">${formatRupiah(total)}</td>
        </tr>
      </tfoot>
    </table>`;
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
