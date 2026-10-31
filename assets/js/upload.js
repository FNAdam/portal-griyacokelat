/* =====================================================================
 * upload.js — Upload foto bukti kunci gerbang (tanpa login warga)
 *
 * Alur ganda:
 *  A. Jalur utama  : upload.html?token=A12_xxxx (dari notifikasi OneSignal)
 *                    → RPC cek_token → langsung terbuka tanpa mengetik.
 *  B. Jalur cadangan: warga mengetik Nomor Rumah → dicocokkan ke
 *                    jadwal_piket tanggal hari ini → terbuka bila cocok.
 *
 * Pencegahan upload ganda (berlapis):
 *  1. RPC sudah_upload() dicek sebelum form ditampilkan.
 *  2. Storage upload memakai upsert:false (file sama tidak bisa ditimpa).
 *  3. Policy storage menolak bila log bukti hari ini sudah ada.
 *  4. Constraint UNIQUE(nomor_rumah, tanggal) di tabel bukti_gerbang.
 * ===================================================================== */

const HARI_INI = todayWIB();
const SISI_MAKS = 1280;     // resolusi sisi terpanjang setelah kompres (px)
const KUALITAS_JPEG = 0.8;

let rumahTerverifikasi = null; // { nomor_rumah, nama_warga, pengganti? } — nomor_rumah = rumah TERJADWAL
let blobSiapUpload = null;     // hasil kompres JPEG
let jadwalHariIni = null;      // { nomor_rumah, nama_warga } atau null
let calonPengganti = null;     // nomor rumah yang menawarkan diri sebagai pengganti
let infoPiketSiap = Promise.resolve(); // selesai saat jadwalHariIni sudah dimuat

const PANEL = ["panel-memuat", "panel-verifikasi", "panel-upload", "panel-sukses", "panel-tolak"];
function tampilPanel(id) {
  PANEL.forEach((p) => tampil(p, p === id));
}

/* ---------------------------------------------------------------------
 * Info piket hari ini (publik)
 * ------------------------------------------------------------------- */
async function muatInfoPiket() {
  document.getElementById("tanggal-hari-ini").textContent = formatTanggal(HARI_INI);
  document.getElementById("jam-tutup").textContent = CFG.JAM_TUTUP;
  const { data } = await sb
    .from("jadwal_piket")
    .select("nomor_rumah, nama_warga")
    .eq("tanggal", HARI_INI)
    .maybeSingle();
  jadwalHariIni = data;
  document.getElementById("info-piket").textContent = data
    ? `Rumah ${data.nomor_rumah} · ${data.nama_warga}`
    : "Belum ada jadwal";
}

/* ---------------------------------------------------------------------
 * Setelah rumah terverifikasi: cek sudah upload atau belum.
 * pengganti = nomor rumah yang mengunci menggantikan petugas terjadwal.
 * ------------------------------------------------------------------- */
async function bukaUpload(jadwal, jalur, pengganti = null) {
  rumahTerverifikasi = { ...jadwal, pengganti };

  const { data: sudah, error } = await sb.rpc("sudah_upload", { p_nomor: jadwal.nomor_rumah });
  if (error) {
    toast("Gagal memeriksa status upload: " + error.message, "error");
    tampilPanel("panel-verifikasi");
    return;
  }
  if (sudah) return tampilSukses(jadwal.nomor_rumah);

  document.getElementById("label-jalur").textContent = jalur;
  document.getElementById("label-rumah").textContent = pengganti
    ? `${pengganti}, menggantikan ${jadwal.nomor_rumah}`
    : jadwal.nomor_rumah;
  document.getElementById("label-nama").textContent = jadwal.nama_warga;
  document.getElementById("label-nama-file").textContent = namaFile(jadwal.nomor_rumah);
  tampilPanel("panel-upload");
}

function tampilSukses(nomor) {
  document.getElementById("sukses-rumah").textContent = nomor;
  tampilPanel("panel-sukses");
}

/** Format nama file wajib: NomorRumah_TanggalHariIni.jpg */
function namaFile(nomor) {
  return `${nomor}_${HARI_INI}.jpg`;
}

/* ---------------------------------------------------------------------
 * A. JALUR UTAMA — token dari URL notifikasi
 * ------------------------------------------------------------------- */
async function cobaJalurToken(token) {
  const { data, error } = await sb.rpc("cek_token", { p_token: token });
  if (!error && data && data.length > 0) {
    await bukaUpload(data[0], "link notifikasi");
    return;
  }
  // Token kedaluwarsa / tidak valid → jatuh ke jalur cadangan
  const pesan = document.getElementById("pesan-token");
  pesan.innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-1"></i>Link notifikasi sudah tidak berlaku (hanya berlaku pada hari jadwal). Silakan verifikasi dengan nomor rumah.`;
  tampil("pesan-token", true);
  tampilPanel("panel-verifikasi");
}

