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
async function muatKasAdmin() {
  document.getElementById("kas-tanggal").value ||= todayWIB();
  const { data, error } = await ambilSemua(() => sb
    .from("uang_kas").select("*")
    .order("tanggal", { ascending: false }).order("id", { ascending: false }));
  if (error) return toast("Gagal memuat kas: " + error.message, "error");

  const { masuk, keluar, saldo } = hitungRingkasanKas(data);
  document.getElementById("adm-kas-masuk").textContent = formatRupiah(masuk);
  document.getElementById("adm-kas-keluar").textContent = formatRupiah(keluar);
  document.getElementById("adm-kas-saldo").textContent = formatRupiah(saldo);

  document.getElementById("adm-tabel-kas").innerHTML = data.length
    ? data.map((r) => `
      <tr class="hover:bg-stone-50">
        <td class="px-4 py-3 whitespace-nowrap text-stone-500">${formatTanggal(r.tanggal, { day: "numeric", month: "short", year: "numeric" })}</td>
        <td class="px-4 py-3">${escapeHtml(r.keterangan)}</td>
        <td class="px-4 py-3 text-right font-semibold whitespace-nowrap ${r.tipe === "masuk" ? "text-emerald-700" : "text-rose-700"}">${r.tipe === "masuk" ? "+" : "−"} ${formatRupiah(r.jumlah)}</td>
        <td class="px-4 py-3 text-right"><button data-hapus-kas="${r.id}" class="text-rose-500 hover:text-rose-700" title="Hapus"><i class="fa-solid fa-trash"></i></button></td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="px-4 py-6 text-center text-stone-400">Belum ada transaksi.</td></tr>`;
}

document.getElementById("form-kas").addEventListener("submit", async (e) => {
  e.preventDefault();
  const jumlah = parseInt(document.getElementById("kas-jumlah").value, 10);
  if (!(jumlah > 0)) return toast("Jumlah harus lebih dari 0.", "error");

  const pulihkan = tombolLoading(e.submitter || e.target.querySelector("button"), "Menyimpan...");
  const { error } = await sb.from("uang_kas").insert({
    tanggal: document.getElementById("kas-tanggal").value,
    keterangan: document.getElementById("kas-keterangan").value.trim(),
    tipe: document.querySelector('input[name="kas-tipe"]:checked').value,
    jumlah,
  });
  pulihkan();
  if (error) return toast("Gagal menyimpan: " + error.message, "error");
  toast("Transaksi tersimpan.", "sukses");
  document.getElementById("kas-keterangan").value = "";
  document.getElementById("kas-jumlah").value = "";
  muatKasAdmin();
});

document.getElementById("adm-tabel-kas").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-hapus-kas]");
  if (!btn || !confirm("Hapus transaksi ini?")) return;
  const { error } = await sb.from("uang_kas").delete().eq("id", btn.dataset.hapusKas);
  if (error) return toast("Gagal menghapus: " + error.message, "error");
  toast("Transaksi dihapus.", "sukses");
  muatKasAdmin();
});

/* =====================================================================
 * PENGUMUMAN & STATUS KEAMANAN
 * =================================================================== */
document.getElementById("p-kategori").addEventListener("change", (e) => {
  tampil("wadah-status", e.target.value === "keamanan");
});

async function muatPengumumanAdmin() {
  const { data, error } = await sb.from("tabel_pengumuman").select("*").order("created_at", { ascending: false });
  if (error) return toast("Gagal memuat pengumuman: " + error.message, "error");

  document.getElementById("adm-daftar-pengumuman").innerHTML = data.length
    ? data.map((p) => `
      <article class="bg-white rounded-2xl border border-stone-200 p-4 ${p.aktif ? "" : "opacity-60"}">
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
            <button data-toggle-p="${p.id}" data-aktif="${p.aktif}" class="w-9 h-9 rounded-lg hover:bg-stone-100" title="${p.aktif ? "Sembunyikan" : "Tampilkan"}"><i class="fa-solid ${p.aktif ? "fa-eye-slash" : "fa-eye"}"></i></button>
            <button data-hapus-p="${p.id}" class="w-9 h-9 rounded-lg hover:bg-rose-50 text-rose-500" title="Hapus"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>
      </article>`).join("")
    : `<p class="text-sm text-stone-400">Belum ada pengumuman.</p>`;
}

