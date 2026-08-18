; Хуки установщика Tauri/NSIS: всё, что отличает Privacy Gateway от обычного
; приложения, — служба Windows. Регистрирует и удаляет её сам pg-service.exe,
; чтобы параметры службы жили в одном месте с её кодом, а не в скрипте.

!include LogicLib.nsh

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Регистрация службы Privacy Gateway..."
  nsExec::ExecToLog '"$INSTDIR\pg-service.exe" install'
  Pop $0
  ${If} $0 != 0
    ; Про права администратора здесь не пишем: установка поверх существующей
    ; службы теперь проходит, так что отказ означает уже что-то другое, и
    ; отправлять человека перезапускать установщик — врать ему.
    MessageBox MB_ICONEXCLAMATION "Не удалось зарегистрировать службу (код $0).$\r$\nБез неё приватный режим работать не будет.$\r$\nПричина — в журнале установки. Поднять вручную: sc start PrivacyGateway"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Остановка службы снимает блокирующие правила брандмауэра. Если пропустить
  ; этот шаг, выбранные приложения останутся без сети, а снимать блокировку
  ; будет уже нечем.
  DetailPrint "Остановка и удаление службы..."
  nsExec::ExecToLog '"$INSTDIR\pg-service.exe" uninstall'
  Pop $0
!macroend