/* ---------------------------------------------------------------------
 * B. JALUR CADANGAN — validasi nomor rumah ke jadwal_piket hari ini
 * ------------------------------------------------------------------- */
document.getElementById("panel-verifikasi").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nomor = normalisasiNomorRumah(document.getElementById("input-nomor-rumah").value);
  if (!nomor) return toast("Nomor rumah tidak valid.", "error");

  const pulihkan = tombolLoading(e.submitter || e.target.querySelector("button"), "Memeriksa...");
  try {
    const { data, error } = await sb
      .from("jadwal_piket")
      .select("nomor_rumah, nama_warga")
      .eq("tanggal", HARI_INI)
      .eq("nomor_rumah", nomor)
      .maybeSingle();
    if (error) throw error;

    if (data) {
      await bukaUpload(data, "nomor rumah");
      return;
    }

    // Bukan rumah terjadwal → tawarkan jadi PENGGANTI (hanya untuk warga terdaftar)
    await infoPiketSiap;
    const { data: terdaftar } = await sb.rpc("rumah_terdaftar", { p_nomor: nomor });
    calonPengganti = jadwalHariIni && terdaftar ? nomor : null;
    let pesan = `Rumah ${nomor} tidak terjadwal mengunci gerbang hari ini (${formatTanggal(HARI_INI)}).`;
    if (!jadwalHariIni) pesan += " Belum ada jadwal piket untuk hari ini.";
    else if (!terdaftar) pesan += ` Rumah ${nomor} juga tidak terdaftar sebagai warga, jadi tidak bisa menjadi pengganti.`;
    else pesan += ` Jika Anda yang mengunci gerbang menggantikan Rumah ${jadwalHariIni.nomor_rumah} (${jadwalHariIni.nama_warga}), silakan upload sebagai pengganti.`;

    document.getElementById("pesan-tolak").textContent = pesan;
    document.getElementById("label-pengganti").textContent = jadwalHariIni ? `Saya menggantikan Rumah ${jadwalHariIni.nomor_rumah}` : "";
    tampil("btn-pengganti", !!calonPengganti);
    tampilPanel("panel-tolak");
  } catch (err) {
    toast("Gagal memeriksa jadwal: " + err.message, "error");
  } finally {
    pulihkan();
  }
});

document.getElementById("btn-pengganti").addEventListener("click", async (e) => {
  if (!calonPengganti || !jadwalHariIni) return;
  const pulihkan = tombolLoading(e.currentTarget, "Memeriksa...");
  await bukaUpload(jadwalHariIni, "petugas pengganti", calonPengganti);
  pulihkan();
});

document.getElementById("btn-coba-lagi").addEventListener("click", () => {
  document.getElementById("input-nomor-rumah").value = "";
  tampilPanel("panel-verifikasi");
});

/* ---------------------------------------------------------------------
 * Pilih foto → beri watermark → kompres ke JPEG
 * ------------------------------------------------------------------- */
const BATAS_FOTO_LAMA_MENIT = 15; // foto lebih tua dari ini ditandai "dari galeri"

/** "Sabtu, 31 Oktober 2026 · 22:47:13 WIB" */
function teksWaktuWIB(date) {
  const tgl = new Intl.DateTimeFormat("id-ID", {
    timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(date);
  const jam = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(date);
  return `${tgl} · ${jam} WIB`;
}

/**
 * Susun baris-baris watermark. file.lastModified dipakai untuk mendeteksi
 * foto lama dari galeri (foto kamera langsung ≈ waktu sekarang).
 */
function barisWatermark(file) {
  const sekarang = new Date();
  const baris = [
    {
      teks: rumahTerverifikasi.pengganti
        ? `Rumah ${rumahTerverifikasi.pengganti} (pengganti ${rumahTerverifikasi.nomor_rumah}) · ${CFG.NAMA_CLUSTER}`
        : `Rumah ${rumahTerverifikasi.nomor_rumah} · ${CFG.NAMA_CLUSTER}`,
      tebal: true,
    },
    { teks: teksWaktuWIB(sekarang) },
  ];
  const umurMenit = (sekarang - (file.lastModified || sekarang)) / 60000;
  if (umurMenit > BATAS_FOTO_LAMA_MENIT) {
    baris.push({ teks: `Foto dari galeri, diambil ${teksWaktuWIB(new Date(file.lastModified))}`, peringatan: true });
  }
  return baris;
}

/** Gambar pita watermark semi-transparan di bagian bawah foto */
function gambarWatermark(ctx, lebar, tinggi, baris) {
  const ukuranFont = Math.max(14, Math.round(lebar * 0.032));
  const jarak = Math.round(ukuranFont * 1.35);
  const padding = Math.round(ukuranFont * 0.8);
  const tinggiPita = padding * 2 + jarak * baris.length;

  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(0, tinggi - tinggiPita, lebar, tinggiPita);

  ctx.textBaseline = "top";
  ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
  ctx.shadowBlur = 4;
  baris.forEach((b, i) => {
    ctx.font = `${b.tebal ? "700" : "500"} ${ukuranFont}px Inter, Arial, sans-serif`;
    ctx.fillStyle = b.peringatan ? "#fca5a5" : "#ffffff";
    ctx.fillText(b.teks, padding, tinggi - tinggiPita + padding + i * jarak, lebar - padding * 2);
  });
  ctx.shadowBlur = 0;
}

function kompresKeJpeg(file, baris) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const skala = Math.min(1, SISI_MAKS / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * skala);
      canvas.height = Math.round(img.height * skala);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; // latar putih untuk PNG transparan
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      if (baris) gambarWatermark(ctx, canvas.width, canvas.height, baris);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Gagal mengompres foto"))),
        "image/jpeg",
        KUALITAS_JPEG,
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("File bukan gambar yang valid")); };
    img.src = url;
  });
}

