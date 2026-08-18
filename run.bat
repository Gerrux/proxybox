@echo off
rem ===========================================================================
rem  Privacy Gateway - launcher для Windows: проверка окружения + запуск.
rem  Двойной клик или: run.bat
rem ===========================================================================
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Privacy Gateway launcher

echo ==========================================================
echo   Privacy Gateway  -  проверка окружения и запуск
echo ==========================================================
echo.
echo [1/3] Обязательные компоненты...
echo.

set "MISSING="
call :check "Node.js"    "node -v"         "https://nodejs.org  (LTS 20+)"
call :check "pnpm"       "pnpm -v"         "npm i -g pnpm"
call :check "Rust/cargo" "cargo --version" "https://rustup.rs"

rem --- права: службе нужны админские (TUN и правила брандмауэра) ---
net session >nul 2>nul
if errorlevel 1 (
  set "ELEVATED="
  echo   [ ! ]  права обычного пользователя - служба НЕ поднимет TUN и не поставит
  echo          правила брандмауэра. Для пунктов 1 и 2 запустите run.bat от
  echo          имени администратора ^(правый клик - "Запуск от имени администратора"^).
) else (
  set "ELEVATED=1"
  echo   [OK]   права администратора
)

echo.
if defined MISSING (
  echo ----------------------------------------------------------
  echo  Не хватает компонентов ^(см. [НЕТ] выше^). Установите их
  echo  по подсказкам и запустите run.bat снова.
  echo ----------------------------------------------------------
  echo.
  pause
  exit /b 1
)

echo [2/3] Подготовка...
echo.
set "SINGBOX=%CD%\src-tauri\binaries\sing-box.exe"
if not exist "%SINGBOX%" (
  echo   - sing-box не найден. Без него туннель не поднимется.
  set "GET="
  set /p "GET=    Скачать с github.com/SagerNet/sing-box сейчас? [Y/n]: "
  if /i not "!GET!"=="n" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "installer\get-singbox.ps1"
    if errorlevel 1 ( echo   ОШИБКА загрузки sing-box. & echo. & pause & exit /b 1 )
  ) else (
    echo   Положите sing-box.exe в src-tauri\binaries\ вручную.
  )
) else (
  echo   - sing-box на месте.
)
echo   - зависимости ^(pnpm install^)...
call pnpm install
if errorlevel 1 ( echo   ОШИБКА pnpm install. & echo. & pause & exit /b 1 )
echo.

echo [3/3] Что запустить?
echo ==========================================================
echo     [1] Служба + окно приложения ^(Tauri dev^)
echo     [2] Служба + интерфейс в браузере ^(http://127.0.0.1:5173^)
echo     [3] Собрать установщик ^(NSIS^)
echo     [4] Тесты ядра ^(cargo test^)
echo     [5] Проверка окружения ^(privacy-gateway doctor^)
echo ==========================================================
set "CHOICE="
set /p "CHOICE=Выбор [2]: "
if "%CHOICE%"=="" set "CHOICE=2"

if "%CHOICE%"=="1" goto :dev_tauri
if "%CHOICE%"=="2" goto :dev_browser
if "%CHOICE%"=="3" goto :build
if "%CHOICE%"=="4" ( echo. & call cargo test --workspace & goto :end )
if "%CHOICE%"=="5" goto :doctor
echo Неизвестный выбор: %CHOICE%
goto :end

rem ---------------------------------------------------------------------------
:service
rem Служба поднимается в отдельном окне: она должна жить, пока работает интерфейс.
call cargo build -p pg-service -p pg-cli
if errorlevel 1 ( echo   ОШИБКА сборки службы. & exit /b 1 )
echo   - служба запускается в отдельном окне ^(закройте его, чтобы остановить^)
rem chcp в новом окне обязателен: без него русский вывод службы превращается
rem в мусор — окно от start наследует кодовую страницу системы, а не эту.
start "Privacy Gateway - служба" cmd /k "chcp 65001 >nul && set PG_SINGBOX=%SINGBOX%&& target\debug\pg-service.exe"
rem Дать службе занять порт до первого запроса от интерфейса.
timeout /t 2 >nul
exit /b 0

:dev_tauri
call :tauri_precheck
if errorlevel 1 goto :end
call :service
if errorlevel 1 goto :end
echo. & echo Окно Tauri ^(dev^). Ctrl+C - выход.
call cargo tauri dev
goto :end

:dev_browser
call :service
if errorlevel 1 goto :end
echo.
echo Откройте http://127.0.0.1:5173/  - дев-сервер сам ходит в службу.
echo Ctrl+C - выход.
echo.
call pnpm --filter app-shell dev
goto :end

:build
call :tauri_precheck
if errorlevel 1 goto :end
echo. & echo Сборка установщика...
powershell -NoProfile -ExecutionPolicy Bypass -File "installer\build.ps1"
goto :end

:doctor
call cargo build -p pg-cli
set "PG_SINGBOX=%SINGBOX%"
echo.
call target\debug\privacy-gateway.exe doctor
goto :end

rem ---------------------------------------------------------------------------
:tauri_precheck
cargo tauri --version >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Tauri CLI не найден. Установите:
  echo      cargo install tauri-cli --version "^^2"
  echo  Также нужны WebView2 Runtime ^(на Win11 обычно есть^) и
  echo  VS Build Tools ^(MSVC, C++^).  Подробности: src-tauri\BUILD-WINDOWS.md
  echo.
  exit /b 1
)
exit /b 0

rem ---------------------------------------------------------------------------
:check
rem %~1=имя  %~2=команда-версии  %~3=подсказка по установке
for /f "delims=" %%v in ('%~2 2^>nul') do (
  echo   [OK]   %~1: %%v
  exit /b 0
)
echo   [НЕТ]  %~1 - установка: %~3
set "MISSING=1"
exit /b 0

rem ---------------------------------------------------------------------------
:end
echo.
pause
exit /b 0
