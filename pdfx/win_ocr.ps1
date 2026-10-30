param(
    [Parameter(Mandatory=$true)][string]$ImagePath,
    [string]$Lang = "",
    [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"

function Emit($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 6
    if ($OutFile -ne "") {
        [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    } else {
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        Write-Output $json
    }
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

    function Await($WinRtTask, $ResultType) {
        $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
        $netTask = $asTask.Invoke($null, @($WinRtTask))
        $netTask.Wait(-1) | Out-Null
        $netTask.Result
    }

    [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

    $engine = $null
    if ($Lang -ne "") {
        $language = New-Object Windows.Globalization.Language($Lang)
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    }
    if ($null -eq $engine) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    if ($null -eq $engine) {
        $langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }
        Emit @{ ok = $false; error = "no_ocr_language"; available = @($langs) }
        exit 0
    }

    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    $lines = @()
    foreach ($line in $result.Lines) {
        $words = @()
        $minX = [double]::MaxValue; $minY = [double]::MaxValue
        $maxX = 0.0; $maxY = 0.0
        foreach ($w in $line.Words) {
            $r = $w.BoundingRect
            $words += @{ text = $w.Text; x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height }
            if ($r.X -lt $minX) { $minX = $r.X }
            if ($r.Y -lt $minY) { $minY = $r.Y }
            if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
            if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
        }
        if ($words.Count -gt 0) {
            $lines += @{
                text = $line.Text
                x = $minX; y = $minY
                w = ($maxX - $minX); h = ($maxY - $minY)
                words = $words
            }
        }
    }

    $out = @{
        ok = $true
        width = $decoder.PixelWidth
        height = $decoder.PixelHeight
        language = $engine.RecognizerLanguage.LanguageTag
        lines = $lines
    }
    Emit $out
}
catch {
    Emit @{ ok = $false; error = "ps_exception"; message = $_.Exception.Message }
}
