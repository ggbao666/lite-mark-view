@echo off
rem ============================================================
rem  LiteMark View - one-click build for Windows
rem  Double-click this file, or run:  build.bat [-n]
rem    -n  = do not pause at the end (for CI / scripted calls)
rem  Output: build\bin\LiteMarkView.exe
rem ============================================================
setlocal EnableExtensions
cd /d "%~dp0"
title LiteMark View Build

echo ==========================================
echo  LiteMark View - one-click build
echo ==========================================
echo.

where go >nul 2>nul
if errorlevel 1 (echo [ERROR] Go not found in PATH. & goto fail)
where node >nul 2>nul
if errorlevel 1 (echo [ERROR] Node.js not found in PATH. & goto fail)
where npm >nul 2>nul
if errorlevel 1 (echo [ERROR] npm not found in PATH. & goto fail)

echo [1/5] Resolving Wails CLI ...
for /f "delims=" %%i in ('go env GOPATH') do set "GOPATH_DIR=%%i"
set "WAILS=%GOPATH_DIR%\bin\wails.exe"
rem Read the Wails version from go.mod so this never goes stale.
set "WAILS_VER=v2.17.1"
for /f "tokens=2" %%v in ('findstr /c:"github.com/wailsapp/wails/v2 v" go.mod') do set "WAILS_VER=%%v"
if not exist "%WAILS%" (
  echo       Installing wails@%WAILS_VER% ...
  go install github.com/wailsapp/wails/v2/cmd/wails@%WAILS_VER%
  if errorlevel 1 goto fail
)
if not exist "%WAILS%" (
  echo [ERROR] Wails CLI is still missing: %WAILS%
  goto fail
)
echo       Wails: %WAILS%

echo [2/5] Checking frontend dependencies ...
if not exist "frontend\node_modules" (
  pushd frontend
  call npm install
  if errorlevel 1 (popd & goto fail)
  popd
)

echo [3/5] Rebuilding frontend ...
rem Move the old dist out of the way instead of deleting it. Deleting a
rem directory with 100+ files trips some guarded shells, and leftover
rem hashed assets would otherwise be embedded into the exe.
if exist "frontend\dist" (
  move "frontend\dist" "%TEMP%\litemark-dist-%RANDOM%%RANDOM%" >nul 2>nul
  if errorlevel 1 echo       [WARN] Could not move old dist; Vite will clean it.
)
pushd frontend
call npm run build
if errorlevel 1 (popd & goto fail)
popd

echo [4/5] Compiling Windows executable ...
rem -s: frontend is already built above, so skip the second Vite pass.
"%WAILS%" build -s -o LiteMarkView.new.exe
if errorlevel 1 goto fail
if not exist "build\bin\LiteMarkView.new.exe" (
  echo [ERROR] Build finished but output file was not found.
  goto fail
)

echo [5/5] Publishing build\bin\LiteMarkView.exe ...
rem If the old exe is running, Windows locks it. Never kill the user's
rem process: keep the fresh build under a different name instead.
move /Y "build\bin\LiteMarkView.new.exe" "build\bin\LiteMarkView.exe" >nul 2>nul
if errorlevel 1 (
  echo       [WARN] LiteMarkView.exe is in use - close the running app first.
  echo       Fresh build kept at: build\bin\LiteMarkView.new.exe
  goto done
)
echo.
findstr /c:"productVersion" wails.json
echo       OK: %CD%\build\bin\LiteMarkView.exe
goto done

:fail
echo.
echo [FAILED] Build did not complete.
set "EXITCODE=1"
goto finish

:done
set "EXITCODE=0"

:finish
echo.
if /i "%~1"=="-n" goto skip_pause
pause
:skip_pause
endlocal & exit /b %EXITCODE%
