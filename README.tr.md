<p align="center">
  <img src="docs/brand/mark.png" width="88" alt="">
</p>

<h1 align="center">proxybox</h1>

<p align="center">Baştan başa tek bir delik açılmış bir gövde: trafiğin tam olarak bir çıkışı var, o da bizim.</p>

<p align="center"><a href="https://gerrux.github.io/proxybox/">Site</a> · <a href="https://github.com/Gerrux/proxybox/releases">İndir</a> · <a href="docs/">Belgeler</a> · <a href="docs/brand.md">Marka</a></p>

<p align="center"><a href="README.md">Русский</a> · <a href="README.en.md">English</a> · <a href="README.fa.md">فارسی</a> · <a href="README.zh.md">简体中文</a> · <b>Türkçe</b> · <a href="README.id.md">Bahasa Indonesia</a></p>

**Giden trafiğin fail-closed denetimi.** Seçtiğiniz programlar ağa yalnızca sizin
tünelinizden çıkar; tünel yoksa ağ da yoktur. Diğer uygulamaların trafiğine hiç
dokunulmaz.

Windows 10/11. Çalışma alanı crate'lerinde bir Rust çekirdeği, üstünde bir
hizmet, Tauri 2.x masaüstü kabuğu ve Vite + React + TS + Tailwind ön yüzü.
Arayüz, hizmet ve kurulum programı altı dil konuşuyor.

Özgün teknik şartname (Rusça) — [proxybox-prompt.md](proxybox-prompt.md).

![proxybox penceresi](docs/interface.png)

Pencerenin gösterdiği en önemli şey durumdur, bu yüzden üstü o kaplar. Başlığın
altında yolun kendisi çizilidir: seçili uygulamalardan ağa. Tünel ayaktayken
üzerinde çizgiler ilerler; tünel yokken kanal kesilmiş ve hareketsizdir.

![Tünel yok — erişim kapalı](docs/interface-failclosed.png)

Kapalı erişim kırmızı değil kehribar rengidir ve bu bir zevk meselesi değil:
fail-closed **çalışırken** tam olarak böyle görünmelidir — kırmızı olsaydı
uygulamanın arızası gibi okunurdu. Kırmızı tek bir şeye ayrıldı: hizmet yanıt
vermiyor ya da kurallar oturmadı, yani gerçekten bozuldu ve insan gerekiyor.
Uygulama satırları da aynı rengi taşır — her birinin şu an başına ne geldiği,
listenin durduğu yerde görünür.

Diller altı tane: Rusça, İngilizce, Farsça, Çince, Türkçe ve Endonezce. Anahtar
ayarlarda, başlık çubuğundaki düğmenin ardında; dili hizmet saklar, bu yüzden
günlük de pencereyle birlikte değişir.

![İngilizce arayüz](docs/interface-en.png)

## Değişmez

Gizli kip açık + tünel doğrulanmamış = seçili uygulamaların ağı yok. Doğrudan
erişimli ara durumlar yoktur, bypass kuralı da yoktur. Mimarideki diğer her şey
bunun sonucudur.

Kapsam iki tanedir ve pencere başlığında, kanalın sol ucunda seçilir. **Beyaz
liste** — ağ yalnızca seçili uygulamalarda ve yalnızca tünel üzerinden.
**Tüm bilgisayar** — hiç ayıklama yok, arkasında süreç olmayan trafik de tünele
girer: hizmet, sürücü, DNS. Değişmez aynıdır, yalnızca kimi kapsadığı değişir.

Ayıklama tünel yapılandırmasında değil, Windows güvenlik duvarında yaşar ve
`connect` anında, herhangi bir TUN'dan önce olur. sing-box yapılandırması her iki
kapsamda bayt bayt aynıdır ve içinde tüneli atlayan bir rota hiç yoktur — bu
yüzden kapsamı değiştirmek ve uygulama listesini düzenlemek tüneli yeniden
başlatmaz: açık bir SSH oturumu bunları atlatır.

```
                 evet ───────────► izinler verildi, trafik tünele giriyor
SOCKS5 yoklama ──┤
                 hayır ──────────► izin yok: seçili uygulamaların da ağı yok
```

İçeride nasıl çalıştığı — [docs/how-it-works.md](docs/how-it-works.md).

