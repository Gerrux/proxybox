<p align="center">
  <img src="docs/brand/mark.png" width="88" alt="">
</p>

<h1 align="center">proxybox</h1>

<p align="center">Sebuah bodi pejal dengan satu lubang tembus: lalu lintas punya tepat satu jalan keluar, dan jalan itu milik kita.</p>

<p align="center"><a href="https://gerrux.github.io/proxybox/">Situs</a> · <a href="https://github.com/Gerrux/proxybox/releases">Unduh</a> · <a href="docs/">Dokumentasi</a> · <a href="docs/brand.md">Identitas</a></p>

<p align="center"><a href="README.md">Русский</a> · <a href="README.en.md">English</a> · <a href="README.fa.md">فارسی</a> · <a href="README.zh.md">简体中文</a> · <a href="README.tr.md">Türkçe</a> · <b>Bahasa Indonesia</b></p>
<p align="center">
  <a href="https://github.com/Gerrux/proxybox/releases/latest"><img alt="" src="https://img.shields.io/github/v/release/Gerrux/proxybox?style=flat-square&labelColor=14161A&color=2E4BD8"></a>
  <a href="https://github.com/Gerrux/proxybox/actions/workflows/ci.yml"><img alt="" src="https://img.shields.io/github/actions/workflow/status/Gerrux/proxybox/ci.yml?branch=master&style=flat-square&labelColor=14161A&label=ci"></a>
  <a href="LICENSE"><img alt="" src="https://img.shields.io/github/license/Gerrux/proxybox?style=flat-square&labelColor=14161A&color=1E9E5A"></a>
  <img alt="" src="https://img.shields.io/badge/Windows-10%20%7C%2011-14161A?style=flat-square">
  <img alt="" src="https://img.shields.io/badge/i18n-ru%20en%20fa%20zh%20tr%20id-14161A?style=flat-square">
</p>

**Kendali lalu lintas keluar dengan prinsip fail-closed.** Program yang Anda
pilih hanya bisa menjangkau jaringan lewat terowongan Anda sendiri; tidak ada
terowongan, tidak ada jaringan. Lalu lintas aplikasi lain sama sekali tidak
disentuh.

Windows 10/11. Inti Rust dalam crate workspace, sebuah layanan di atasnya,
cangkang desktop Tauri 2.x, dan frontend Vite + React + TS + Tailwind. Antarmuka,
layanan, dan penginstal sama-sama berbicara enam bahasa.

Spesifikasi asli (bahasa Rusia) — [proxybox-prompt.md](proxybox-prompt.md).

![Jendela proxybox](docs/interface.png)

Status adalah hal utama yang ditampilkan jendela, karena itu ia menempati bagian
atas. Di bawah judul tergambar jalurnya sendiri: dari aplikasi terpilih menuju
jaringan. Selama terowongan hidup, garis-garis berjalan di sepanjangnya; ketika
tidak ada terowongan, saluran terputus dan diam.

![Tidak ada terowongan — akses tertutup](docs/interface-failclosed.png)

Akses yang tertutup berwarna kuning ambar, bukan merah, dan itu bukan soal
selera: begitulah fail-closed **seharusnya terlihat ketika ia bekerja** — dengan
merah ia akan terbaca sebagai kegagalan aplikasi. Merah tersisa untuk satu hal
saja: layanan tidak menjawab atau aturan tidak terpasang, artinya benar-benar
rusak dan butuh orang. Baris aplikasi memakai warna yang sama — apa yang sedang
terjadi pada masing-masing terlihat di tempat daftarnya berada.

Bahasanya ada enam: Rusia, Inggris, Persia, Tionghoa, Turki, dan Indonesia.
Pengalihnya ada di pengaturan, di balik tombol pada bilah judul; bahasa disimpan
oleh layanan, jadi jurnal ikut beralih bersama jendela.

![Antarmuka bahasa Inggris](docs/interface-en.png)

## Invarian

Mode privat menyala + terowongan belum terkonfirmasi = aplikasi terpilih tanpa
jaringan. Keadaan antara dengan akses langsung tidak ada, aturan bypass juga
tidak ada. Semua hal lain dalam arsitektur adalah akibat dari ini.

Cakupannya ada dua, dipilih di kepala jendela, di ujung kiri saluran. **Daftar
putih** — jaringan hanya untuk aplikasi terpilih dan hanya lewat terowongan.
**Seluruh komputer** — tidak ada penyaringan sama sekali: lalu lintas yang tidak
punya proses di belakangnya pun masuk ke terowongan — layanan, driver, DNS.
Invariannya sama, yang berubah hanya siapa yang terkena.

Penyaringan tidak tinggal di konfigurasi terowongan, melainkan di firewall
Windows, dan terjadi pada `connect`, sebelum TUN apa pun. Konfigurasi sing-box
persis sama bita demi bita pada kedua cakupan, dan di dalamnya sama sekali tidak
ada rute yang melewati terowongan — karena itu mengganti cakupan dan menyunting
daftar aplikasi tidak memulai ulang terowongan: sesi SSH yang terbuka selamat
melaluinya.

