# Сборка на Windows

Собирается только на Windows: Tauri тянет WebView2, служба — WinAPI. На Linux
доступны ядро (`cargo test --workspace`) и фронтенд; `cargo check --workspace
--target x86_64-pc-windows-msvc` проверяет и windows-ветки кода, но не линкует.

## Что нужно

- Rust + MSVC Build Tools, WebView2 Runtime (на Windows 11 уже есть)
- `cargo install tauri-cli --version "^2"`
- Node + pnpm 9+
- `sing-box.exe` для Windows — [релизы](https://github.com/SagerNet/sing-box/releases),
  вместе с файлом `LICENSE` из того же архива

## Сборка

```powershell
mkdir src-tauri\binaries
copy путь\к\sing-box\LICENSE src-tauri\binaries\LICENSE-sing-box.txt
pwsh installer\build.ps1 -SingBox путь\к\sing-box.exe
```

Скрипт собирает `pg-service.exe` и `privacy-gateway.exe`, раскладывает их с
суффиксом целевой платформы в `src-tauri\binaries\` (так Tauri ожидает
sidecar-бинарники), затем собирает окно и установщик NSIS в
`src-tauri\target\release\bundle\nsis\`.

Для arm64: `-Triple aarch64-pc-windows-msvc` и sing-box соответствующей сборки.

## Выпуск

```bash
# версия живёт в одном месте — окно берёт её оттуда же и по ней сравнивает
# себя со списком релизов
git commit -am "версия 0.2.0"   # правка version в src-tauri/tauri.conf.json
git tag v0.2.0 && git push --tags
```

Дальше `.github/workflows/release.yml` на windows-latest прогоняет тесты,
собирает тем же `installer/build.ps1` (sing-box скачивается сам) и кладёт
установщик в релиз GitHub. Тег обязан совпадать с версией из `tauri.conf.json` —
иначе сборка падает первым же шагом, до долгой части.

Подписи в CI нет: сертификат — свойство машины сборки. Нужна подписанная
сборка — собирайте `build.ps1 -Thumbprint …` у себя и заливайте файл в релиз
руками.

## Что делает установщик

Ставит per-machine в `Program Files`, кладёт рядом окно, службу, CLI и sing-box,
затем вызывает `pg-service.exe install` — регистрация службы `PrivacyGateway`
(LocalSystem, автозапуск) и её немедленный старт. Удаление вызывает
`pg-service.exe uninstall`: остановка службы, снятие блокирующих правил
брандмауэра, удаление из SCM.

## Проверка после установки

```powershell
sc query PrivacyGateway
"C:\Program Files\Privacy Gateway\privacy-gateway.exe" doctor
"C:\Program Files\Privacy Gateway\privacy-gateway.exe" status
```

## Подпись

```powershell
# отпечаток сертификата в хранилище машины
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Select-Object Thumbprint, Subject
pwsh installer\build.ps1 -Thumbprint 0123456789ABCDEF0123456789ABCDEF01234567
```

Отпечаток передаётся параметром, а не лежит в `tauri.conf.json`: сертификат —
свойство машины сборки, а не репозитория. `sidecars.ps1` подписывает службу и
CLI до упаковки, Tauri — окно и сам установщик. Нужен `signtool` из Windows SDK
в `PATH`.

Без `-Thumbprint` сборка проходит, но SmartScreen предупредит при установке —
скрипт об этом скажет. `sing-box.exe` подписан своим издателем; пересобирать и
подписывать его самим вы вправе, это GPL-бинарник.