## Kurulum

Hazır kurulum programı [sürümlerde](https://github.com/Gerrux/proxybox/releases).
NSIS, per-machine, altı dil: pencereyi, hizmeti, CLI'yi ve sing-box'ı tek bir
klasöre koyar ve `proxybox` hizmetini LocalSystem altında, otomatik başlatmayla
kaydeder. Ürünün kendi ağı yoktur — tünel sizin kendi sunucunuzdur.

Ayrıntılar, güncellemeler ve yanınızdaki başka bir VPN — [docs/install.md](docs/install.md).

## Windows'ta hızlı başlangıç

`run.bat` dosyasına çift tıklayın — ortamı denetler, gerekirse sing-box'ı
indirir, bağımlılıkları kurar ve şunları önerir: hizmeti uygulama penceresiyle
başlatmak, hizmeti arayüzü tarayıcıda açarak başlatmak, kurulum programını
derlemek, testleri koşturmak ya da ortamı denetlemek (`doctor`).

Hizmete yönetici hakları gerekir — TUN ve güvenlik duvarı kuralları başka türlü
kurulmaz; haklar olmadan başlatıldığında `run.bat` bunu söyler.

## İlkeler

- **Fail-closed:** doğrudan erişimli ara durumlar yoktur. Tünel yoksa DROP.
  Hiçbir bypass kuralı yok.
- **Ayrıcalıklar yalnızca hizmette.** GUI ve CLI, sıradan bir kullanıcı olarak
  çalışan ince `core-ipc` istemcileridir, kendi durumları yoktur. Windows'ta
  bağlantı, erişim listesi olan adlandırılmış bir boru üzerinden gider: SYSTEM ve
  yöneticiler tam, etkileşimli kullanıcılar okuma ve yazma, düşük bütünlüklü
  süreçler (tarayıcı kum havuzları) hiç. Durum dizini de aynı biçimde kilitlidir:
  `state.json` içinde tüm profillerin parolaları ve anahtarları durur.
- **Dışarıya tek bir adres, o da kapatılabilir:** ne telemetri var ne de trafik
  günlüğü. Yoklama kullanıcının kendi sunucusuna gider. Tek üçüncü taraf, çıkış
  noktası sorulan `ip-api.com`'dur ve soru **tünel üzerinden** sorulur: servis
  sizin adresinizi değil, sunucunuzun adresini görür. "Ülkeyi sor" ayarıyla ya da
  `PG_GEO=0` ile kapanır. Pencere güncellemeler için `api.github.com`'a yalnızca
  düğmeye basıldığında gider — kendiliğinden ve arka planda asla.
- Ön yüzde **TS strict**.

## Belgeler

| | |
| --- | --- |
| [Nasıl çalışır](docs/how-it-works.md) | tünel, sing-box yapılandırması, güvenlik duvarı, DNS, ilkelerin tamamı |
| [Windows'a kurulum](docs/install.md) | kurulum programı, güncellemeler, hizmetin hatırladıkları, yanındaki yabancı VPN |
| [Profiller, abonelikler ve ölçüm](docs/profiles.md) | bağlantı ve abonelik içe aktarma, Clash YAML, düğüm ölçümü |
| [Tarayıcı profilleri](docs/browser-profiles.md) | ayrı tarayıcı oturumları ve bir sitenin onlardan gördüğü |
| [Pencere](docs/interface.md) | bağlantılar, dil, tepsi ve küçük pano, ayarlar |
| [Geliştirme](docs/development.md) | crate yapısı, komutlar, değişkenler, bir şey çalışmadığında |
| [Henüz olmayanlar](docs/limitations.md) | bilinen delikler, hatanın bedeline göre sıralı |
| [Marka](docs/brand.md) | işaret, dolgular, koruma alanı, yasaklar |
| [WFP: hesaplandı ama alınmadı](docs/wfp.md) | neden kendi süzgecimiz yok |

Belgeler Rusça yazılır: bu projede kaynak dil Rusçadır ve çevirilerin anahtarı da
odur. Yalnızca README çevrilmiştir.

Kurulum programını derlemek ve yayımlamak — [src-tauri/BUILD-WINDOWS.md](src-tauri/BUILD-WINDOWS.md).
