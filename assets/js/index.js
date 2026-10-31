/* =====================================================================
 * index.js — Logika halaman warga (publik, tanpa login)
 *  1. Dashboard: pengumuman realtime + pengumuman otomatis "piket hari ini"
 *  2. Jadwal piket pekanan (realtime)
 *  3. Pendaftaran notifikasi OneSignal + tag "nomor_rumah"
 *  5. Ringkasan & riwayat uang kas (realtime)
 * ===================================================================== */

const KUNCI_RUMAH_LOKAL = "portal_nomor_rumah"; // simpan nomor rumah di perangkat ini
let bulanTampil = todayWIB().slice(0, 7);        // bulan jadwal yang sedang ditampilkan ("YYYY-MM")

/* ---------------------------------------------------------------------
 * 1. DASHBOARD
 * ------------------------------------------------------------------- */
function isiInfoStatis() {
  document.getElementById("alamat-cluster").textContent = CFG.ALAMAT_CLUSTER;
  document.getElementById("hari-ini").textContent = formatTanggal(todayWIB());
}

const GAYA_KATEGORI = {
  umum:     "bg-sky-50 text-sky-700",
  keamanan: "bg-amber-50 text-amber-700",
  penting:  "bg-rose-50 text-rose-700",
};
// Label status keamanan (opsional) pada pengumuman kategori "keamanan"
const GAYA_KEAMANAN = {
  aman:    "bg-emerald-100 text-emerald-700",
  waspada: "bg-amber-100 text-amber-800",
  siaga:   "bg-rose-100 text-rose-700",
};

/** Ambil pengumuman aktif dari pengurus */
async function muatPengumuman() {
  const { data, error } = await sb
    .from("tabel_pengumuman")
    .select("*")
    .eq("aktif", true)
    .order("created_at", { ascending: false })
    .limit(30);

  const wadah = document.getElementById("daftar-pengumuman");
  if (error) {
    wadah.innerHTML = `<p class="text-sm text-rose-600">Gagal memuat pengumuman: ${escapeHtml(error.message)}</p>`;
    return;
  }

  if (data.length === 0) {
    wadah.innerHTML = `<p class="text-sm text-stone-400">Belum ada pengumuman lain.</p>`;
    return;
  }
  wadah.innerHTML = data.map((p) => `
    <article class="p-4 rounded-xl border border-stone-100 hover:border-brand-200 transition">
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="px-2 py-0.5 rounded-full font-medium capitalize ${GAYA_KATEGORI[p.kategori] || ""}">${escapeHtml(p.kategori)}</span>
        ${p.status_keamanan ? `<span class="px-2 py-0.5 rounded-full font-medium capitalize ${GAYA_KEAMANAN[p.status_keamanan] || ""}">${escapeHtml(p.status_keamanan)}</span>` : ""}
        <span class="text-stone-400">${formatWaktu(p.created_at)}</span>
      </div>
      <h3 class="font-semibold mt-2">${escapeHtml(p.judul)}</h3>
      <p class="text-sm text-stone-600 mt-1 whitespace-pre-line">${escapeHtml(p.isi)}</p>
    </article>`).join("");
}

/* ---------------------------------------------------------------------
 * 2. JADWAL PIKET
 * ------------------------------------------------------------------- */
