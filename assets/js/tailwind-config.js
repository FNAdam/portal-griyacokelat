/* Konfigurasi tema Tailwind (Play CDN) — palet "cokelat" untuk seluruh halaman */
tailwind.config = {
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#fbf7f4", 100: "#f3e9e1", 200: "#e6d0c0", 300: "#d4b096", 400: "#bf8b69",
          500: "#a8704e", 600: "#8f5a3d", 700: "#744734", 800: "#5f3b2e", 900: "#4f3228",
        },
      },
      fontFamily: { sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"] },
    },
  },
};