document.getElementById("input-foto").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) return toast("Pilih file gambar.", "error");

  try {
    const baris = barisWatermark(file);
    if (baris.some((b) => b.peringatan)) {
      toast("Foto ini sepertinya foto lama dari galeri. Sebaiknya ambil foto baru dengan kamera.", "info");
    }
    blobSiapUpload = await kompresKeJpeg(file, baris);
    const pratinjau = document.getElementById("pratinjau");
    pratinjau.src = URL.createObjectURL(blobSiapUpload);
    pratinjau.classList.remove("hidden");
    tampil("placeholder-foto", false);
    document.getElementById("btn-upload").disabled = false;
  } catch (err) {
    toast(err.message, "error");
  }
});

/* ---------------------------------------------------------------------
 * Upload ke Supabase Storage bucket "foto-gerbang" + catat log
 * ------------------------------------------------------------------- */
async function catatLog(nomor, path) {
  const baris = { nomor_rumah: nomor, tanggal: HARI_INI, path, diunggah_oleh: rumahTerverifikasi.pengganti || nomor };
  let { error } = await sb.from("bukti_gerbang").insert(baris);
  // Kolom diunggah_oleh belum ada (migrasi 004 belum dijalankan) → simpan tanpa kolom itu
  if (error?.code === "PGRST204" && !rumahTerverifikasi.pengganti) {
    delete baris.diunggah_oleh;
    ({ error } = await sb.from("bukti_gerbang").insert(baris));
  }
  // 23505 = duplicate key → log sudah ada, anggap sukses
  if (error && error.code !== "23505") throw error;
}

document.getElementById("btn-upload").addEventListener("click", async (e) => {
  if (!rumahTerverifikasi || !blobSiapUpload) return;
  const nomor = rumahTerverifikasi.nomor_rumah;
  const path = namaFile(nomor);
  const pulihkan = tombolLoading(e.currentTarget, "Mengunggah...");

  try {
    const { error: errUpload } = await sb.storage
      .from(CFG.BUCKET_FOTO)
      .upload(path, blobSiapUpload, {
        contentType: "image/jpeg",
        upsert: false,          // JANGAN timpa: cegah upload ganda
        cacheControl: "3600",
      });

    if (errUpload) {
      const pesan = String(errUpload.message || "").toLowerCase();
      const duplikat = String(errUpload.statusCode) === "409" || pesan.includes("exists") || pesan.includes("duplicate");
      if (duplikat) {
        // File sudah ada (mis. upload sebelumnya sukses tapi log gagal) → lengkapi log
        await catatLog(nomor, path);
        return tampilSukses(nomor);
      }
      // Ditolak policy: periksa apakah karena sudah upload
      const { data: sudah } = await sb.rpc("sudah_upload", { p_nomor: nomor });
      if (sudah) return tampilSukses(nomor);
      throw errUpload;
    }

    await catatLog(nomor, path);
    toast("Foto bukti berhasil diunggah!", "sukses");
    tampilSukses(nomor);
  } catch (err) {
    toast("Upload gagal: " + (err.message || err), "error");
  } finally {
    pulihkan();
  }
});

/* ---------------------------------------------------------------------
 * INISIALISASI
 * ------------------------------------------------------------------- */
(async function init() {
  infoPiketSiap = muatInfoPiket();
  const token = new URLSearchParams(location.search).get("token");
  if (token) {
    await cobaJalurToken(token.trim());
  } else {
    tampilPanel("panel-verifikasi");
  }
})();
