@echo off
chcp 65001 > nul

:START_SERVERS
cls
echo ========================================
echo   IoT Glossary Server Manager
echo ========================================
echo [1/2] Starting backend server window...
cd /d "C:\Users\smh13\Iot Glossary\server"
start "Backend_Server" cmd /k "npm run dev -- --remote"

echo [2/2] Starting frontend server window...
cd /d "C:\Users\smh13\Iot Glossary\client"
start "Frontend_Server" cmd /k "npm run dev"

cd /d "C:\Users\smh13\Iot Glossary"

echo.
echo Waiting for backend server port 8787...
:CHECK_BACKEND
timeout /t 1 > nul
netstat -ano | findstr :8787 | findstr LISTENING > nul
if errorlevel 1 goto CHECK_BACKEND

echo [OK] Backend server is ready!

echo Waiting for frontend server port 5173...
:CHECK_FRONTEND
timeout /t 1 > nul
netstat -ano | findstr :5173 | findstr LISTENING > nul
if errorlevel 1 goto CHECK_FRONTEND

echo [OK] Frontend server is ready!

echo ========================================
echo All servers started successfully!
echo - Press [R] to Restart all servers
echo - Press [Q] to Quit all servers
echo ========================================

:GET_INPUT
:: PowerShell로 키를 읽어올 때 Alt, Control 등의 제어 키 단독 입력은 무시하고 오직 문자 R과 Q만 허용
for /f "delims=" %%i in ('powershell -Command "$k = $host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown'); if ($k.VirtualKeyCode -eq 82 -or $k.VirtualKeyCode -eq 81) { [string]$k.Character }"') do set "USER_CHOICE=%%i"

if /i "%USER_CHOICE%"=="R" goto DO_RESTART
if /i "%USER_CHOICE%"=="Q" goto DO_QUIT
goto GET_INPUT

:DO_RESTART
echo.
echo Restarting servers...
call :KILL_SERVERS
goto START_SERVERS

:DO_QUIT
echo.
echo Quitting servers...
call :KILL_SERVERS
echo All servers have been terminated.
timeout /t 1 > nul
exit

:KILL_SERVERS
:: 8787, 5173 포트를 사용하는 프로세스 강제 종료
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8787') do (
    taskkill /f /pid %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5173') do (
    taskkill /f /pid %%a >nul 2>&1
)
taskkill /f /im node.exe >nul 2>&1

:: 기존에 열려 있던 Backend_Server 및 Frontend_Server 타이틀을 가진 CMD 창들을 확실하게 강제 종료
powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and ($_.CommandLine -like '*Backend_Server*' -or $_.CommandLine -like '*Frontend_Server*' -or $_.CommandLine -like '*npm run dev*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

timeout /t 2 > nul
exit /b