@echo off
setlocal
title pdfx - PDF 编辑与 OCR

rem ============================================================
rem  pdfx 启动器  (Windows)
rem
rem  双击本文件           启动空白编辑器，可在界面里新建或打开 PDF
rem  把 PDF 拖到本文件上   直接打开该 PDF
rem  想换端口             改下面这行 PORT 的数字
rem  环境自检             在命令行执行： 启动PDF工具.bat -check
rem
rem  注意：本文件必须保存为 GBK / ANSI 编码，不能用 UTF-8。
rem        cmd 按字节偏移读取批处理，UTF-8 中文会让行错位。
rem        源文件见 tools/launch.bat.src（UTF-8），
rem        改完跑 python tools/build_bat.py 重新生成。
rem ============================================================

set "PORT=8765"

rem ---- 切到脚本所在目录（换机器、换位置都不用改路径）----
cd /d "%~dp0"
set "ROOT=%CD%"

if not exist "%ROOT%\pdfx\__init__.py" (
    echo.
    echo   [x] 没有找到程序文件：%ROOT%\pdfx
    echo       请把本脚本放在 pdfx 项目根目录下再双击。
    echo.
    pause
    exit /b 1
)

set "PYTHONPATH=%ROOT%"
set "PYTHONIOENCODING=utf-8"

rem ---- 找 Python ----
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY (
    where py >nul 2>nul
    if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
    echo.
    echo   [x] 没有找到 Python。
    echo       请安装 Python 3.9 或更高版本，安装时勾选 "Add Python to PATH"。
    echo.
    pause
    exit /b 1
)

rem ---- 校验依赖 ----
%PY% -c "import fitz" >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [x] 缺少 PyMuPDF 依赖（本工具唯一的必需库）。
    echo       请执行：  %PY% -m pip install pymupdf
    echo.
    pause
    exit /b 2
)

rem ---- 参数分流 ----
set "FILE=%~1"
if /i "%FILE%"=="-check" goto :check
if /i "%FILE%"=="--check" goto :check
if /i "%FILE%"=="-h" goto :help
if /i "%FILE%"=="/?" goto :help
if /i "%FILE%"=="--help" goto :help

rem ---- 端口已被占用（多半是上次的窗口还开着）----
netstat -ano | findstr /c:":%PORT% " | findstr /i "LISTENING" >nul 2>nul
if errorlevel 1 goto :launch

%PY% -m pdfx probe --port %PORT% >nul 2>nul
if errorlevel 4 goto :port_other
if errorlevel 3 goto :stale
echo.
echo   [i] 端口 %PORT% 上已经有 pdfx 在运行（版本一致），直接为你打开。
echo.
start "" "http://127.0.0.1:%PORT%/"
exit /b 0

:stale
echo.
echo   [!] 端口 %PORT% 上跑的是旧版本的 pdfx。
echo       新功能（橡皮擦页面内容、拖动缩放等）不会生效——前端会调不到新接口。
echo.
echo       注意：旧服务里未保存的文档会随进程一起丢失。
echo.
set /p "ANS=   现在关掉旧服务并启动新版本？(Y/N) "
if /i not "%ANS%"=="Y" (
    echo.
    echo   已取消，先打开旧服务。想看新功能请手动关掉那个黑窗口后再双击本文件。
    start "" "http://127.0.0.1:%PORT%/"
    exit /b 0
)
call :kill_port
goto :launch

:port_other
echo.
echo   [i] 端口 %PORT% 被别的程序占用了（不是 pdfx）。
echo       请改本文件顶部的 PORT，或先关掉那个程序。
echo.
pause
exit /b 0

:kill_port
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%PORT% " ^| findstr /i "LISTENING"') do (
    echo   [i] 结束旧服务进程 PID %%p
    taskkill /pid %%p /t /f >nul 2>nul
)
rem 等端口真正释放（ping 比 timeout 在各类 shell 里都稳）
ping -n 2 127.0.0.1 >nul
exit /b 0

:launch

rem ---- 启动 ----
echo.
echo   ==========================================================
echo    pdfx  -  PDF 编辑与扫描件 OCR
echo   ==========================================================
echo    地址：http://127.0.0.1:%PORT%/
if defined FILE echo    文件：%FILE%
echo.
echo    浏览器会自动打开。关闭本窗口即停止服务。
echo   ==========================================================
echo.

if not defined FILE goto :serve_blank
if not exist "%FILE%" (
    echo   [!] 找不到文件：%FILE%
    echo       改为启动空白编辑器。
    echo.
    goto :serve_blank
)
%PY% -m pdfx serve "%FILE%" --port %PORT%
goto :done

:serve_blank
%PY% -m pdfx serve --port %PORT%

:done
echo.
echo   [i] 服务已退出。
echo.
pause
exit /b 0

:check
echo.
echo   [ok] 目录：%ROOT%
for /f "delims=" %%v in ('%PY% -c "import sys;print(sys.version.split()[0])" 2^>nul') do echo   [ok] Python %%v  ^(%PY%^)
for /f "delims=" %%v in ('%PY% -c "import fitz;print(fitz.VersionBind)" 2^>nul') do echo   [ok] PyMuPDF %%v
for /f "delims=" %%v in ('%PY% -c "import flask;print(flask.__version__)" 2^>nul') do echo   [ok] Flask %%v
echo   [ok] 端口：%PORT%
echo.
echo   环境可用，双击本文件即可启动。
echo.
pause
exit /b 0

:help
echo.
echo   pdfx 启动器用法
echo   ------------------------------------------------
echo    双击本文件            启动空白编辑器
echo    拖 PDF 到本文件上     直接打开该 PDF
echo    启动PDF工具.bat -check  只检查环境，不启动服务
echo.
echo   命令行等价写法：
echo     python -m pdfx serve "D:\某个文件.pdf" --port %PORT%
echo.
pause
exit /b 0
