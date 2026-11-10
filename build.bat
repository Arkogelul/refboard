@echo off
REM ================================================================
REM  RefBoard - build.bat (pas d'exe)
REM  Publie le site : ce dossier EST le depot Arkogelul/refboard, servi par
REM  GitHub Pages (branche main) -> https://arkogelul.github.io/refboard/
REM  Envoie les commits deja faits ; refuse s'il reste des changements non
REM  commites. L'extension se recharge dans chrome://extensions.
REM ================================================================
chcp 65001 >nul
cd /d "%~dp0"
for /f %%L in ('git status --porcelain ^| find /c /v ""') do set "N=%%L"
if not "%N%"=="0" (
    echo [ECHEC] %N% fichier^(s^) modifie^(s^) non commite^(s^) :
    git status --short
    echo Commite d'abord, puis relance build.bat.
    pause & exit /b 1
)
git fetch -q origin
for /f %%L in ('git rev-list --count origin/main..main') do set "A=%%L"
if "%A%"=="0" ( echo [OK] Rien a publier : le site en ligne est a jour. & pause & exit /b 0 )
echo %A% commit^(s^) a publier :
git log --oneline origin/main..main
set /p "R=Publier en ligne ? (o/n) "
if /I not "%R%"=="o" ( echo Annule. & pause & exit /b 1 )
git push origin main || ( echo [ECHEC] Envoi refuse. & pause & exit /b 1 )
echo [OK] Publie. GitHub Pages met le site a jour en une minute environ.
pause
