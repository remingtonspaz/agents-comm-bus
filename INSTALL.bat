@echo off
title agents-comm-bus Telegram Plugin Installer

node install.js
if errorlevel 1 (
  pause
  exit /b 1
)

pause
