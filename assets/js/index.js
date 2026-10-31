/* =====================================================================
 * index.js — Logika halaman warga (publik, tanpa login)
 *  1. Dashboard: jam & status gerbang, status keamanan, pengumuman realtime
 *  2. Jadwal piket pekanan (realtime)
 *  3. Pendaftaran notifikasi OneSignal + tag "nomor_rumah"
 *  5. Ringkasan & riwayat uang kas (realtime)
 * ===================================================================== */

const KUNCI_RUMAH_LOKAL = "portal_nomor_rumah"; // simpan nomor rumah di perangkat ini
let seninTampil = seninPekanIni();               // pekan jadwal yang sedang ditampilkan

/* ---------------------------------------------------------------------
 * 1. DASHBOARD
 * ------------------------------------------------------------------- */
function isiInfoStatis() {
  document.getElementById("alamat-cluster").textContent = CFG.ALAMAT_CLUSTER;
  document.getElementById("kontak-satpam").textContent = CFG.KONTAK_SATPAM;
  document.getElementById("jam-buka").textContent = CFG.JAM_BUKA;
  document.getElementById("jam-tutup").textContent = CFG.JAM_TUTUP;
  document.getElementById("hari-ini").textContent = formatTanggal(todayWIB());
}

/** Perbarui jam & status gerbang setiap detik */
function perbaruiJamGerbang() {
  document.getElementById("jam-sekarang").textContent = nowWIB().teks + " WIB";
  const { buka } = statusGerbang();
  const ikon = document.getElementById("ikon-gerbang");
  document.getElementById("status-gerbang").textContent = buka ? "Terbuka" : "Terkunci";
  document.getElementById("status-gerbang").className = `text-xl font-bold ${buka ? "text-emerald-700" : "text-rose-700"}`;
  document.getElementById("sub-gerbang").textContent = buka
    ? `Dikunci pukul ${CFG.JAM_TUTUP} WIB`
    : `Dibuka kembali pukul ${CFG.JAM_BUKA} WIB`;
  ikon.className = `w-12 h-12 rounded-xl grid place-items-center text-xl ${buka ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`;
  ikon.innerHTML = `<i class="fa-solid ${buka ? "fa-door-open" : "fa-door-closed"}"></i>`;
}

const GAYA_KEAMANAN = {
  aman:    { label: "Aman",    warna: "bg-emerald-100 text-emerald-700", teks: "text-emerald-700", ikon: "fa-shield-halved" },
  waspada: { label: "Waspada", warna: "bg-amber-100 text-amber-700",     teks: "text-amber-700",   ikon: "fa-triangle-exclamation" },
  siaga:   { label: "Siaga",   warna: "bg-rose-100 text-rose-700",       teks: "text-rose-700",    ikon: "fa-land-mine-on" },
};
const GAYA_KATEGORI = {
  umum:     "bg-sky-50 text-sky-700",
  keamanan: "bg-amber-50 text-amber-700",
  penting:  "bg-rose-50 text-rose-700",
};

/** Ambil pengumuman aktif + turunkan status keamanan dari pengumuman 'keamanan' terbaru */
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

  // Status keamanan
  const terbaru = data.find((p) => p.kategori === "keamanan" && p.status_keamanan);
  const gaya = GAYA_KEAMANAN[terbaru?.status_keamanan] ?? null;
  const ikonK = document.getElementById("ikon-keamanan");
  if (gaya) {
    document.getElementById("status-keamanan").textContent = gaya.label;
    document.getElementById("status-keamanan").className = `text-xl font-bold ${gaya.teks}`;
    document.getElementById("sub-keamanan").textContent = terbaru.judul;
    ikonK.className = `w-12 h-12 rounded-xl grid place-items-center text-xl ${gaya.warna}`;
    ikonK.innerHTML = `<i class="fa-solid ${gaya.ikon}"></i>`;
  } else {
    document.getElementById("status-keamanan").textContent = "Belum ada info";
    document.getElementById("sub-keamanan").textContent = "-";
  }

  // Daftar pengumuman
  if (data.length === 0) {
    wadah.innerHTML = `<p class="text-sm text-stone-400">Belum ada pengumuman.</p>`;
    return;
  }
  wadah.innerHTML = data.map((p) => `
    <article class="p-4 rounded-xl border border-stone-100 hover:border-brand-200 transition">
      <div class="flex items-center gap-2 text-xs">
        <span class="px-2 py-0.5 rounded-full font-medium capitalize ${GAYA_KATEGORI[p.kategori] || ""}">${escapeHtml(p.kategori)}</span>
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
  const minggu = tambahHari(seninTampil, 6);
  document.getElementById("label-pekan").textContent =
    `${formatTanggal(seninTampil, { day: "numeric", month: "short" })} – ${formatTanggal(minggu, { day: "numeric", month: "short", year: "numeric" })}`;

  const { data, error } = await sb
    .from("jadwal_piket")
    .select("tanggal, hari, nomor_rumah, nama_warga")
    .gte("tanggal", seninTampil)
    .lte("tanggal", minggu)
    .order("tanggal");

  const grid = document.getElementById("grid-jadwal");
  if (error) {
    grid.innerHTML = `<p class="text-sm text-rose-600">Gagal memuat jadwal: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const hariIni = todayWIB();
  const peta = Object.fromEntries(data.map((j) => [j.tanggal, j]));

  grid.innerHTML = NAMA_HARI.map((hari, i) => {
    const tgl = tambahHari(seninTampil, i);
    const j = peta[tgl];
    const aktif = tgl === hariIni;
    return `
      <div class="rounded-xl p-4 border ${aktif ? "border-brand-500 bg-brand-50 ring-2 ring-brand-200" : "border-stone-200"}">
        <div class="flex items-center justify-between lg:block">
          <p class="text-xs font-semibold uppercase tracking-wide ${aktif ? "text-brand-700" : "text-stone-400"}">${hari}${aktif ? " · Hari ini" : ""}</p>
          <p class="text-xs text-stone-400 lg:mt-0.5">${formatTanggal(tgl, { day: "numeric", month: "short" })}</p>
        </div>
        ${j ? `
          <p class="mt-2 text-lg font-bold text-brand-800"><i class="fa-solid fa-house mr-1 text-sm text-brand-400"></i>${escapeHtml(j.nomor_rumah)}</p>
          <p class="text-sm text-stone-600 truncate">${escapeHtml(j.nama_warga)}</p>`
        : `<p class="mt-2 text-sm text-stone-400 italic">Belum dijadwalkan</p>`}
      </div>`;
  }).join("");

  // Kartu "Piket hari ini" di dashboard (selalu berdasarkan hari ini)
  muatPiketHariIni();
}

async function muatPiketHariIni() {
  const { data } = await sb
    .from("jadwal_piket")
    .select("nomor_rumah, nama_warga")
    .eq("tanggal", todayWIB())
    .maybeSingle();
  document.getElementById("piket-hari-ini").textContent = data ? `Rumah ${data.nomor_rumah}` : "Belum ada";
  document.getElementById("sub-piket").textContent = data ? data.nama_warga : "Jadwal belum diterbitkan";
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
document.getElementById("btn-pekan-sebelum").addEventListener("click", () => {
  seninTampil = tambahHari(seninTampil, -7);
  muatJadwal();
});
document.getElementById("btn-pekan-sesudah").addEventListener("click", () => {
  seninTampil = tambahHari(seninTampil, 7);
  muatJadwal();
});

isiInfoStatis();
perbaruiJamGerbang();
setInterval(perbaruiJamGerbang, 1000);
muatPengumuman();
muatJadwal();
muatKas();
langgananRealtime();
