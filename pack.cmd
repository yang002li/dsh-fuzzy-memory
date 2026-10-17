@echo off
chcp 65001 >nul
set "ROOT=D:\DeepSeek-Harness-Portable-0.2.0-rc.2"
set "HERE=%~dp0"
"%ROOT%\node.exe" "%HERE%tools\pack.mjs"
pause