async function muatJadwal() {
  const awal = `${bulanTampil}-01`;
  const akhir = `${bulanTampil}-${String(jumlahHariBulan(bulanTampil)).padStart(2, "0")}`;
  document.getElementById("label-bulan").textContent = namaBulan(bulanTampil);

  // Jadwal + status bukti sebulan (status lewat RPC publik, tanpa foto; gagal → jadwal saja)
  const [{ data, error }, { data: status }] = await Promise.all([
    sb.from("jadwal_piket")
      .select("tanggal, hari, nomor_rumah, nama_warga")
      .gte("tanggal", awal).lte("tanggal", akhir)
      .order("tanggal"),
    sb.rpc("status_piket", { p_dari: awal, p_sampai: akhir }),
  ]);

  const grid = document.getElementById("grid-jadwal");
  if (error) {
    grid.innerHTML = `<p class="col-span-7 text-sm text-rose-600">Gagal memuat jadwal: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const hariIni = todayWIB();
  const peta = Object.fromEntries(data.map((j) => [j.tanggal, j]));
  const petaStatus = Object.fromEntries((status || []).map((s) => [s.tanggal, s]));

  // Kepala kolom hari + sel kosong sebelum tanggal 1
  const kepala = NAMA_HARI.map((h, i) =>
    `<div class="text-center text-[11px] sm:text-xs font-semibold py-1 ${i >= 5 ? "text-rose-500" : "text-stone-500"}">${h.slice(0, 3)}</div>`).join("");
  const offset = `<div></div>`.repeat(indeksHariSenin(awal));

  let sel = "";
  for (let d = 1; d <= jumlahHariBulan(bulanTampil); d++) {
    const tgl = `${bulanTampil}-${String(d).padStart(2, "0")}`;
    const j = peta[tgl];
    const aktif = tgl === hariIni;
    const ikon = j ? ikonStatusPiket(j, petaStatus[tgl], tgl, hariIni, !!status) : "";
    sel += `
      <div class="min-w-0 rounded-lg sm:rounded-xl border p-1.5 sm:p-2 min-h-[4.25rem] sm:min-h-[5.5rem] ${
        aktif ? "border-brand-500 bg-brand-50 ring-2 ring-brand-200" : j ? "border-stone-200" : "border-stone-100 bg-stone-50"}"
        ${j ? `title="${escapeHtml(`${formatTanggal(tgl)} — Rumah ${j.nomor_rumah} · ${j.nama_warga}`)}"` : ""}>
        <div class="flex items-start justify-between gap-1">
          <span class="text-[11px] sm:text-xs ${aktif ? "font-bold text-brand-700" : "text-stone-400"}">${d}</span>
          ${ikon}
        </div>
        ${j ? `
          <p class="mt-1 text-xs sm:text-base font-bold text-brand-800 truncate">${escapeHtml(j.nomor_rumah)}</p>
          <p class="hidden sm:block text-xs text-stone-600 truncate">${escapeHtml(j.nama_warga)}</p>` : ""}
        ${aktif ? `<p class="hidden sm:block text-[10px] font-semibold uppercase text-brand-600 mt-0.5">Hari ini</p>` : ""}
      </div>`;
  }
  grid.innerHTML = data.length
    ? kepala + offset + sel
    : kepala + offset + sel + `<p class="col-span-7 mt-2 text-sm text-stone-400 italic">Jadwal bulan ${namaBulan(bulanTampil)} belum diterbitkan.</p>`;

  // Pengumuman otomatis "piket hari ini" (selalu berdasarkan hari ini)
  muatPiketHariIni();
}

/** Ikon status kecil untuk sel kalender (detail di tooltip) */
function ikonStatusPiket(jadwal, status, tgl, hariIni, adaData) {
  if (!adaData || tgl > hariIni) return "";
  const ikon = (faIkon, warna, judul, teksMd = "") =>
    `<span class="text-[11px] sm:text-xs whitespace-nowrap ${warna}" title="${escapeHtml(judul)}"><i class="fa-solid ${faIkon}"></i>${teksMd ? `<span class="hidden md:inline ml-0.5">${escapeHtml(teksMd)}</span>` : ""}</span>`;
  if (status && status.diunggah_oleh !== jadwal.nomor_rumah) {
    return ikon("fa-people-arrows", "text-amber-600", `Dikunci pengganti: Rumah ${status.diunggah_oleh}`, status.diunggah_oleh);
  }
  if (status) return ikon("fa-lock", "text-emerald-600", "Terkunci, bukti foto sudah diunggah");
  if (tgl === hariIni) return ikon("fa-hourglass-half", "text-stone-500", "Menunggu bukti foto");
  return ikon("fa-circle-xmark", "text-rose-600", "Tanpa bukti foto");
}

/**
 * Badge status kunci gerbang untuk satu hari jadwal:
 *  ✅ Terkunci (petugas sendiri) · 🔁 Dikunci pengganti · ❌ Tanpa bukti · ⏳ Menunggu (hari ini)
 */
function badgeStatusPiket(jadwal, status, tgl, hariIni, adaData) {
  if (!adaData || tgl > hariIni) return "";
  const jam = status ? new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(status.waktu_upload)) : "";
  const badge = (warna, ikon, teks) =>
    `<p class="mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${warna}"><i class="fa-solid ${ikon}"></i>${teks}</p>`;

  if (status && status.diunggah_oleh !== jadwal.nomor_rumah) {
    return badge("bg-amber-100 text-amber-800", "fa-people-arrows", `Dikunci ${escapeHtml(status.diunggah_oleh)} · ${jam}`);
  }
  if (status) return badge("bg-emerald-100 text-emerald-700", "fa-lock", `Terkunci · ${jam}`);
  if (tgl === hariIni) return badge("bg-stone-100 text-stone-600", "fa-hourglass-half", "Menunggu bukti");
  return badge("bg-rose-100 text-rose-700", "fa-circle-xmark", "Tanpa bukti");
}

/**
 * Pengumuman otomatis "Piket Kunci Gerbang Hari Ini", disematkan di atas
 * daftar pengumuman. Isinya selalu dihitung dari jadwal_piket tanggal hari ini
 * (WIB) + status bukti, jadi tidak perlu diketik pengurus.
 */
async function muatPiketHariIni() {
  const hariIni = todayWIB();
  const [{ data: piket }, { data: status }] = await Promise.all([
    sb.from("jadwal_piket").select("nomor_rumah, nama_warga").eq("tanggal", hariIni).maybeSingle(),
    sb.rpc("status_piket", { p_dari: hariIni, p_sampai: hariIni }),
  ]);
  const wadah = document.getElementById("pengumuman-piket");

  if (!piket) {
    wadah.innerHTML = `
      <article class="p-4 rounded-xl border border-stone-200 bg-stone-50">
        <p class="text-xs font-medium text-stone-500"><i class="fa-solid fa-thumbtack mr-1"></i>Otomatis · ${formatTanggal(hariIni)}</p>
        <h3 class="font-semibold mt-2">Piket Kunci Gerbang Hari Ini</h3>
        <p class="text-sm text-stone-500 mt-1">Belum ada jadwal piket untuk hari ini.</p>
      </article>`;
    return;
  }

  wadah.innerHTML = `
    <article class="p-4 rounded-xl border-2 border-brand-300 bg-brand-50">
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="px-2 py-0.5 rounded-full font-medium bg-brand-700 text-white"><i class="fa-solid fa-thumbtack mr-1"></i>Piket hari ini</span>
        <span class="text-stone-500">${formatTanggal(hariIni)}</span>
      </div>
      <div class="mt-3 flex items-start gap-3">
        <span class="w-11 h-11 shrink-0 rounded-xl grid place-items-center bg-brand-700 text-white text-lg"><i class="fa-solid fa-key"></i></span>
        <div class="min-w-0 flex-1">
          <h3 class="font-bold text-lg text-brand-900">Rumah ${escapeHtml(piket.nomor_rumah)} · ${escapeHtml(piket.nama_warga)}</h3>
          <p class="text-sm text-stone-600">Bertugas mengunci gerbang pukul <b>${escapeHtml(CFG.JAM_TUTUP)} WIB</b> dan mengunggah foto bukti.</p>
          <div class="mt-2 flex flex-wrap items-center gap-3">
            ${badgeStatusPiket({ ...piket, tanggal: hariIni }, status?.[0], hariIni, hariIni, !!status)}
            <a href="upload.html" class="mt-2 text-sm font-semibold text-brand-700 hover:underline"><i class="fa-solid fa-camera mr-1"></i>Upload bukti</a>
          </div>
        </div>
      </div>
    </article>`;
}

/* ---------------------------------------------------------------------
 * 5. UANG KAS (rekap dihitung otomatis di JavaScript)
 * ------------------------------------------------------------------- */
let kasWarga = [];     // [{nomor_rumah, nama, aktif}] dari RPC publik
let kasTransaksi = []; // semua baris uang_kas

async function muatKas() {
  // Semua transaksi (paging agar tidak terpotong 1000 baris) + daftar warga untuk kolom Nama
  const [{ data: semua, error }, { data: warga }] = await Promise.all([
    ambilSemua(() => sb.from("uang_kas").select("*").order("id")),
    sb.rpc("daftar_warga_publik"),
  ]);
  if (error) {
    const pesan = `Gagal memuat kas: ${escapeHtml(error.message)}`;
    document.getElementById("tabel-kas").innerHTML =
      `<tr><td colspan="4" class="px-5 py-6 text-center text-rose-600">${pesan}</td></tr>`;
    document.getElementById("matriks-iuran").innerHTML = `<p class="px-5 py-6 text-sm text-rose-600">${pesan}</p>`;
    return;
  }
  kasTransaksi = semua;
  kasWarga = warga || [];

  // Ringkasan sepanjang waktu (saldo kas bersifat kumulatif)
  const { masuk, keluar, saldo } = hitungRingkasanKas(semua);
  document.getElementById("kas-masuk").textContent = formatRupiah(masuk);
  document.getElementById("kas-keluar").textContent = formatRupiah(keluar);
  document.getElementById("kas-saldo").textContent = formatRupiah(saldo);

  isiPilihanTahun("kas-tahun", semua);
  renderBukuKas();

  // Riwayat terkini: 20 transaksi terbaru
  const riwayat = [...semua]
    .sort((a, b) => (a.tanggal === b.tanggal ? b.id - a.id : a.tanggal < b.tanggal ? 1 : -1))
    .slice(0, 20);

  const tbody = document.getElementById("tabel-kas");
  if (!riwayat?.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="px-5 py-6 text-center text-stone-400">Belum ada transaksi.</td></tr>`;
    return;
  }
  tbody.innerHTML = riwayat.map((r) => {
    const masukTx = r.tipe === "masuk";
    return `
      <tr class="hover:bg-stone-50">
        <td class="px-4 sm:px-5 py-3 whitespace-nowrap text-stone-500">${formatTanggal(r.tanggal, { day: "numeric", month: "short", year: "numeric" })}</td>
        <td class="px-4 sm:px-5 py-3 font-semibold text-brand-800">${r.nomor_rumah ? escapeHtml(r.nomor_rumah) : `<span class="text-stone-300">—</span>`}</td>
        <td class="px-4 sm:px-5 py-3">${escapeHtml(r.keterangan)}</td>
        <td class="px-4 sm:px-5 py-3 text-right font-semibold whitespace-nowrap ${masukTx ? "text-emerald-700" : "text-rose-700"}">
          ${masukTx ? "+" : "−"} ${formatRupiah(r.jumlah)}
        </td>
      </tr>`;
  }).join("");
}