```
                 ya ─────────────► izin diberikan, lalu lintas masuk ke terowongan
Uji SOCKS5 ──────┤
                 tidak ──────────► tidak ada izin: aplikasi terpilih pun tanpa jaringan
```

Bagaimana ia bekerja di dalam — [docs/how-it-works.md](docs/how-it-works.md).

## Pemasangan

Penginstal siap pakai ada di [rilis](https://github.com/Gerrux/proxybox/releases).
NSIS, per-machine, enam bahasa: ia menaruh jendela, layanan, CLI, dan sing-box
dalam satu folder lalu mendaftarkan layanan `proxybox` di bawah LocalSystem
dengan mulai otomatis. Produk ini tidak punya jaringan sendiri — terowongannya
adalah server Anda sendiri.

Rincian, pembaruan, dan hidup berdampingan dengan VPN lain — [docs/install.md](docs/install.md).

## Mulai cepat di Windows

Klik ganda `run.bat` — ia memeriksa lingkungan, mengunduh sing-box bila perlu,
memasang dependensi, lalu menawarkan: menjalankan layanan dengan jendela
aplikasi, menjalankan layanan dengan antarmuka di peramban, membangun
penginstal, menjalankan pengujian, atau memeriksa lingkungan (`doctor`).

Layanan butuh hak administrator — tanpa itu TUN dan aturan firewall tidak bisa
dipasang; `run.bat` akan memperingatkan bila dijalankan tanpa hak tersebut.

## Prinsip

- **Fail-closed:** keadaan antara dengan akses langsung tidak ada. Tidak ada
  terowongan — DROP. Tidak ada aturan bypass.
- **Hak istimewa hanya di layanan.** GUI dan CLI adalah klien tipis `core-ipc`
  yang berjalan sebagai pengguna biasa, tanpa status sendiri. Di Windows
  sambungannya lewat named pipe dengan daftar akses: SYSTEM dan administrator
  penuh, pengguna interaktif baca dan tulis, proses berintegritas rendah (sandbox
  peramban) sama sekali tidak. Direktori status dikunci dengan cara yang sama: di
  dalam `state.json` tersimpan kata sandi dan kunci semua profil.
- **Ke luar hanya satu alamat, dan itu pun bisa dimatikan:** tidak ada telemetri,
  tidak ada log lalu lintas. Uji koneksi menuju server pengguna sendiri. Satu-
  satunya pihak ketiga adalah `ip-api.com`, yang ditanyai titik keluar, dan
  ditanyai **lewat terowongan**: layanan itu melihat alamat server Anda, bukan
  alamat Anda. Dimatikan lewat pengaturan «tanyakan negara» atau `PG_GEO=0`.
  Jendela menghubungi `api.github.com` untuk pembaruan hanya saat tombolnya
  ditekan — tidak pernah sendiri, tidak pernah di latar belakang.
- **TS strict** di frontend.

## Dokumentasi

| | |
| --- | --- |
| [Langkah pertama](docs/quickstart.md) | dari jendela kosong ke terowongan yang jalan, dan apa yang dilakukan bila gagal |
| [Cara kerjanya](docs/how-it-works.md) | terowongan, konfigurasi sing-box, firewall, DNS, prinsip selengkapnya |
| [Pemasangan di Windows](docs/install.md) | penginstal, pembaruan, apa yang diingat layanan, VPN lain di sebelah |
| [Profil, langganan, dan pengujian](docs/profiles.md) | impor tautan dan langganan, Clash YAML, mengukur node |
| [Profil peramban](docs/browser-profiles.md) | sesi peramban terpisah dan apa yang dilihat situs tentangnya |
| [Jendela](docs/interface.md) | koneksi, bahasa, baki sistem dan panelnya, pengaturan |
| [Pengembangan](docs/development.md) | susunan crate, perintah, variabel, bila ada yang tidak jalan |
| [Yang belum ada](docs/limitations.md) | lubang yang diketahui, diurut menurut harga kesalahannya |
| [Identitas](docs/brand.md) | lambang, isian warna, ruang aman, larangan |
| [WFP: dihitung, tidak diambil](docs/wfp.md) | mengapa tidak ada filter buatan sendiri |

Dokumentasi ditulis dalam bahasa Rusia: Rusia adalah bahasa sumber proyek ini
sekaligus kunci pencarian terjemahannya. Hanya README yang diterjemahkan.

Membangun dan merilis penginstal — [src-tauri/BUILD-WINDOWS.md](src-tauri/BUILD-WINDOWS.md).

## Ikut membantu

Proyek ini dibangun di Linux tetapi hanya berjalan di Windows, jadi dua hal yang
paling berguna sekarang: laporan tentang apa yang sebenarnya terjadi di mesin
sungguhan, dan pembacaan ulang terjemahan — tidak satu pun di antaranya, selain
bahasa Inggris, pernah dibaca penutur aslinya. Selebihnya ada di
[CONTRIBUTING.md](CONTRIBUTING.md). Lubang privasi atau hak akses tidak ditulis
sebagai issue publik: lihat [SECURITY.md](SECURITY.md).

## Lisensi

[GPL-3.0-or-later](LICENSE).
