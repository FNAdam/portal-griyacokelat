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

let rumahTerverifikasi = null; // { nomor_rumah, nama_warga }
let blobSiapUpload = null;     // hasil kompres JPEG

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
  document.getElementById("info-piket").textContent = data
    ? `Rumah ${data.nomor_rumah} · ${data.nama_warga}`
    : "Belum ada jadwal";
}

/* ---------------------------------------------------------------------
 * Setelah rumah terverifikasi: cek sudah upload atau belum
 * ------------------------------------------------------------------- */
async function bukaUpload(jadwal, jalur) {
  rumahTerverifikasi = jadwal;

  const { data: sudah, error } = await sb.rpc("sudah_upload", { p_nomor: jadwal.nomor_rumah });
  if (error) {
    toast("Gagal memeriksa status upload: " + error.message, "error");
    tampilPanel("panel-verifikasi");
    return;
  }
  if (sudah) return tampilSukses(jadwal.nomor_rumah);

  document.getElementById("label-jalur").textContent = jalur;
  document.getElementById("label-rumah").textContent = jadwal.nomor_rumah;
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
    } else {
      document.getElementById("pesan-tolak").textContent =
        `Rumah ${nomor} tidak terjadwal mengunci gerbang hari ini (${formatTanggal(HARI_INI)}).`;
      tampilPanel("panel-tolak");
    }
  } catch (err) {
    toast("Gagal memeriksa jadwal: " + err.message, "error");
  } finally {
    pulihkan();
  }
});

document.getElementById("btn-coba-lagi").addEventListener("click", () => {
  document.getElementById("input-nomor-rumah").value = "";
  tampilPanel("panel-verifikasi");
});

/* ---------------------------------------------------------------------
 * Pilih foto → kompres ke JPEG (agar sesuai ekstensi .jpg & hemat storage)
 * ------------------------------------------------------------------- */
function kompresKeJpeg(file) {
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
    blobSiapUpload = await kompresKeJpeg(file);
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
  const { error } = await sb.from("bukti_gerbang").insert({ nomor_rumah: nomor, tanggal: HARI_INI, path });
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
  muatInfoPiket();
  const token = new URLSearchParams(location.search).get("token");
  if (token) {
    await cobaJalurToken(token.trim());
  } else {
    tampilPanel("panel-verifikasi");
  }
})();
