/* =====================================================================
 * admin.js — Panel Pengurus (login Supabase Auth email + password)
 *  - Generator jadwal piket (acak Senin–Minggu) → tabel jadwal_piket
 *  - Broadcast OneSignal via Edge Function "kirim-notifikasi"
 *  - Input & riwayat uang kas (bendahara)
 *  - Kelola pengumuman / status keamanan
 *  - Kelola data warga
 *  - Lihat bukti foto (signed URL dari bucket privat)
 *
 * Catatan keamanan: menyembunyikan UI bukan pengaman. Pengaman sebenarnya
 * adalah RLS + fungsi is_admin() di database (lihat supabase/schema.sql).
 * ===================================================================== */

let jadwalDraf = []; // hasil acak yang belum disimpan

/* =====================================================================
 * AUTENTIKASI
 * =================================================================== */
async function cekSesi() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return tampilLogin();

  // Pastikan akun ini terdaftar sebagai pengurus (tabel admins)
  const { data: admin, error } = await sb.rpc("is_admin");
  if (error || !admin) {
    toast("Akun ini bukan pengurus. Hubungi ketua pengurus.", "error");
    await sb.auth.signOut();
    return tampilLogin();
  }

  document.getElementById("email-admin").textContent = session.user.email;
  tampil("layar-login", false);
  tampil("layar-admin", true);
  bukaTab(localStorage.getItem("admin_tab") || "jadwal");
}

function tampilLogin() {
  tampil("layar-admin", false);
  tampil("layar-login", true);
}

document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pulihkan = tombolLoading(e.submitter || e.target.querySelector("button"), "Masuk...");
  const { error } = await sb.auth.signInWithPassword({
    email: document.getElementById("login-email").value.trim(),
    password: document.getElementById("login-password").value,
  });
  pulihkan();
  if (error) return toast("Login gagal: " + error.message, "error");
  document.getElementById("login-password").value = "";
  cekSesi();
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  await sb.auth.signOut();
  tampilLogin();
});

/* =====================================================================
 * TAB
 * =================================================================== */
const PEMUAT_TAB = {
  jadwal: siapkanGenerator,
  kas: muatKasAdmin,
  pengumuman: muatPengumumanAdmin,
  warga: muatWarga,
  bukti: muatBukti,
};

