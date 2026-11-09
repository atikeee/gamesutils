@echo off
setlocal enabledelayedexpansion

echo =======================================================
echo   FunHub - Build and Install Script
echo =======================================================
echo.

set GRADLE_CMD=gradle
if exist "gradlew.bat" set GRADLE_CMD=gradlew.bat

call %GRADLE_CMD% --stop >nul 2>&1
echo [1/3] Building FunHub APK...
call %GRADLE_CMD% assembleDebug
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build failed! Check errors above.
    pause
    exit /b %ERRORLEVEL%
)

set APK_PATH=C:\tmp\FunHub\app\outputs\apk\debug\app-debug.apk
if not exist "%APK_PATH%" set APK_PATH=app\build\outputs\apk\debug\app-debug.apk

set "DEFAULT_TV_IP="
if exist "%~dp0tv_ip.txt" set /p DEFAULT_TV_IP=<"%~dp0tv_ip.txt"
set "TV_IP="
set /p TV_IP="Enter Android TV IP [Press ENTER for %DEFAULT_TV_IP%]: "
if "%TV_IP%"=="" set "TV_IP=%DEFAULT_TV_IP%"
if "%TV_IP%"=="" (
    echo [ERROR] Set an IP in tv_ip.txt or enter one at the prompt.
    pause
    exit /b 1
)

echo [2/3] Connecting ADB to %TV_IP%:5555...
adb connect %TV_IP%:5555

echo [3/3] Installing APK onto TV...
adb install -r "%APK_PATH%"

if %ERRORLEVEL% EQU 0 (
    adb shell am start -n com.rahmanma.gamesutils.catan/.MainActivity
    echo =======================================================
    echo   SUCCESS! FunHub is running on your TV.
    echo =======================================================
) else (
    echo [ERROR] Installation failed.
)

pause
