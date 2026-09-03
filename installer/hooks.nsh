; Хуки установщика Tauri/NSIS: всё, что отличает proxybox от обычного
; приложения, — служба Windows. Регистрирует и удаляет её сам pg-service.exe,
; чтобы параметры службы жили в одном месте с её кодом, а не в скрипте.
;
; Языков у установщика шесть, те же, что у продукта, и свои строки он выбирает
; сам — макросом PB_SAY, а не LangString. LangString тут не завести двумя
; способами сразу. Tauri включает этот файл в начале installer.nsi (строка 34),
; а языки грузит в конце (строка 470), так что ${LANG_RUSSIAN} на верхнем уровне
; ещё не определён; а внутри секции NSIS директиву LangString не принимает
; вовсе. Тело макроса, наоборот, разбирается в момент вставки — то есть уже
; внутри `Section Install`, где определено и то и другое. Строк тут пять, ради
; них таблица не нужна.
;
; Язык выбирает NSIS по языку системы, а не спрашивает: список в
; tauri.conf.json начинается с English, и незнакомая система получает его, а не
; русский.

!include LogicLib.nsh

Var PB_MSG

; Кладёт в $PB_MSG строку на языке установщика. Английский стоит до проверок, а
; не веткой ${Else}: язык, который в список добавили, а сюда забыли, покажет
; английскую строку, а не пустую.
!macro PB_SAY _ru _en _fa _zh _tr _id
  StrCpy $PB_MSG "${_en}"
  ${If} $LANGUAGE = ${LANG_RUSSIAN}
    StrCpy $PB_MSG "${_ru}"
  ${ElseIf} $LANGUAGE = ${LANG_FARSI}
    StrCpy $PB_MSG "${_fa}"
  ${ElseIf} $LANGUAGE = ${LANG_SIMPCHINESE}
    StrCpy $PB_MSG "${_zh}"
  ${ElseIf} $LANGUAGE = ${LANG_TURKISH}
    StrCpy $PB_MSG "${_tr}"
  ${ElseIf} $LANGUAGE = ${LANG_INDONESIAN}
    StrCpy $PB_MSG "${_id}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Пока служба работает, заняты и её exe, и sing-box рядом: NSIS отвечает на
  ; `File` окном «Error opening file for writing», и исправное обновление
  ; выглядит сломанным установщиком. Своё окно Tauri закрывает сам
  ; (CheckIfAppIsRunning), но сайдкары ему неизвестны — гасим службу здесь, до
  ; копирования файлов. `net stop` вместо `sc stop`: второй возвращает
  ; управление на STOP_PENDING, то есть ровно тогда, когда файлы ещё заняты.
  ; Вместе со службой уходит и её sing-box — она сама его убивает при остановке,
  ; сама же снимает и правила брандмауэра.
  ;
  ; Останавливаем, но не удаляем: удалённую службу SCM держит помеченной
  ; MARKED_FOR_DELETE, пока открыт хоть один дескриптор, и регистрация после
  ; установки упёрлась бы в это до перезагрузки.
  !insertmacro PB_SAY \
    "Остановка службы proxybox на время установки..." \
    "Stopping the proxybox service for the duration of the install..." \
    "توقف سرویس proxybox در طول نصب..." \
    "安装期间停止 proxybox 服务..." \
    "Kurulum süresince proxybox hizmeti durduruluyor..." \
    "Menghentikan layanan proxybox selama pemasangan..."
  DetailPrint $PB_MSG
  nsExec::ExecToLog 'net stop proxybox'
  ; Код не проверяем: «служба не установлена» и «уже остановлена» — норма, а
  ; настоящую занятость файла установщик покажет сам.
  Pop $0

  ; Служба под прошлым именем продукта. Её нельзя оставлять: она стартует с
  ; системой, поднимает свой sing-box на тот же TUN и ставит свой замок в
  ; брандмауэр. Две службы на один туннель и один singbox.pid — это машина, где
  ; правила ставит одна, а снимает другая.
  ;
  ; Порядок обязателен. `net stop` идёт первым, потому что снятие правил висит
  ; на обработчике остановки: удалить незапущенную службу значит оставить её
  ; разрешения в брандмауэре навсегда. Метла новой службы такие сироты подметает
  ; (LEGACY_RULE_PREFIX в core-filter), но полагаться на второй рубеж, когда
  ; первый бесплатен, незачем.
  ;
  ; Удаляем её, в отличие от своей: MARKED_FOR_DELETE мешает зарегистрировать
  ; службу с тем же именем, а мы регистрируем другое.
  !insertmacro PB_SAY \
    "Удаление службы под прошлым именем..." \
    "Removing the service registered under the previous name..." \
    "حذف سرویس با نام پیشین..." \
    "删除以旧名称注册的服务..." \
    "Önceki adla kayıtlı hizmet kaldırılıyor..." \
    "Menghapus layanan dengan nama lama..."
  DetailPrint $PB_MSG
  nsExec::ExecToLog 'net stop PrivacyGateway'
  Pop $0
  nsExec::ExecToLog 'sc delete PrivacyGateway'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro PB_SAY \
    "Регистрация службы proxybox..." \
    "Registering the proxybox service..." \
    "ثبت سرویس proxybox..." \
    "正在注册 proxybox 服务..." \
    "proxybox hizmeti kaydediliyor..." \
    "Mendaftarkan layanan proxybox..."
  DetailPrint $PB_MSG
  nsExec::ExecToLog '"$INSTDIR\pg-service.exe" install'
  Pop $0
  ${If} $0 != 0
    ; Про права администратора здесь не пишем: установка поверх существующей
    ; службы теперь проходит, так что отказ означает уже что-то другое, и
    ; отправлять человека перезапускать установщик — врать ему.
    !insertmacro PB_SAY \
      "Не удалось зарегистрировать службу (код $0).$\r$\nБез неё приватный режим работать не будет.$\r$\nПричина — в журнале установки. Поднять вручную: sc start proxybox" \
      "Failed to register the service (code $0).$\r$\nWithout it private mode will not work.$\r$\nThe reason is in the install log. To start it by hand: sc start proxybox" \
      "ثبت سرویس ناموفق بود (کد $0).$\r$\nبدون آن حالت خصوصی کار نخواهد کرد.$\r$\nدلیل در گزارش نصب است. اجرای دستی: sc start proxybox" \
      "注册服务失败（代码 $0）。$\r$\n没有它，隐私模式无法工作。$\r$\n原因见安装日志。手动启动：sc start proxybox" \
      "Hizmet kaydedilemedi (kod $0).$\r$\nO olmadan gizli kip çalışmaz.$\r$\nNedeni kurulum günlüğünde. Elle başlatmak için: sc start proxybox" \
      "Gagal mendaftarkan layanan (kode $0).$\r$\nTanpa itu mode privat tidak akan bekerja.$\r$\nPenyebabnya ada di log pemasangan. Menjalankan manual: sc start proxybox"
    MessageBox MB_ICONEXCLAMATION $PB_MSG
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Остановка службы снимает блокирующие правила брандмауэра. Если пропустить
  ; этот шаг, выбранные приложения останутся без сети, а снимать блокировку
  ; будет уже нечем.
  !insertmacro PB_SAY \
    "Остановка и удаление службы..." \
    "Stopping and removing the service..." \
    "توقف و حذف سرویس..." \
    "正在停止并删除服务..." \
    "Hizmet durduruluyor ve kaldırılıyor..." \
    "Menghentikan dan menghapus layanan..."
  DetailPrint $PB_MSG
  nsExec::ExecToLog '"$INSTDIR\pg-service.exe" uninstall'
  Pop $0
!macroend
