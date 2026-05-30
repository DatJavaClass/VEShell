@echo off
REM End-to-end clipboard/keyboard/edge-case suite (real Electron GUI, hidden
REM window, plain-PowerShell prompt so pasted text echoes for verification).
setlocal
set VESHELL_E2E=1
set VESHELL_SHELLARGS=["-NoLogo","-NoProfile"]
"%~dp0..\node_modules\.bin\electron.cmd" "%~dp0.."
endlocal
