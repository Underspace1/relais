@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Node portable fourni dans le dossier "node", sinon Node installé sur le PC.
set "NODE=%~dp0node\node.exe"
if not exist "%NODE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   Node.js introuvable. Installe-le depuis https://nodejs.org puis relance.
    echo.
    pause
    exit /b 1
  )
  set "NODE=node"
)

start "" http://127.0.0.1:4321
"%NODE%" server.js
pause
