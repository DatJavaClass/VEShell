@echo off
REM Headless pty stability/stress suite (resize storm, output flood, spawn/kill
REM churn, long lines, unicode). Runs under Electron's ABI as a Node runtime.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\node_modules\.bin\electron.cmd" "%~dp0stress.test.js"
endlocal
