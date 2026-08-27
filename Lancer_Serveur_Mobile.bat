@echo off
cd /d "%~dp0"
echo ============================================
echo  Estimateur de renovation - version mobile
echo ============================================
echo.
echo Adresses IP de ce PC (utilisez-en une depuis votre telephone, sur le meme Wi-Fi) :
ipconfig | findstr /R /C:"IPv4"
echo.
echo Ouvrez ensuite sur votre telephone : http://VOTRE_IP:8000
echo (Puis "Ajouter a l'ecran d'accueil" dans le menu du navigateur.)
echo.
python -m http.server 8000
