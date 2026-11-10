@echo off
REM  RefBoard : sert le site en local (http://localhost:8791) et l'ouvre.
REM  La version en ligne : https://arkogelul.github.io/refboard/
cd /d "%~dp0"
start "" http://localhost:8791/
python -m http.server 8791
