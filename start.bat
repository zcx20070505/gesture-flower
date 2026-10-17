@echo off
REM ===========================================================================
REM  Launcher shim.  Do NOT put non-ASCII text in this file:
REM  cmd.exe parses .bat using the system ANSI codepage, so UTF-8 Chinese
REM  would be mangled and can break parsing.
REM  All real logic (and all Chinese UI text) lives in launcher.ps1,
REM  which PowerShell reads as UTF-8 correctly.
REM ===========================================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1"
if errorlevel 1 pause
