Unicode true
RequestExecutionLevel user
ManifestDPIAware true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
Name "lolPing Desktop Pilot"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\lolPing Desktop Pilot"
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "lolPing Desktop Pilot"
VIAddVersionKey /LANG=1033 "FileDescription" "lolPing Desktop Pilot Setup"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "lolPing contributors"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\lolPingDesktopPilot"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\lolping-desktop-pilot.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${LICENSE_FILE}"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "TradChinese"
!include "${STRINGS_FILE}"
Var Test
Var Parameters
Var WaitPid
Var Guard
Var Restart
Var HadApp
Var HadHelper

Function .onInit
  SetShellVarContext current
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(PilotWindows)" /SD IDOK
    SetErrorLevel 5
    Abort
  ${EndIf}
  SetRegView 64
  StrCpy $Test 0
  StrCpy $Restart 0
  ${GetParameters} $Parameters
  ClearErrors
  ${GetOptions} $Parameters "/TEST" $0
  ${IfNot} ${Errors}
    StrCpy $Test 1
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    ReadRegStr $0 HKLM "Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $Test == 1
    ClearErrors
    ${GetOptions} $Parameters "/TEST_NO_WEBVIEW" $1
    ${IfNot} ${Errors}
      StrCpy $0 ""
    ${EndIf}
  ${EndIf}
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(PilotWebView)" /SD IDOK
    SetErrorLevel 4
    Abort
  ${EndIf}
  ClearErrors
  ${GetOptions} $Parameters "/RESTART" $0
  ${IfNot} ${Errors}
    StrCpy $Restart 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $Parameters "/PID=" $WaitPid
  ${If} $WaitPid != ""
    IntCmp $WaitPid 0 wait_done wait_invalid wait_open
    wait_invalid:
      SetErrorLevel 2
      Abort
    wait_open:
      System::Call 'kernel32::OpenProcess(i 0x100000, i 0, i $WaitPid) p.r0'
      ${If} $0 P<> 0
        System::Call 'kernel32::WaitForSingleObject(p r0, i 30000) i.r1'
        System::Call 'kernel32::CloseHandle(p r0)'
        ${If} $1 != 0
          SetErrorLevel 2
          Abort
        ${EndIf}
      ${EndIf}
  ${EndIf}
  wait_done:
  StrCpy $0 "Local\com.lolping.desktop-pilot"
  ${If} $Test == 1
    StrCpy $0 "Local\com.lolping.desktop-pilot.installer-test"
  ${EndIf}
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w r0) p.r1 ?e'
  Pop $2
  StrCpy $Guard $1
  ${If} $Guard P= 0
  ${OrIf} $2 == 183
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(PilotQuitFirst)" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd

Section
  SetOutPath "$INSTDIR"
  CreateDirectory "$INSTDIR\.previous"
  StrCpy $HadApp 0
  StrCpy $HadHelper 0
  IfFileExists "$INSTDIR\lolping-desktop-pilot.exe" 0 +2
    StrCpy $HadApp 1
  IfFileExists "$INSTDIR\hook-helper.exe" 0 +2
    StrCpy $HadHelper 1
  ${If} $HadApp == 1
    System::Call 'kernel32::CopyFileW(w "$INSTDIR\lolping-desktop-pilot.exe", w "$INSTDIR\.previous\lolping-desktop-pilot.exe", i 0) i.r0'
    ${If} $0 == 0
      SetErrorLevel 3
      Abort
    ${EndIf}
  ${EndIf}
  ${If} $HadHelper == 1
    System::Call 'kernel32::CopyFileW(w "$INSTDIR\hook-helper.exe", w "$INSTDIR\.previous\hook-helper.exe", i 0) i.r0'
    ${If} $0 == 0
      SetErrorLevel 3
      Abort
    ${EndIf}
  ${EndIf}
  ClearErrors
  SetOverwrite try
  File "${APP_EXE}"
  File "${HELPER_EXE}"
  File "${LICENSE_FILE}"
  ${If} ${Errors}
    ${If} $HadApp == 1
      System::Call 'kernel32::CopyFileW(w "$INSTDIR\.previous\lolping-desktop-pilot.exe", w "$INSTDIR\lolping-desktop-pilot.exe", i 0)'
    ${Else}
      Delete "$INSTDIR\lolping-desktop-pilot.exe"
    ${EndIf}
    ${If} $HadHelper == 1
      System::Call 'kernel32::CopyFileW(w "$INSTDIR\.previous\hook-helper.exe", w "$INSTDIR\hook-helper.exe", i 0)'
    ${Else}
      Delete "$INSTDIR\hook-helper.exe"
    ${EndIf}
    SetErrorLevel 3
    Abort
  ${EndIf}
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  FileOpen $0 "$INSTDIR\desktop-pilot.json" w
  FileWrite $0 '{$\"schema$\":1,$\"appId$\":$\"com.lolping.desktop-pilot$\",$\"runtime$\":$\"tauri$\",$\"installed$\":true,$\"version$\":$\"${VERSION}$\",$\"test$\":$Test}$\r$\n'
  FileClose $0
  ${If} $Test == 1
    FileOpen $0 "$INSTDIR\.test-install" w
    FileClose $0
  ${Else}
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "lolPing Desktop Pilot"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
    CreateShortcut "$SMPROGRAMS\lolPing Desktop Pilot.lnk" "$INSTDIR\lolping-desktop-pilot.exe"
  ${EndIf}
  Delete "$INSTDIR\.previous\lolping-desktop-pilot.exe"
  Delete "$INSTDIR\.previous\hook-helper.exe"
  RMDir "$INSTDIR\.previous"
SectionEnd

Function .onInstSuccess
  System::Call 'kernel32::CloseHandle(p $Guard)'
  StrCpy $Guard 0
  ${If} $Restart == 1
  ${AndIf} $Test == 0
    Exec '$\"$INSTDIR\lolping-desktop-pilot.exe$\" --hidden'
  ${EndIf}
FunctionEnd

Function .onGUIEnd
  ${If} $Guard P<> 0
    System::Call 'kernel32::CloseHandle(p $Guard)'
  ${EndIf}
FunctionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
  StrCpy $0 "Local\com.lolping.desktop-pilot"
  IfFileExists "$INSTDIR\.test-install" 0 +2
    StrCpy $0 "Local\com.lolping.desktop-pilot.installer-test"
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w r0) p.r1 ?e'
  Pop $2
  StrCpy $Guard $1
  ${If} $Guard P= 0
  ${OrIf} $2 == 183
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(PilotQuitFirst)" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd

Section "Uninstall"
  IfFileExists "$INSTDIR\.test-install" un_files
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "lolPing Desktop Pilot"
  ${If} $0 == '$\"$INSTDIR\lolping-desktop-pilot.exe$\" --hidden'
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "lolPing Desktop Pilot"
  ${EndIf}
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $0 == "$INSTDIR"
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
    Delete "$SMPROGRAMS\lolPing Desktop Pilot.lnk"
  ${EndIf}
  un_files:
  Delete "$INSTDIR\lolping-desktop-pilot.exe"
  Delete "$INSTDIR\hook-helper.exe"
  Delete "$INSTDIR\desktop-pilot.json"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\.test-install"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  System::Call 'kernel32::CloseHandle(p $Guard)'
SectionEnd