/** Gambar tabel iuran & pengeluaran untuk tahun yang dipilih */
function renderBukuKas() {
  const tahun = Number(document.getElementById("kas-tahun").value);
  document.querySelectorAll(".label-tahun").forEach((el) => (el.textContent = tahun));
  document.querySelectorAll(".label-iuran").forEach((el) => (el.textContent = formatRupiah(CFG.IURAN_BULANAN || 25000)));
  document.getElementById("matriks-iuran").innerHTML = htmlMatriksIuran(kasWarga, kasTransaksi, tahun);
  document.getElementById("tabel-pengeluaran").innerHTML = htmlPengeluaran(kasTransaksi, tahun);
}

document.getElementById("kas-tahun").addEventListener("change", renderBukuKas);

/* ---------------------------------------------------------------------
 * REALTIME: dengarkan perubahan tabel & muat ulang bagian terkait
 * (tabel harus terdaftar di publication supabase_realtime — lihat schema.sql)
 * ------------------------------------------------------------------- */
function langgananRealtime() {
  sb.channel("portal-warga")
    .on("postgres_changes", { event: "*", schema: "public", table: "tabel_pengumuman" }, muatPengumuman)
    .on("postgres_changes", { event: "*", schema: "public", table: "jadwal_piket" }, muatJadwal)
    .on("postgres_changes", { event: "*", schema: "public", table: "uang_kas" }, muatKas)
    .subscribe();
}

