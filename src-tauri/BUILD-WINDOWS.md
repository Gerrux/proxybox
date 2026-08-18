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

Установщик и бинарники не подписаны — SmartScreen будет ругаться. Для выпуска
нужен сертификат Authenticode: подписать `pg-service.exe`,
`privacy-gateway.exe`, `Privacy Gateway.exe` перед сборкой бандла и сам
установщик после. `sing-box.exe` подписан уже (или пересобирается и
подписывается вами — это GPL-бинарник, менять его вы вправе).
