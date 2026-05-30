@echo off
REM Headless launch-chain smoke test: node-pty (ConPTY) -> powershell -> claude.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\node_modules\.bin\electron.cmd" "%~dp0pty-chain.test.js"
endlocal