function bukaTab(nama) {
  if (!PEMUAT_TAB[nama]) nama = "jadwal";
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${nama}`));
  document.querySelectorAll(".tab-btn").forEach((b) => {
    const aktif = b.dataset.tab === nama;
    b.classList.toggle("border-brand-700", aktif);
    b.classList.toggle("text-brand-800", aktif);
    b.classList.toggle("font-semibold", aktif);
    b.classList.toggle("border-transparent", !aktif);
    b.classList.toggle("text-stone-500", !aktif);
  });
  localStorage.setItem("admin_tab", nama);
  PEMUAT_TAB[nama]();
}

document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", () => bukaTab(b.dataset.tab)));

/* =====================================================================
 * 2. GENERATOR JADWAL PIKET
 * =================================================================== */
function siapkanGenerator() {
  const input = document.getElementById("input-bulan");
  if (!input.value) {
    // Default: bulan depan (format "YYYY-MM")
    const [y, m] = todayWIB().split("-").map(Number);
    input.value = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  }
}


/**
 * Tanggal-tanggal yang dijadwalkan pada bulan "YYYY-MM".
 * Hari ini & tanggal yang sudah lewat dilewati, agar jadwal/token hari ini
 * (yang mungkin sudah dikirim lewat notifikasi) tidak berubah.
 */
function tanggalDijadwalkan(bulan) {
  const hariIni = todayWIB();
  const hasil = [];
  for (let d = 1; d <= jumlahHariBulan(bulan); d++) {
    const tgl = `${bulan}-${String(d).padStart(2, "0")}`;
    if (tgl > hariIni) hasil.push(tgl);
  }
  return hasil;
}

/** Fisher–Yates shuffle (acak adil, tidak bias) */
function acak(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

document.getElementById("btn-acak").addEventListener("click", async (e) => {
  const bulan = document.getElementById("input-bulan").value;
  if (!bulan) return toast("Pilih bulan terlebih dahulu.", "error");

  const daftarTanggal = tanggalDijadwalkan(bulan);
  if (!daftarTanggal.length) return toast("Bulan tersebut sudah lewat. Pilih bulan lain.", "error");

  const pulihkan = tombolLoading(e.currentTarget, "Mengacak...");
  try {
    const { data: warga, error } = await sb
      .from("warga").select("nama, nomor_rumah").eq("aktif", true);
    if (error) throw error;
    if (!warga.length) return toast("Belum ada warga aktif. Tambahkan di tab Warga.", "error");

    // Hitung berapa kali tiap rumah bertugas dalam 30 hari sebelum tanggal pertama
    const awal = daftarTanggal[0];
    const { data: lalu } = await sb
      .from("jadwal_piket").select("nomor_rumah")
      .gte("tanggal", tambahHari(awal, -30)).lt("tanggal", awal);
    const hitungLalu = {};
    (lalu || []).forEach((j) => { hitungLalu[j.nomor_rumah] = (hitungLalu[j.nomor_rumah] || 0) + 1; });

    // Acak dulu, lalu urutkan (stabil) dari yang paling jarang bertugas.
    // Rumah di depan mendapat giliran lebih dulu / lebih banyak bila hari tidak habis dibagi.
    const urutan = acak(warga).sort((a, b) => (hitungLalu[a.nomor_rumah] || 0) - (hitungLalu[b.nomor_rumah] || 0));

    // Isi tanggal berurutan secara berputar: semua rumah kebagian dulu sebelum ada yang mengulang.
    jadwalDraf = daftarTanggal.map((tanggal, i) => {
      const w = urutan[i % urutan.length];
      return { tanggal, hari: NAMA_HARI[indeksHariSenin(tanggal)], nomor_rumah: w.nomor_rumah, nama_warga: w.nama };
    });

    const nHari = daftarTanggal.length;
    const nRumah = warga.length;
    const dilewati = jumlahHariBulan(bulan) - nHari;
    let info = `${namaBulan(bulan)}: ${nHari} hari untuk ${nRumah} rumah aktif — `;
    info += nRumah >= nHari
      ? `${nHari} rumah bertugas masing-masing 1 kali, ${nRumah - nHari} rumah belum kebagian (diprioritaskan bulan berikutnya).`
      : `tiap rumah bertugas ${Math.floor(nHari / nRumah)}–${Math.ceil(nHari / nRumah)} kali.`;
    if (dilewati) info += ` ${dilewati} tanggal (hari ini & sebelumnya) tidak diubah.`;
    document.getElementById("info-acak").textContent = info;
    renderPratinjauJadwal(bulan);
    document.getElementById("btn-simpan-jadwal").disabled = false;
  } catch (err) {
    toast("Gagal mengacak: " + err.message, "error");
  } finally {
    pulihkan();
  }
});

/** Pratinjau berbentuk kalender bulanan (kolom Senin–Minggu) */
function renderPratinjauJadwal(bulan) {
  const peta = Object.fromEntries(jadwalDraf.map((j) => [j.tanggal, j]));

  const kepala = NAMA_HARI.map((h) =>
    `<div class="text-center text-xs font-semibold text-stone-500 py-1">${h.slice(0, 3)}</div>`).join("");
  // Sel kosong sebelum tanggal 1 agar jatuh di kolom hari yang benar
  const offset = "<div></div>".repeat(indeksHariSenin(`${bulan}-01`));

  let isi = "";
  for (let d = 1; d <= jumlahHariBulan(bulan); d++) {
    const j = peta[`${bulan}-${String(d).padStart(2, "0")}`];
    isi += j
      ? `<div class="rounded-lg border border-brand-300 bg-brand-50 p-1.5 sm:p-2 min-h-[3.5rem] min-w-0" title="${escapeHtml(j.nama_warga)}">
           <p class="text-[10px] sm:text-xs text-stone-400">${d}</p>
           <p class="text-xs sm:text-sm font-bold text-brand-800 truncate">${escapeHtml(j.nomor_rumah)}</p>
           <p class="hidden sm:block text-xs text-stone-600 truncate">${escapeHtml(j.nama_warga)}</p>
         </div>`
      : `<div class="rounded-lg border border-stone-100 bg-stone-50 p-1.5 sm:p-2 min-h-[3.5rem]" title="Tidak diubah">
           <p class="text-[10px] sm:text-xs text-stone-300">${d}</p>
         </div>`;
  }
  document.getElementById("pratinjau-jadwal").innerHTML = kepala + offset + isi;
}

document.getElementById("btn-simpan-jadwal").addEventListener("click", async (e) => {
  if (!jadwalDraf.length) return;
  if (!confirm(`Simpan jadwal ${jadwalDraf.length} hari? Jadwal lama pada tanggal yang sama akan ditimpa.`)) return;

  const btn = e.currentTarget;
  const pulihkan = tombolLoading(btn, "Menyimpan...");
  try {
    // Upsert berdasarkan kolom unik "tanggal". Trigger DB otomatis membuat token.
    const { error } = await sb.from("jadwal_piket").upsert(jadwalDraf, { onConflict: "tanggal" });
    if (error) throw error;
    toast("Jadwal tersimpan & langsung tampil di portal warga.", "sukses");
    jadwalDraf = [];
    document.getElementById("form-broadcast").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    toast("Gagal menyimpan jadwal: " + err.message, "error");
  } finally {
    pulihkan();
    btn.disabled = true;
  }
});

/* ---------------------------------------------------------------------
 * Broadcast OneSignal (lewat Edge Function, JWT admin ikut terkirim otomatis)
 * ------------------------------------------------------------------- */
document.getElementById("form-broadcast").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!confirm("Kirim notifikasi ke SEMUA warga?")) return;

  const pulihkan = tombolLoading(e.submitter || e.target.querySelector("button"), "Mengirim...");
  try {
    const urlPortal = new URL("index.html#jadwal", location.href).href;
    const { data, error } = await sb.functions.invoke("kirim-notifikasi", {
      body: {
        judul: document.getElementById("bc-judul").value.trim(),
        pesan: document.getElementById("bc-pesan").value.trim(),
        url: urlPortal,
      },
    });
    if (error) {
      // Ambil pesan error dari body respons Edge Function bila ada
      const detail = await error.context?.json?.().catch(() => null);
      throw new Error(detail?.error || error.message);
    }
    toast(`Notifikasi terkirim (id: ${data?.hasil?.id ?? "-"}).`, "sukses");
  } catch (err) {
    toast("Gagal mengirim: " + err.message, "error");
  } finally {
    pulihkan();
  }
});

/* =====================================================================
 * 5. UANG KAS (BENDAHARA)
 * =================================================================== */
const IURAN_BULANAN = CFG.IURAN_BULANAN || 25000;
let petaWarga = {};                             // nomor_rumah → nama, untuk saran input & validasi
let kasCache = { warga: [], transaksi: [] };    // data terakhir untuk tabel iuran & modal
let selIuran = null;                            // sel yang sedang dibuka: { rumah, bulan, tahun }

/** Format "YYYY-MM-01" untuk kolom periode_iuran */
function periodeIuran(tahun, bulan) {
  return `${tahun}-${String(bulan).padStart(2, "0")}-01`;
}

async function muatKasAdmin() {
  document.getElementById("kas-tanggal").value ||= todayWIB();
  document.getElementById("bi-tanggal").value ||= todayWIB();

  const [{ data, error }, { data: warga }] = await Promise.all([
    ambilSemua(() => sb
      .from("uang_kas").select("*")
      .order("tanggal", { ascending: false }).order("id", { ascending: false })),
    sb.from("warga").select("nomor_rumah, nama, aktif").order("id"),
  ]);
  if (error) return toast("Gagal memuat kas: " + error.message, "error");

  // Saran No. Rumah pada baris input
  kasCache = { warga: warga || [], transaksi: data };
  petaWarga = Object.fromEntries(kasCache.warga.map((w) => [w.nomor_rumah, w.nama]));
  document.getElementById("daftar-rumah").innerHTML = kasCache.warga
    .map((w) => `<option value="${escapeHtml(w.nomor_rumah)}">${escapeHtml(w.nama)}</option>`).join("");

  const { masuk, keluar, saldo } = hitungRingkasanKas(data);
  document.getElementById("adm-kas-masuk").textContent = formatRupiah(masuk);
  document.getElementById("adm-kas-keluar").textContent = formatRupiah(keluar);
  document.getElementById("adm-kas-saldo").textContent = formatRupiah(saldo);

  isiPilihanTahun("adm-kas-tahun", data);
  renderBukuKasAdmin();

  // Riwayat pengeluaran (terbaru di atas)
  const pengeluaran = data.filter((r) => r.tipe === "keluar");
  document.getElementById("adm-tabel-kas").innerHTML = pengeluaran.length
    ? pengeluaran.map((r) => `
      <tr class="hover:bg-stone-50">
        <td class="px-3 py-3 whitespace-nowrap text-stone-500">${formatTanggal(r.tanggal, { day: "numeric", month: "short", year: "numeric" })}</td>
        <td class="px-3 py-3">${escapeHtml(r.keterangan)}</td>
        <td class="px-3 py-3 text-right font-semibold whitespace-nowrap text-rose-700">${formatRupiah(r.jumlah)}</td>
        <td class="px-3 py-3 text-center"><button data-hapus-kas="${r.id}" class="text-rose-500 hover:text-rose-700" title="Hapus"><i class="fa-solid fa-trash"></i></button></td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="px-4 py-6 text-center text-stone-400">Belum ada pengeluaran.</td></tr>`;
}

// Input pengeluaran (tipe selalu "keluar", tanpa nomor rumah)
document.getElementById("form-kas").addEventListener("submit", async (e) => {
  e.preventDefault();
  const tanggal = document.getElementById("kas-tanggal").value;
  const keterangan = document.getElementById("kas-keterangan").value.trim();
  const jumlah = parseInt(document.getElementById("kas-jumlah").value, 10);

  if (!tanggal) return toast("Tanggal wajib diisi.", "error");
  if (!keterangan) return toast("Keterangan pengeluaran wajib diisi.", "error");
  if (!(jumlah > 0)) return toast("Jumlah harus lebih dari 0.", "error");

  const pulihkan = tombolLoading(e.submitter || document.querySelector('button[form="form-kas"]'), "");
  const { error } = await sb.from("uang_kas").insert({ tanggal, keterangan, tipe: "keluar", jumlah });
  pulihkan();
  if (error) return toast("Gagal menyimpan: " + error.message, "error");

  toast(`Pengeluaran ${formatRupiah(jumlah)} tersimpan.`, "sukses");
  document.getElementById("kas-keterangan").value = "";
  document.getElementById("kas-jumlah").value = "";
  document.getElementById("kas-keterangan").focus();
  muatKasAdmin();
});

// Hapus transaksi dari mana pun (tabel transaksi, tabel pengeluaran, modal iuran)
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-hapus-kas]");
  if (!btn || !confirm("Hapus transaksi ini?")) return;
  const { error } = await sb.from("uang_kas").delete().eq("id", btn.dataset.hapusKas);
  if (error) return toast("Gagal menghapus: " + error.message, "error");
  toast("Transaksi dihapus.", "sukses");
  tutupModalIuran();
  muatKasAdmin();
});

/* ---------------------------------------------------------------------
 * Buku kas: tabel iuran (klik sel) & tabel pengeluaran per bulan
 * ------------------------------------------------------------------- */
function renderBukuKasAdmin() {
  const tahun = Number(document.getElementById("adm-kas-tahun").value);
  document.querySelectorAll(".label-tahun").forEach((el) => (el.textContent = tahun));
  document.querySelectorAll(".label-iuran").forEach((el) => (el.textContent = formatRupiah(IURAN_BULANAN)));
  document.getElementById("adm-matriks-iuran").innerHTML =
    htmlMatriksIuran(kasCache.warga, kasCache.transaksi, tahun, { admin: true });
  document.getElementById("adm-tabel-pengeluaran").innerHTML =
    htmlPengeluaran(kasCache.transaksi, tahun, { admin: true });
}

document.getElementById("adm-kas-tahun").addEventListener("change", renderBukuKasAdmin);

/* ---------------------------------------------------------------------
 * Bayar iuran sekaligus: nominal dibagi per IURAN_BULANAN ke bulan yang
 * belum lunas. Contoh: Rp 100.000 → 4 bulan kosong pertama @ Rp 25.000.
 * Bulan yang baru terbayar sebagian dilengkapi dulu; sisa yang tidak genap
 * dicatat sebagai pembayaran sebagian di bulan berikutnya.
 * ------------------------------------------------------------------- */

/** Total iuran yang sudah dibayar sebuah rumah per bulan → { "YYYY-MM": jumlah } */
function iuranTerbayarPerBulan(rumah) {
  const hasil = {};
  for (const r of kasCache.transaksi) {
    if (r.tipe !== "masuk" || r.nomor_rumah !== rumah) continue;
    const bulan = String(r.periode_iuran || r.tanggal).slice(0, 7);
    hasil[bulan] = (hasil[bulan] || 0) + Number(r.jumlah);
  }
  return hasil;
}

/** Bulan terakhir yang pernah dibayar sebuah rumah ("YYYY-MM"), atau null */
function bulanTerakhirBayar(rumah) {
  const daftar = Object.keys(iuranTerbayarPerBulan(rumah)).sort();
  return daftar.length ? daftar[daftar.length - 1] : null;
}

/**
 * Bulan mulai bawaan untuk sebuah rumah:
 *  - bulan terakhir bayar + 1
 *  - bulan terakhir itu sendiri bila baru dibayar sebagian (dilengkapi dulu)
 *  - Januari (tahun yang dipilih di tabel iuran) bila rumah belum pernah bayar
 */
function bulanMulaiDefault(rumah) {
  const terakhir = bulanTerakhirBayar(rumah);
  if (!terakhir) return `${document.getElementById("adm-kas-tahun").value || todayWIB().slice(0, 4)}-01`;
  return iuranTerbayarPerBulan(rumah)[terakhir] < IURAN_BULANAN ? terakhir : geserBulan(terakhir, 1);
}

/** Pembagian nominal → [{ bulan: "YYYY-MM", jumlah, sebagian }] */
function hitungDistribusiIuran(rumah, total, mulai) {
  const terbayar = iuranTerbayarPerBulan(rumah);
  const hasil = [];
  let sisa = total;
  let bulan = mulai;
  for (let i = 0; sisa > 0 && i < 240; i++, bulan = geserBulan(bulan, 1)) {
    const kurang = IURAN_BULANAN - (terbayar[bulan] || 0);
    if (kurang <= 0) continue; // sudah lunas → lewati
    const jumlah = Math.min(kurang, sisa);
    hasil.push({ bulan, jumlah, sebagian: (terbayar[bulan] || 0) + jumlah < IURAN_BULANAN });
    sisa -= jumlah;
  }
  return hasil;
}

/** "2026-03" → "Mar 2026" */
function bulanPendek(bulan) {
  return `${NAMA_BULAN[Number(bulan.slice(5, 7)) - 1].slice(0, 3)} ${bulan.slice(0, 4)}`;
}

function pratinjauBayarIuran() {
  const rumah = normalisasiNomorRumah(document.getElementById("bi-rumah").value);
  const total = parseInt(document.getElementById("bi-jumlah").value, 10);
  const mulai = document.getElementById("bi-mulai").value;
  const wadah = document.getElementById("bi-pratinjau");

  if (!rumah || !(total > 0) || !mulai) {
    wadah.innerHTML = `<span class="text-stone-500">Isi No. Rumah dan jumlah untuk melihat pembagian bulan.</span>`;
    return [];
  }
  const bagian = hitungDistribusiIuran(rumah, total, mulai);
  const nama = petaWarga[rumah];
  const terakhir = bulanTerakhirBayar(rumah);
  wadah.innerHTML = `
    <p class="text-xs text-stone-500 mb-1"><i class="fa-solid fa-clock-rotate-left mr-1"></i>Terakhir bayar: ${
      terakhir ? `<b>${bulanPendek(terakhir)}</b>` : "<b>belum pernah</b> (mulai dari Januari)"}</p>
    <p class="text-stone-600">
      ${nama ? `<b>${escapeHtml(rumah)} · ${escapeHtml(nama)}</b>` : `<b class="text-rose-600">${escapeHtml(rumah)} (tidak ada di data warga)</b>`}
      — ${formatRupiah(total)} dibagi ke <b>${bagian.length} bulan</b>:
    </p>
    <div class="mt-2 flex flex-wrap gap-2">
      ${bagian.map((b) => `
        <span class="px-2.5 py-1 rounded-lg text-xs font-medium ${b.sebagian ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}">
          ${bulanPendek(b.bulan)} · ${formatAngka(b.jumlah)}${b.sebagian ? " (sebagian)" : ""}
        </span>`).join("")}
    </div>`;
  return bagian;
}

// Rumah berubah → isi otomatis "Mulai bulan" = bulan terakhir bayar + 1
document.getElementById("bi-rumah").addEventListener("input", () => {
  const rumah = normalisasiNomorRumah(document.getElementById("bi-rumah").value);
  if (rumah) document.getElementById("bi-mulai").value = bulanMulaiDefault(rumah);
  pratinjauBayarIuran();
});
["bi-jumlah", "bi-mulai"].forEach((id) => document.getElementById(id).addEventListener("input", pratinjauBayarIuran));

// Klik nama warga di tabel iuran → isi form bayar iuran
document.getElementById("adm-matriks-iuran").addEventListener("click", (e) => {
  const el = e.target.closest("[data-pilih-rumah]");
  if (!el) return;
  document.getElementById("bi-rumah").value = el.dataset.pilihRumah;
  document.getElementById("bi-rumah").dispatchEvent(new Event("input"));
  document.getElementById("form-bayar-iuran").scrollIntoView({ behavior: "smooth", block: "center" });
  document.getElementById("bi-jumlah").focus();
});

document.getElementById("form-bayar-iuran").addEventListener("submit", async (e) => {
  e.preventDefault();
  const rumah = normalisasiNomorRumah(document.getElementById("bi-rumah").value);
  const tanggal = document.getElementById("bi-tanggal").value;
  const bagian = pratinjauBayarIuran();
  if (!rumah || !tanggal || !bagian.length) return toast("Lengkapi No. Rumah, tanggal, dan jumlah.", "error");
  if (!petaWarga[rumah] && !confirm(`Rumah ${rumah} tidak ada di data warga. Tetap simpan?`)) return;

  const ringkas = bagian.map((b) => `${bulanPendek(b.bulan)} ${formatRupiah(b.jumlah)}`).join(", ");
  if (!confirm(`Simpan pembayaran Rumah ${rumah}?\n\n${ringkas}`)) return;

  const baris = bagian.map((b) => {
    const [th, bl] = b.bulan.split("-").map(Number);
    return {
      tanggal,
      nomor_rumah: rumah,
      periode_iuran: periodeIuran(th, bl),
      keterangan: `Iuran ${NAMA_BULAN[bl - 1]} ${th}${b.sebagian ? " (sebagian)" : ""}`,
      tipe: "masuk",
      jumlah: b.jumlah,
    };
  });

  const pulihkan = tombolLoading(e.submitter || e.target.querySelector("button"), "Menyimpan...");
  const { error } = await sb.from("uang_kas").insert(baris); // satu request, semua atau tidak sama sekali
  pulihkan();
  if (error) return toast("Gagal menyimpan: " + error.message, "error");

  toast(`Iuran Rumah ${rumah} tersimpan untuk ${bagian.length} bulan.`, "sukses");
  document.getElementById("bi-rumah").value = "";
  document.getElementById("bi-jumlah").value = "";
  await muatKasAdmin();
  pratinjauBayarIuran();
  document.getElementById("bi-rumah").focus();
});

document.getElementById("adm-matriks-iuran").addEventListener("click", (e) => {
  const sel = e.target.closest("[data-sel]");
  if (!sel) return;
  const [rumah, bulan] = sel.dataset.sel.split("|");
  bukaModalIuran(rumah, Number(bulan));
});

function bukaModalIuran(rumah, bulan) {
  const tahun = Number(document.getElementById("adm-kas-tahun").value);
  selIuran = { rumah, bulan, tahun };

  document.getElementById("iuran-judul").textContent = `${NAMA_BULAN[bulan - 1]} ${tahun}`;
  document.getElementById("iuran-nama").textContent = `Rumah ${rumah}${petaWarga[rumah] ? " · " + petaWarga[rumah] : ""}`;

  // Pembayaran yang sudah ada di sel ini
  const ada = kasCache.transaksi.filter((r) => r.nomor_rumah === rumah && bulanIuran(r, tahun) === bulan);
  document.getElementById("iuran-riwayat").innerHTML = ada.length
    ? ada.map((r) => `
        <div class="flex items-center justify-between gap-2 p-3 rounded-xl bg-emerald-50 text-sm">
          <span><i class="fa-solid fa-circle-check text-emerald-600 mr-1"></i><b>${formatRupiah(r.jumlah)}</b>
            <span class="text-stone-500">· dibayar ${formatTanggal(r.tanggal, { day: "numeric", month: "short", year: "numeric" })}</span></span>
          <button type="button" data-hapus-kas="${r.id}" class="text-rose-500 hover:text-rose-700" title="Hapus pembayaran ini"><i class="fa-solid fa-trash"></i></button>
        </div>`).join("") +
      `<p class="text-xs text-stone-500">Isi form di bawah hanya bila ada pembayaran tambahan untuk bulan ini.</p>`
    : `<p class="text-sm text-rose-600"><i class="fa-solid fa-circle-xmark mr-1"></i>Belum ada pembayaran untuk bulan ini.</p>`;

  document.getElementById("iuran-tanggal").value = todayWIB();
  document.getElementById("iuran-jumlah").value = IURAN_BULANAN;
  tampil("modal-iuran", true);
  document.getElementById("iuran-jumlah").focus();
}

function tutupModalIuran() {
  tampil("modal-iuran", false);
  selIuran = null;
}

document.querySelectorAll("[data-tutup-iuran]").forEach((b) => b.addEventListener("click", tutupModalIuran));
document.getElementById("modal-iuran").addEventListener("click", (e) => { if (e.target.id === "modal-iuran") tutupModalIuran(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && selIuran) tutupModalIuran(); });

document.getElementById("form-iuran").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selIuran) return;
  const { rumah, bulan, tahun } = selIuran;
  const jumlah = parseInt(document.getElementById("iuran-jumlah").value, 10);
  if (!(jumlah > 0)) return toast("Jumlah harus lebih dari 0.", "error");

  const pulihkan = tombolLoading(e.submitter || e.target.querySelector('button[type="submit"]'), "Menyimpan...");
  const { error } = await sb.from("uang_kas").insert({
    tanggal: document.getElementById("iuran-tanggal").value,
    nomor_rumah: rumah,
    periode_iuran: periodeIuran(tahun, bulan),
    keterangan: `Iuran ${NAMA_BULAN[bulan - 1]} ${tahun}`,
    tipe: "masuk",
    jumlah,
  });
  pulihkan();
  if (error) return toast("Gagal menyimpan: " + error.message, "error");
  toast(`Iuran rumah ${rumah} bulan ${NAMA_BULAN[bulan - 1]} tersimpan.`, "sukses");
  tutupModalIuran();
  muatKasAdmin();
});

/* =====================================================================
 * PENGUMUMAN & STATUS KEAMANAN
 * =================================================================== */
let daftarPengumuman = []; // data terakhir, untuk mengisi form saat edit
let idEditPengumuman = null; // null = mode "baru"

document.getElementById("p-kategori").addEventListener("change", (e) => {
  tampil("wadah-status", e.target.value === "keamanan");
});

/** Ubah form antara mode "Pengumuman Baru" dan mode "Edit" */
function modeFormPengumuman(p = null) {
  idEditPengumuman = p ? p.id : null;
  const form = document.getElementById("form-pengumuman");
  form.reset();
  if (p) {
    document.getElementById("p-judul").value = p.judul;
    document.getElementById("p-isi").value = p.isi;
    document.getElementById("p-kategori").value = p.kategori;
    if (p.status_keamanan) document.getElementById("p-status").value = p.status_keamanan;
  }
  tampil("wadah-status", document.getElementById("p-kategori").value === "keamanan");
  document.getElementById("p-judul-form").textContent = p ? "Edit Pengumuman" : "Pengumuman Baru";
  document.getElementById("p-ikon-judul").className = `fa-solid ${p ? "fa-pen-to-square text-amber-600" : "fa-bullhorn text-brand-600"} mr-2`;
  document.getElementById("p-tombol-simpan").innerHTML = p
    ? `<i class="fa-solid fa-floppy-disk mr-2"></i>Simpan Perubahan`
    : `<i class="fa-solid fa-paper-plane mr-2"></i>Terbitkan`;
  tampil("p-info-edit", !!p);
  tampil("p-batal-edit", !!p);
  form.classList.toggle("ring-2", !!p);
  form.classList.toggle("ring-amber-300", !!p);
  // Tandai kartu yang sedang diedit di daftar
  document.querySelectorAll("[data-kartu-p]").forEach((el) =>
    el.classList.toggle("ring-2", !!p && el.dataset.kartuP === String(p.id)));
}

document.getElementById("p-batal-edit").addEventListener("click", () => modeFormPengumuman(null));

async function muatPengumumanAdmin() {
  const { data, error } = await sb.from("tabel_pengumuman").select("*").order("created_at", { ascending: false });
  if (error) return toast("Gagal memuat pengumuman: " + error.message, "error");
  daftarPengumuman = data;

  document.getElementById("adm-daftar-pengumuman").innerHTML = data.length
    ? data.map((p) => `
      <article data-kartu-p="${p.id}" class="bg-white rounded-2xl border border-stone-200 p-4 ring-amber-300 ${p.aktif ? "" : "opacity-60"} ${p.id === idEditPengumuman ? "ring-2" : ""}">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="px-2 py-0.5 rounded-full bg-stone-100 capitalize">${escapeHtml(p.kategori)}</span>
              ${p.status_keamanan ? `<span class="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 capitalize">${escapeHtml(p.status_keamanan)}</span>` : ""}
              ${p.aktif ? "" : `<span class="px-2 py-0.5 rounded-full bg-stone-200">Disembunyikan</span>`}
              <span class="text-stone-400">${formatWaktu(p.created_at)}</span>
            </div>
            <h3 class="font-semibold mt-2">${escapeHtml(p.judul)}</h3>
            <p class="text-sm text-stone-600 whitespace-pre-line">${escapeHtml(p.isi)}</p>
          </div>
          <div class="flex gap-1 shrink-0">
            <button data-edit-p="${p.id}" class="w-9 h-9 rounded-lg hover:bg-amber-50 text-amber-600" title="Edit"><i class="fa-solid fa-pen-to-square"></i></button>
            <button data-toggle-p="${p.id}" data-aktif="${p.aktif}" class="w-9 h-9 rounded-lg hover:bg-stone-100" title="${p.aktif ? "Sembunyikan" : "Tampilkan"}"><i class="fa-solid ${p.aktif ? "fa-eye-slash" : "fa-eye"}"></i></button>
            <button data-hapus-p="${p.id}" class="w-9 h-9 rounded-lg hover:bg-rose-50 text-rose-500" title="Hapus"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>
      </article>`).join("")
    : `<p class="text-sm text-stone-400">Belum ada pengumuman.</p>`;
}

// Simpan: insert bila mode baru, update bila mode edit
document.getElementById("form-pengumuman").addEventListener("submit", async (e) => {
  e.preventDefault();
  const kategori = document.getElementById("p-kategori").value;
  const isi = {
    judul: document.getElementById("p-judul").value.trim(),
    isi: document.getElementById("p-isi").value.trim(),
    kategori,
    status_keamanan: kategori === "keamanan" ? document.getElementById("p-status").value : null,
  };
  const sedangEdit = idEditPengumuman !== null;

  const pulihkan = tombolLoading(document.getElementById("p-tombol-simpan"), sedangEdit ? "Menyimpan..." : "Menerbitkan...");
  const { error } = sedangEdit
    ? await sb.from("tabel_pengumuman").update(isi).eq("id", idEditPengumuman)
    : await sb.from("tabel_pengumuman").insert(isi);
  pulihkan();
  if (error) return toast("Gagal: " + error.message, "error");

  toast(sedangEdit ? "Perubahan pengumuman tersimpan." : "Pengumuman terbit (realtime di portal warga).", "sukses");
  modeFormPengumuman(null);
  muatPengumumanAdmin();
});

document.getElementById("adm-daftar-pengumuman").addEventListener("click", async (e) => {
  const edt = e.target.closest("[data-edit-p]");
  const tgl = e.target.closest("[data-toggle-p]");
  const hps = e.target.closest("[data-hapus-p]");

  if (edt) {
    const p = daftarPengumuman.find((x) => String(x.id) === edt.dataset.editP);
    if (!p) return;
    modeFormPengumuman(p);
    document.getElementById("form-pengumuman").scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("p-judul").focus();
    return;
  }

  let error;
  if (tgl) {
    ({ error } = await sb.from("tabel_pengumuman")
      .update({ aktif: tgl.dataset.aktif !== "true" }).eq("id", tgl.dataset.toggleP));
  } else if (hps && confirm("Hapus pengumuman ini?")) {
    ({ error } = await sb.from("tabel_pengumuman").delete().eq("id", hps.dataset.hapusP));
    // Pengumuman yang sedang diedit ikut terhapus → kembali ke mode baru
    if (!error && hps.dataset.hapusP === String(idEditPengumuman)) modeFormPengumuman(null);
  } else return;
  if (error) return toast("Gagal: " + error.message, "error");
  muatPengumumanAdmin();
});

/* =====================================================================
 * DATA WARGA
 * =================================================================== */
async function muatWarga() {
  const { data, error } = await sb.from("warga").select("*").order("nomor_rumah");
  if (error) return toast("Gagal memuat warga: " + error.message, "error");

  document.getElementById("jumlah-warga").textContent = `(${data.filter((w) => w.aktif).length} aktif / ${data.length})`;
  document.getElementById("adm-tabel-warga").innerHTML = data.length
    ? data.map((w) => `
      <tr class="hover:bg-stone-50">
        <td class="px-4 py-3 font-bold text-brand-800">${escapeHtml(w.nomor_rumah)}</td>
        <td class="px-4 py-3">${escapeHtml(w.nama)}</td>
        <td class="px-4 py-3">
          <button data-toggle-w="${w.id}" data-aktif="${w.aktif}" class="px-2 py-1 rounded-full text-xs font-medium ${w.aktif ? "bg-emerald-100 text-emerald-700" : "bg-stone-200 text-stone-500"}">
            ${w.aktif ? "Aktif" : "Nonaktif"}
          </button>
        </td>
        <td class="px-4 py-3 text-right"><button data-hapus-w="${w.id}" class="text-rose-500 hover:text-rose-700" title="Hapus"><i class="fa-solid fa-trash"></i></button></td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="px-4 py-6 text-center text-stone-400">Belum ada data warga.</td></tr>`;
}

document.getElementById("form-warga").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nomor = normalisasiNomorRumah(document.getElementById("w-rumah").value);
  if (!nomor) return toast("Nomor rumah tidak valid.", "error");

  const pulihkan = tombolLoading(e.submitter || e.target.querySelector("button"), "Menyimpan...");
  const { error } = await sb.from("warga").insert({
    nama: document.getElementById("w-nama").value.trim(),
    nomor_rumah: nomor,
  });
  pulihkan();
  if (error) {
    return toast(error.code === "23505" ? `Rumah ${nomor} sudah terdaftar.` : "Gagal: " + error.message, "error");
  }
  toast(`Warga rumah ${nomor} ditambahkan.`, "sukses");
  e.target.reset();
  muatWarga();
});

document.getElementById("adm-tabel-warga").addEventListener("click", async (e) => {
  const tgl = e.target.closest("[data-toggle-w]");
  const hps = e.target.closest("[data-hapus-w]");
  let error;
  if (tgl) {
    ({ error } = await sb.from("warga").update({ aktif: tgl.dataset.aktif !== "true" }).eq("id", tgl.dataset.toggleW));
  } else if (hps && confirm("Hapus warga ini? (Jadwal yang sudah terbit tidak ikut terhapus)")) {
    ({ error } = await sb.from("warga").delete().eq("id", hps.dataset.hapusW));
  } else return;
  if (error) return toast("Gagal: " + error.message, "error");
  muatWarga();
});

/* =====================================================================
 * BUKTI FOTO (bucket privat → signed URL berlaku 5 menit)
 * =================================================================== */
let rekapMingguan = []; // dipakai tombol "salin untuk WA"

/** Status satu hari jadwal: "sesuai" | "pengganti" | "tanpa" | "menunggu" */
function statusHari(j, b, hariIni) {
  if (b) return (b.diunggah_oleh && b.diunggah_oleh !== j.nomor_rumah) ? "pengganti" : "sesuai";
  return j.tanggal === hariIni ? "menunggu" : "tanpa";
}

async function muatBukti() {
  const hariIni = todayWIB();
  const awal = tambahHari(seninPekanIni(hariIni), -28); // 5 pekan: pekan ini + 4 pekan lalu

  const [{ data: jadwal, error: e1 }, { data: bukti, error: e2 }] = await Promise.all([
    sb.from("jadwal_piket").select("tanggal, nomor_rumah, nama_warga")
      .gte("tanggal", awal).lte("tanggal", hariIni).order("tanggal", { ascending: false }),
    sb.from("bukti_gerbang").select("*").gte("tanggal", awal),
  ]);
  if (e1 || e2) return toast("Gagal memuat bukti: " + (e1 || e2).message, "error");

  const peta = Object.fromEntries(bukti.map((b) => [`${b.tanggal}|${b.nomor_rumah}`, b]));
  const LENCANA = {
    sesuai: (b) => `<span class="px-2 py-1 rounded-full text-xs bg-emerald-100 text-emerald-700"><i class="fa-solid fa-check mr-1"></i>${formatWaktu(b.created_at)}</span>`,
    pengganti: (b) => `<span class="px-2 py-1 rounded-full text-xs bg-amber-100 text-amber-800"><i class="fa-solid fa-people-arrows mr-1"></i>Pengganti: ${escapeHtml(b.diunggah_oleh)} · ${formatWaktu(b.created_at)}</span>`,
    menunggu: () => `<span class="px-2 py-1 rounded-full text-xs bg-stone-100 text-stone-600"><i class="fa-solid fa-hourglass-half mr-1"></i>Menunggu</span>`,
    tanpa: () => `<span class="px-2 py-1 rounded-full text-xs bg-rose-100 text-rose-700"><i class="fa-solid fa-xmark mr-1"></i>Tanpa bukti</span>`,
  };

  document.getElementById("adm-tabel-bukti").innerHTML = jadwal.length
    ? jadwal.map((j) => {
      const b = peta[`${j.tanggal}|${j.nomor_rumah}`];
      return `
        <tr class="hover:bg-stone-50">
          <td class="px-4 py-3 whitespace-nowrap">${formatTanggal(j.tanggal, { weekday: "short", day: "numeric", month: "short" })}</td>
          <td class="px-4 py-3"><b>${escapeHtml(j.nomor_rumah)}</b> · ${escapeHtml(j.nama_warga)}</td>
          <td class="px-4 py-3">${LENCANA[statusHari(j, b, hariIni)](b)}</td>
          <td class="px-4 py-3 text-right whitespace-nowrap">${b
            ? `<button data-lihat="${escapeHtml(b.path)}" class="text-brand-700 font-medium"><i class="fa-solid fa-image mr-1"></i>Lihat</button>
               <button data-hapus-bukti="${b.id}" data-path="${escapeHtml(b.path)}" data-label="${escapeHtml(`${j.nomor_rumah} ${formatTanggal(j.tanggal, { day: "numeric", month: "short" })}`)}"
                       class="ml-3 text-rose-500 hover:text-rose-700" title="Hapus bukti (upload untuk tanggal ini terbuka lagi)"><i class="fa-solid fa-trash"></i></button>` : ""}</td>
        </tr>`;
    }).join("")
    : `<tr><td colspan="4" class="px-4 py-6 text-center text-stone-400">Tidak ada jadwal dalam 5 pekan terakhir.</td></tr>`;

  // ---- Rekap per pekan (Senin–Minggu), terbaru di atas ----
  const perPekan = {};
  for (const j of jadwal) {
    const senin = seninPekanIni(j.tanggal);
    const p = (perPekan[senin] ||= { senin, hari: 0, sesuai: 0, pengganti: [], tanpa: [], menunggu: 0 });
    const b = peta[`${j.tanggal}|${j.nomor_rumah}`];
    const s = statusHari(j, b, hariIni);
    p.hari++;
    if (s === "sesuai") p.sesuai++;
    else if (s === "pengganti") p.pengganti.push({ ...j, oleh: b.diunggah_oleh });
    else if (s === "tanpa") p.tanpa.push(j);
    else p.menunggu++;
  }
  rekapMingguan = Object.values(perPekan).sort((a, b) => (a.senin < b.senin ? 1 : -1));

  const hariPendek = (t) => formatTanggal(t, { weekday: "short", day: "numeric" });
  document.getElementById("adm-rekap-bukti").innerHTML = rekapMingguan.length
    ? rekapMingguan.map((p, i) => {
      const catatan = [
        ...p.tanpa.map((j) => `<span class="text-rose-700">${hariPendek(j.tanggal)}: ${escapeHtml(j.nomor_rumah)} tanpa bukti</span>`),
        ...p.pengganti.map((j) => `<span class="text-amber-700">${hariPendek(j.tanggal)}: ${escapeHtml(j.oleh)} menggantikan ${escapeHtml(j.nomor_rumah)}</span>`),
        ...(p.menunggu ? [`<span class="text-stone-500">Hari ini menunggu bukti</span>`] : []),
      ];
      return `
        <tr class="hover:bg-stone-50 align-top">
          <td class="px-4 py-3 whitespace-nowrap font-medium">${formatTanggal(p.senin, { day: "numeric", month: "short" })} – ${formatTanggal(tambahHari(p.senin, 6), { day: "numeric", month: "short" })}</td>
          <td class="px-3 py-3 text-center">${p.hari}</td>
          <td class="px-3 py-3 text-center font-semibold text-emerald-700">${p.sesuai}</td>
          <td class="px-3 py-3 text-center font-semibold text-amber-700">${p.pengganti.length}</td>
          <td class="px-3 py-3 text-center font-semibold text-rose-700">${p.tanpa.length}</td>
          <td class="px-4 py-3 text-xs space-y-0.5">${catatan.length ? catatan.map((c) => `<div>${c}</div>`).join("") : `<span class="text-emerald-700">Semua terkunci sesuai jadwal</span>`}</td>
          <td class="px-3 py-3 text-right"><button data-salin-rekap="${i}" class="w-9 h-9 rounded-lg text-emerald-600 hover:bg-emerald-50" title="Salin laporan untuk WhatsApp"><i class="fa-brands fa-whatsapp text-lg"></i></button></td>
        </tr>`;
    }).join("")
    : `<tr><td colspan="7" class="px-4 py-6 text-center text-stone-400">Belum ada data.</td></tr>`;
}

/** Teks laporan mingguan siap tempel ke grup WhatsApp (format *tebal* WA) */
function teksLaporanWA(p) {
  const rentang = `${formatTanggal(p.senin, { day: "numeric", month: "long" })} – ${formatTanggal(tambahHari(p.senin, 6), { day: "numeric", month: "long", year: "numeric" })}`;
  const baris = [
    `*Laporan Kunci Gerbang ${CFG.NAMA_CLUSTER}*`,
    `Pekan ${rentang}`,
    "",
    `✅ Sesuai jadwal: ${p.sesuai} hari`,
    `🔁 Oleh pengganti: ${p.pengganti.length} hari`,
    `❌ Tanpa bukti: ${p.tanpa.length} hari`,
  ];
  if (p.pengganti.length) {
    baris.push("", "*Pengganti:*", ...p.pengganti.map((j) =>
      `- ${formatTanggal(j.tanggal, { weekday: "long", day: "numeric", month: "short" })}: Rumah ${j.oleh} menggantikan Rumah ${j.nomor_rumah}`));
  }
  if (p.tanpa.length) {
    baris.push("", "*Tanpa bukti:*", ...p.tanpa.map((j) =>
      `- ${formatTanggal(j.tanggal, { weekday: "long", day: "numeric", month: "short" })}: Rumah ${j.nomor_rumah} (${j.nama_warga})`));
  }
  baris.push("", "Terima kasih atas partisipasinya menjaga keamanan cluster 🙏");
  return baris.join("\n");
}

document.getElementById("adm-rekap-bukti").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-salin-rekap]");
  if (!btn) return;
  const teks = teksLaporanWA(rekapMingguan[Number(btn.dataset.salinRekap)]);
  try {
    await navigator.clipboard.writeText(teks);
    toast("Laporan disalin. Tempel di grup WhatsApp.", "sukses");
  } catch {
    // Clipboard diblokir (mis. bukan HTTPS) → tampilkan untuk disalin manual
    prompt("Salin laporan berikut:", teks);
  }
});

document.getElementById("btn-muat-bukti").addEventListener("click", muatBukti);

/**
 * Hapus bukti: file di Storage (lewat Storage API) + catatan bukti_gerbang.
 * Setelah dihapus, upload untuk tanggal itu terbuka lagi — berguna saat testing
 * atau bila warga salah mengunggah foto.
 */
document.getElementById("adm-tabel-bukti").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-hapus-bukti]");
  if (!btn) return;
  if (!confirm(`Hapus bukti foto ${btn.dataset.label}?\nFoto dihapus permanen dan upload untuk tanggal ini terbuka lagi.`)) return;

  const pulihkan = tombolLoading(btn, "");
  try {
    // 1) File foto. File yang sudah tidak ada tidak dianggap error.
    const { error: errFile } = await sb.storage.from(CFG.BUCKET_FOTO).remove([btn.dataset.path]);
    if (errFile) throw errFile;
    // 2) Catatan bukti → membuka kunci upload (sudah_upload jadi false)
    const { error: errLog } = await sb.from("bukti_gerbang").delete().eq("id", btn.dataset.hapusBukti);
    if (errLog) throw errLog;
    toast(`Bukti ${btn.dataset.label} dihapus. Upload terbuka lagi.`, "sukses");
    muatBukti();
  } catch (err) {
    toast("Gagal menghapus bukti: " + err.message, "error");
    pulihkan();
  }
});

document.getElementById("adm-tabel-bukti").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-lihat]");
  if (!btn) return;
  const { data, error } = await sb.storage.from(CFG.BUCKET_FOTO).createSignedUrl(btn.dataset.lihat, 300);
  if (error) return toast("Foto tidak ditemukan (mungkin sudah dibersihkan): " + error.message, "error");
  document.getElementById("gambar-modal").src = data.signedUrl;
  document.getElementById("caption-modal").textContent = btn.dataset.lihat;
  tampil("modal-foto", true);
});

function tutupModal() {
  tampil("modal-foto", false);
  document.getElementById("gambar-modal").src = "";
}
document.getElementById("tutup-modal").addEventListener("click", tutupModal);
document.getElementById("modal-foto").addEventListener("click", (e) => { if (e.target.id === "modal-foto") tutupModal(); });

/* =====================================================================
 * INISIALISASI
 * =================================================================== */
sb.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") tampilLogin();
});
cekSesi();
