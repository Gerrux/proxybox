; Своих строк для индонезийского у Tauri нет вовсе (`get_lang_data` в
; tauri-bundler знает двадцать с небольшим языков, и этого среди них нет), а
; NSIS-файл языка есть — Indonesian.nlf. Без этого файла кнопки и заголовки
; самой NSIS перевелись бы, а сообщения Tauri остались бы пустыми: неопределённая
; LangString не ошибка сборки, а тишина в окне.
;
; Набор строк и их имена — из tauri-bundler, languages/English.nsh.
; `{{product_name}}` не трогать: его подменяет сам Tauri в рантайме
; (`CheckIfAppIsRunning` в utils.nsh), а `$0`, `$1`, `$R4` и `$\n` — переменные
; NSIS.
LangString addOrReinstall ${LANG_INDONESIAN} "Tambah/Instal ulang komponen"
LangString alreadyInstalled ${LANG_INDONESIAN} "Sudah Terinstal"
LangString alreadyInstalledLong ${LANG_INDONESIAN} "${PRODUCTNAME} ${VERSION} sudah terinstal. Pilih tindakan yang ingin Anda lakukan lalu klik Berikutnya untuk melanjutkan."
LangString appRunning ${LANG_INDONESIAN} "{{product_name}} sedang berjalan! Tutup dulu aplikasinya, lalu coba lagi."
LangString appRunningOkKill ${LANG_INDONESIAN} "{{product_name}} sedang berjalan!$\nKlik OK untuk menghentikannya"
LangString chooseMaintenanceOption ${LANG_INDONESIAN} "Pilih tindakan pemeliharaan yang akan dilakukan."
LangString choowHowToInstall ${LANG_INDONESIAN} "Pilih cara Anda ingin menginstal ${PRODUCTNAME}."
LangString createDesktop ${LANG_INDONESIAN} "Buat pintasan di desktop"
LangString dontUninstall ${LANG_INDONESIAN} "Jangan hapus instalasi"
LangString dontUninstallDowngrade ${LANG_INDONESIAN} "Jangan hapus instalasi (penurunan versi tanpa menghapus instalasi dinonaktifkan pada penginstal ini)"
LangString failedToKillApp ${LANG_INDONESIAN} "Gagal menghentikan {{product_name}}. Tutup dulu aplikasinya, lalu coba lagi"
LangString installingWebview2 ${LANG_INDONESIAN} "Menginstal WebView2..."
LangString newerVersionInstalled ${LANG_INDONESIAN} "Versi ${PRODUCTNAME} yang lebih baru sudah terinstal! Menginstal versi yang lebih lama tidak disarankan. Jika Anda tetap ingin menginstal versi lama ini, sebaiknya hapus instalasi versi saat ini terlebih dahulu. Pilih tindakan yang ingin Anda lakukan lalu klik Berikutnya untuk melanjutkan."
LangString older ${LANG_INDONESIAN} "lebih lama"
LangString olderOrUnknownVersionInstalled ${LANG_INDONESIAN} "Versi $R4 dari ${PRODUCTNAME} terinstal di sistem Anda. Disarankan menghapus instalasi versi saat ini sebelum menginstal. Pilih tindakan yang ingin Anda lakukan lalu klik Berikutnya untuk melanjutkan."
LangString silentDowngrades ${LANG_INDONESIAN} "Penurunan versi dinonaktifkan pada penginstal ini, jadi mode senyap tidak dapat dilanjutkan. Gunakan penginstal dengan antarmuka grafis.$\n"
LangString unableToUninstall ${LANG_INDONESIAN} "Tidak dapat menghapus instalasi!"
LangString uninstallApp ${LANG_INDONESIAN} "Hapus instalasi ${PRODUCTNAME}"
LangString uninstallBeforeInstalling ${LANG_INDONESIAN} "Hapus instalasi sebelum menginstal"
LangString unknown ${LANG_INDONESIAN} "tidak diketahui"
LangString webview2AbortError ${LANG_INDONESIAN} "Gagal menginstal WebView2! Aplikasi tidak dapat berjalan tanpanya. Coba jalankan ulang penginstal."
LangString webview2DownloadError ${LANG_INDONESIAN} "Kesalahan: gagal mengunduh WebView2 - $0"
LangString webview2DownloadSuccess ${LANG_INDONESIAN} "Bootstrapper WebView2 berhasil diunduh"
LangString webview2Downloading ${LANG_INDONESIAN} "Mengunduh bootstrapper WebView2..."
LangString webview2InstallError ${LANG_INDONESIAN} "Kesalahan: instalasi WebView2 gagal dengan kode keluar $1"
LangString webview2InstallSuccess ${LANG_INDONESIAN} "WebView2 berhasil diinstal"
LangString deleteAppData ${LANG_INDONESIAN} "Hapus data aplikasi"