/* ---------------------------------------------------------------------
 * 3. NOTIFIKASI WEB PUSH (OneSignal Web SDK v16)
 *
 * Alur: klik "Aktifkan" → izin browser "Allow" → isi Nomor Rumah → tag.
 * Tag "nomor_rumah" dipasang pada langganan perangkat ini. Bila satu rumah
 * mendaftarkan 2+ HP, setiap HP memasang tag dengan nilai yang SAMA
 * (sudah dinormalisasi), sehingga filter tag nomor_rumah=A12 menjangkau
 * semua HP rumah tersebut.
 * ------------------------------------------------------------------- */
window.OneSignalDeferred = window.OneSignalDeferred || [];

// Path dasar situs. Di GitHub Pages project site: "/nama-repo/"
const BASE_PATH = location.pathname.replace(/[^/]*$/, "");

OneSignalDeferred.push(async (OneSignal) => {
  try {
    await OneSignal.init({
      appId: CFG.ONESIGNAL_APP_ID,
      // Service worker berada di root repo; path & scope disesuaikan agar
      // berjalan baik di user.github.io/nama-repo/ maupun domain sendiri.
      serviceWorkerPath: BASE_PATH.replace(/^\//, "") + "OneSignalSDKWorker.js",
      serviceWorkerParam: { scope: BASE_PATH },
      allowLocalhostAsSecureOrigin: true, // untuk uji coba di localhost
    });
    window._oneSignalSiap = true;

    // Bila izin berubah (mis. user klik Allow dari prompt browser)
    OneSignal.Notifications.addEventListener("permissionChange", (diizinkan) => {
      if (diizinkan) tampilkanLangkahNotif();
    });
    tampilkanLangkahNotif();
  } catch (e) {
    console.error("OneSignal init gagal:", e);
    tampilkanPesanNotif("Notifikasi belum dapat diaktifkan (konfigurasi OneSignal belum benar).");
  }
});

function tampilkanPesanNotif(pesan) {
  ["notif-langkah-izin", "notif-langkah-rumah", "notif-terdaftar"].forEach((id) => tampil(id, false));
  const el = document.getElementById("notif-tidak-didukung");
  el.textContent = pesan;
  tampil("notif-tidak-didukung", true);
}

/** Tentukan langkah mana yang ditampilkan berdasarkan izin & data lokal */
function tampilkanLangkahNotif() {
  OneSignalDeferred.push((OneSignal) => {
    if (!OneSignal.Notifications.isPushSupported()) {
      tampilkanPesanNotif("Browser ini tidak mendukung notifikasi push. Di iPhone, tambahkan situs ke Layar Utama terlebih dahulu.");
      return;
    }
    if (Notification.permission === "denied") {
      tampilkanPesanNotif("Notifikasi diblokir. Izinkan dari pengaturan situs di browser Anda.");
      return;
    }

    const izin = OneSignal.Notifications.permission;
    const rumah = localStorage.getItem(KUNCI_RUMAH_LOKAL);
    tampil("notif-tidak-didukung", false);
    tampil("notif-langkah-izin", !izin);
    tampil("notif-langkah-rumah", izin && !rumah);
    tampil("notif-terdaftar", izin && !!rumah);
    if (rumah) document.getElementById("label-rumah-terdaftar").textContent = rumah;
  });
}

/**
 * Pasang tag nomor_rumah pada perangkat ini.
 * Catatan versi SDK: di SDK v15 namanya OneSignal.sendTag("nomor_rumah", x);
 * di SDK v16 (yang dipakai di sini) padanannya OneSignal.User.addTag(...).
 */
async function sendTagNomorRumah(OneSignal, nomorRumah) {
  if (typeof OneSignal.User?.addTag === "function") {
    OneSignal.User.addTag("nomor_rumah", nomorRumah);   // v16
  } else {
    await OneSignal.sendTag("nomor_rumah", nomorRumah); // v15 (fallback)
  }
}

document.getElementById("btn-aktifkan-notif").addEventListener("click", () => {
  if (!window._oneSignalSiap) {
    toast("Layanan notifikasi masih dimuat, coba sesaat lagi.", "info");
    return;
  }
  OneSignalDeferred.push(async (OneSignal) => {
    await OneSignal.Notifications.requestPermission(); // memunculkan dialog "Allow"
    tampilkanLangkahNotif();
  });
});

document.getElementById("notif-langkah-rumah").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("input-rumah-notif");
  const nomor = normalisasiNomorRumah(input.value);
  if (!nomor) return toast("Nomor rumah tidak valid.", "error");

  const btn = e.submitter || e.target.querySelector("button");
  const pulihkan = tombolLoading(btn, "");
  try {
    // Validasi ke database agar tidak salah ketik (RPC aman, hanya balas true/false)
    const { data: ada, error } = await sb.rpc("rumah_terdaftar", { p_nomor: nomor });
    if (error) throw error;
    if (!ada) {
      toast(`Rumah ${nomor} belum terdaftar. Hubungi pengurus.`, "error");
      return;
    }
    OneSignalDeferred.push(async (OneSignal) => {
      await sendTagNomorRumah(OneSignal, nomor);
      localStorage.setItem(KUNCI_RUMAH_LOKAL, nomor);
      toast(`Notifikasi aktif untuk rumah ${nomor}.`, "sukses");
      tampilkanLangkahNotif();
    });
  } catch (err) {
    toast("Gagal menyimpan: " + err.message, "error");
  } finally {
    pulihkan();
  }
});

