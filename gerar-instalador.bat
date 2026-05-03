@echo off
if not "%1"=="run" (
    start cmd /k "%~f0" run
    exit
)

cd /d "%~dp0app-desktop"

echo.
echo === OportuniDocs - Gerar Instalador ===
echo.

echo [1/3] Instalando dependencias...
call npm install
if %errorlevel% neq 0 ( echo ERRO no npm install & pause & exit )

echo.
echo [2/3] Compilando...
call npm run build
if %errorlevel% neq 0 ( echo ERRO no build & pause & exit )

echo.
echo [3/3] Gerando .exe...
rem Desativa a assinatura de codigo (signtool nao esta configurado)
set CSC_IDENTITY_AUTO_DISCOVERY=false
set WIN_CSC_LINK=
set CSC_LINK=
call npm run build:win
if %errorlevel% neq 0 ( echo ERRO no build:win & pause & exit )

echo.
echo Copiando instalador para a pasta principal...
set COPIED=0
for %%f in ("dist\*Setup*.exe") do ( copy /Y "%%f" "%~dp0" >nul & set COPIED=1 )
if %COPIED%==0 for %%f in ("dist-electron\*Setup*.exe") do ( copy /Y "%%f" "%~dp0" >nul & set COPIED=1 )
if %COPIED%==0 for %%f in ("dist\*.exe") do ( copy /Y "%%f" "%~dp0" >nul & set COPIED=1 )

echo.
echo === PRONTO! O instalador .exe esta na pasta principal. ===
echo.
pause
