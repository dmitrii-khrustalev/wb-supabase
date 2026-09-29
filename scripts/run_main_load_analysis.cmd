@echo off
setlocal
cd /d "%~dp0\.."
where py >nul 2>&1 && (
  py -3 scripts\main_load_analysis.py
  goto :done
)
where python >nul 2>&1 && (
  python scripts\main_load_analysis.py
  goto :done
)
echo Python не найден. Установите Python 3 и добавьте в PATH, или используйте: py -3 scripts\main_load_analysis.py
exit /b 1
:done
exit /b %errorlevel%