document.getElementById("btn-ubah-rumah").addEventListener("click", () => {
  localStorage.removeItem(KUNCI_RUMAH_LOKAL);
  document.getElementById("input-rumah-notif").value = "";
  tampilkanLangkahNotif();
});

/* ---------------------------------------------------------------------
 * INISIALISASI
 * ------------------------------------------------------------------- */
document.getElementById("btn-bulan-sebelum").addEventListener("click", () => {
  bulanTampil = geserBulan(bulanTampil, -1);
  muatJadwal();
});
document.getElementById("btn-bulan-sesudah").addEventListener("click", () => {
  bulanTampil = geserBulan(bulanTampil, 1);
  muatJadwal();
});
document.getElementById("btn-bulan-ini").addEventListener("click", () => {
  bulanTampil = todayWIB().slice(0, 7);
  muatJadwal();
});

isiInfoStatis();
// Muat ulang pengumuman piket saat tanggal berganti (halaman dibiarkan terbuka lewat tengah malam)
let tanggalTampil = todayWIB();
setInterval(() => {
  if (todayWIB() !== tanggalTampil) {
    tanggalTampil = todayWIB();
    isiInfoStatis();
    muatJadwal(); // ikut memanggil muatPiketHariIni()
  }
}, 60 * 1000);
muatPengumuman();
muatJadwal();
muatKas();
langgananRealtime();
