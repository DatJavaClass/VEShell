@echo off
REM Headless unit test for parseSegments (src/verbose-parse.js). Pure JS, but run
REM under Electron's ABI as a Node runtime to match the other headless suites.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\node_modules\.bin\electron.cmd" "%~dp0verbose-parse.test.js"
endlocal
