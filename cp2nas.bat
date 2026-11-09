@echo off
setlocal enabledelayedexpansion

if "%~1"=="" (
    echo Usage: cp2nas static/css/mm*
    exit /b 1
)

:: Use the argument as given, converting backslashes to forward slashes
set "SRC=%~1"
set "SRC=!SRC:\=/!"

:: Strip the filename/wildcard part, keeping the folder with its trailing slash
set "DIR=!SRC!"
:strip
if not defined DIR goto done
if "!DIR:~-1!"=="/" goto done
set "DIR=!DIR:~0,-1!"
goto strip
:done

set "DEST=atik-nas@ugc:/docker/t/!DIR!"

echo scp -r %~1 !DEST!
scp -r %~1 "!DEST!"

endlocal
