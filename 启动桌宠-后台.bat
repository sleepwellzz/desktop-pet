@echo off
rem ============================================================
rem  desktop-pet : build, then start with NO console window.
rem
rem  Difference from the other startup script:
rem    that one keeps a console (the pet dies with it);
rem    this one builds visibly, then launches the pet directly --
rem    the pet lives in the system tray. Quit from the tray menu.
rem
rem  Log file: %USERPROFILE%\.desktop-pet\pet.log
rem
rem  Keep ASCII-only: cmd reads .bat as GBK, Chinese breaks syntax.
rem ============================================================
cd /d "%~dp0"
set "PATH=%PATH%;C:\Program Files\nodejs"
rem The host injects this; it would turn Electron into plain Node.
set ELECTRON_RUN_AS_NODE=

echo ==========================================
echo  desktop-pet : build then start (silent)
echo ==========================================
echo.
echo [1/2] building TypeScript (about 30s)...
call npm.cmd run build
if errorlevel 1 goto :fail

rem Measured 2026-09-18/21, three launch methods, 3 processes each, window closed
rem with taskkill (no /F, same as clicking X):
rem   start "" electron.exe            -> ALL KILLED  (the pet dies with the window)
rem   powershell Start-Process         -> ALL SURVIVE <-- this is what we use
rem   node detached:true (DETACHED_PROCESS) -> ALL SURVIVE
rem The old script needed a black window only because it went through
rem `npm start` -> node.exe.
rem
rem NOTE: this file must stay ASCII-only. cmd reads .bat as GBK and Chinese
rem comment text gets parsed as commands (this actually broke the script once).
echo.
echo [2/2] starting the pet (no console window, lives in the tray).
echo       This window closes itself in 3 seconds.
echo       Log: %USERPROFILE%\.desktop-pet\pet.log
echo.
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0node_modules\electron\dist\electron.exe' -ArgumentList '%CD%' -WorkingDirectory '%CD%'"
if errorlevel 1 goto :fail2

timeout /t 3 /nobreak >nul
exit /b 0

:fail
echo.
echo BUILD FAILED - send the message above to Buddy.
pause
exit /b 1

:fail2
echo.
echo START FAILED - could not launch electron.exe.
pause
exit /b 1
