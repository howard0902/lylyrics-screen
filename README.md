# Lyrics screen

把 Spotify 現正播放的歌詞，直接顯示到 Thermalright USB LCD 上的 Windows app。

## 功能

- 直接讀取 Spotify 播放狀態
- 透過 LRCLIB 取得同步歌詞
- 直接把畫面寫進 Thermalright USB LCD
- 內建 Windows 開機自啟動
- 內建最小化到系統匣
- 偵測 `SignalRgb.Service` 是否占用 LCD
- 支援中文歌詞

## 安裝

1. 到 GitHub Release 下載安裝檔。
2. 執行 `lyLyrics screen-0.1.0-x64.exe`。
3. 完成安裝後，程式會出現在：

```text
C:\Users\你的使用者名稱\AppData\Local\Programs\lylyrics-screen
```

4. 首次執行後，請在 app 內輸入 Spotify `Client ID`。
5. 按下 `儲存並連接 Spotify`，並完成瀏覽器授權。

## Spotify 設定

建立 Spotify App 時，請加入這個 Redirect URI：

```text
http://127.0.0.1:17321/callback
```

## 使用方式

1. 先確認 LCD 已接上。
2. 如果你有開 `SignalRGB`，請先確認它沒有占用 LCD。
3. 在 app 中輸入 Spotify `Client ID`。
4. 按下 `儲存並連接 Spotify`。
5. 連接完成後，開始播放 Spotify 音樂，歌詞就會同步顯示到 LCD。

## 關閉 SignalRGB 服務

如果 `SignalRgb.Service` 佔用 LCD，可以用系統管理員 PowerShell 執行：

```powershell
Set-Service -Name 'SignalRgb.Service' -StartupType Disabled
Stop-Service -Name 'SignalRgb.Service' -Force
```

## 開機自啟動

app 內建開機自啟動按鈕，會在 Windows 啟動資料夾建立捷徑，直接啟動安裝後的 exe。

安裝完成後，程式通常會安裝在：

```text
C:\Users\你的使用者名稱\AppData\Local\Programs\lylyrics-screen
```

## 原始碼開發

如果你是從原始碼執行，仍需要安裝 Node 依賴與 Python bridge 依賴。

```bash
npm install
python -m pip install -r requirements-lcd.txt
```

## 授權

MIT License
