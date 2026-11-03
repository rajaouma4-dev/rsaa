@echo off
set "JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot"
set "PATH=%JAVA_HOME%\bin;%PATH%"
for %%I in ("%~dp0..\.nb") do set "NEXA_NATIVE_BUILD=%%~fI"
cd /d "%~dp0..\mobile\android"
call gradlew.bat assembleRelease --no-daemon --max-workers=2 "-PnexaNativeBuildDir=%NEXA_NATIVE_BUILD%"
