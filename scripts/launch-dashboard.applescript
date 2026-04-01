-- Claude Code Dashboard launcher
-- Ensures the server is running, then opens the dashboard in an app-mode window

on run
    -- Check if server is already up
    set isRunning to false
    try
        do shell script "curl -sf http://localhost:3456/api/health -o /dev/null 2>&1"
        set isRunning to true
    end try

    if not isRunning then
        -- Try launchctl (LaunchAgent should keep it alive)
        try
            do shell script "launchctl load ~/Library/LaunchAgents/com.claude.dashboard.plist 2>/dev/null"
        end try
        -- Wait up to 4 seconds for server to come up
        set waited to 0
        repeat while waited < 4
            delay 0.5
            set waited to waited + 0.5
            try
                do shell script "curl -sf http://localhost:3456/api/health -o /dev/null 2>&1"
                set isRunning to true
                exit repeat
            end try
        end repeat
        -- If still not up, start directly
        if not isRunning then
            do shell script "cd ~/Claude-dashboard && /usr/local/bin/node server.js >> ~/.claude/dashboard-logs/server.log 2>&1 &"
            delay 2
        end if
    end if

    -- Open in Chrome app mode for a native window feel
    -- Falls back to Arc, then Safari, then default browser
    set opened to false

    try
        do shell script "'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --app=http://localhost:3456 --window-size=1440,940 2>/dev/null &"
        set opened to true
    end try

    if not opened then
        try
            do shell script "'/Applications/Arc.app/Contents/MacOS/Arc' http://localhost:3456 2>/dev/null &"
            set opened to true
        end try
    end if

    if not opened then
        open location "http://localhost:3456"
    end if
end run