document.getElementById("form-pengumuman").addEventListener("submit", async (e) => {
  e.preventDefault();
  const kategori = document.getElementById("p-kategori").value;
  const pulihkan = tombolLoading(e.submitter || e.target.querySelector("button"), "Menerbitkan...");
  const { error } = await sb.from("tabel_pengumuman").insert({
    judul: document.getElementById("p-judul").value.trim(),
    isi: document.getElementById("p-isi").value.trim(),
    kategori,
    status_keamanan: kategori === "keamanan" ? document.getElementById("p-status").value : null,
  });
  pulihkan();
  if (error) return toast("Gagal: " + error.message, "error");
  toast("Pengumuman terbit (realtime di portal warga).", "sukses");
  e.target.reset();
  tampil("wadah-status", false);
  muatPengumumanAdmin();
});

document.getElementById("adm-daftar-pengumuman").addEventListener("click", async (e) => {
  const tgl = e.target.closest("[data-toggle-p]");
  const hps = e.target.closest("[data-hapus-p]");
  let error;
  if (tgl) {
    ({ error } = await sb.from("tabel_pengumuman")
      .update({ aktif: tgl.dataset.aktif !== "true" }).eq("id", tgl.dataset.toggleP));
  } else if (hps && confirm("Hapus pengumuman ini?")) {
    ({ error } = await sb.from("tabel_pengumuman").delete().eq("id", hps.dataset.hapusP));
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
async function muatBukti() {
  const hariIni = todayWIB();
  const awal = tambahHari(hariIni, -30);

  const [{ data: jadwal, error: e1 }, { data: bukti, error: e2 }] = await Promise.all([
    sb.from("jadwal_piket").select("tanggal, nomor_rumah, nama_warga")
      .gte("tanggal", awal).lte("tanggal", hariIni).order("tanggal", { ascending: false }),
    sb.from("bukti_gerbang").select("*").gte("tanggal", awal),
  ]);
  if (e1 || e2) return toast("Gagal memuat bukti: " + (e1 || e2).message, "error");

  const peta = Object.fromEntries(bukti.map((b) => [`${b.tanggal}|${b.nomor_rumah}`, b]));
  document.getElementById("adm-tabel-bukti").innerHTML = jadwal.length
    ? jadwal.map((j) => {
      const b = peta[`${j.tanggal}|${j.nomor_rumah}`];
      return `
        <tr class="hover:bg-stone-50">
          <td class="px-4 py-3 whitespace-nowrap">${formatTanggal(j.tanggal, { weekday: "short", day: "numeric", month: "short" })}</td>
          <td class="px-4 py-3"><b>${escapeHtml(j.nomor_rumah)}</b> · ${escapeHtml(j.nama_warga)}</td>
          <td class="px-4 py-3">${b
            ? `<span class="px-2 py-1 rounded-full text-xs bg-emerald-100 text-emerald-700"><i class="fa-solid fa-check mr-1"></i>${formatWaktu(b.created_at)}</span>`
            : `<span class="px-2 py-1 rounded-full text-xs bg-rose-100 text-rose-700"><i class="fa-solid fa-xmark mr-1"></i>Belum upload</span>`}</td>
          <td class="px-4 py-3 text-right">${b
            ? `<button data-lihat="${escapeHtml(b.path)}" class="text-brand-700 font-medium"><i class="fa-solid fa-image mr-1"></i>Lihat</button>` : ""}</td>
        </tr>`;
    }).join("")
    : `<tr><td colspan="4" class="px-4 py-6 text-center text-stone-400">Tidak ada jadwal dalam 30 hari terakhir.</td></tr>`;
}

document.getElementById("btn-muat-bukti").addEventListener("click", muatBukti);

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
