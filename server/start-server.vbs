Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d ""C:\Users\AdrianOw\Projects\Reader\server"" && node server.js", 0, False
