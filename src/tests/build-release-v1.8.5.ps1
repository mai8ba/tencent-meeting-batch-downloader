$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = Split-Path -Parent $sourceRoot
$releaseRoot = Join-Path $projectRoot '发布-v1.8.5'
if (Test-Path -LiteralPath $releaseRoot) { throw '发布目录已存在，拒绝覆盖已有交付文件。' }
$manifest = Get-Content -LiteralPath (Join-Path $sourceRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne '1.8.5') { throw '源码版本不是 1.8.5。' }
$runtimeFiles = @(Get-ChildItem -LiteralPath $sourceRoot -File | Where-Object { $_.Extension -in '.js','.css','.html','.json' })
foreach ($runtimeFile in $runtimeFiles) {
  if ($runtimeFile.Extension -eq '.js') { & node --check $runtimeFile.FullName; if ($LASTEXITCODE -ne 0) { throw ('语法检查失败：' + $runtimeFile.Name) } }
  $contents = Get-Content -LiteralPath $runtimeFile.FullName -Raw
  if ($contents -match 'KECUN_ADMIN_KEY|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|"d"\s*:\s*"[A-Za-z0-9_-]{30,}') { throw ('成品存在疑似私钥：' + $runtimeFile.Name) }
}
New-Item -ItemType Directory -Path $releaseRoot | Out-Null
$product = Join-Path $releaseRoot '腾讯会议批量下载助手-v1.8.5'
$source = Join-Path $releaseRoot '腾讯会议批量下载助手-v1.8.5-源码'
New-Item -ItemType Directory -Path $product,$source | Out-Null
foreach ($file in $runtimeFiles) {
  Copy-Item -LiteralPath $file.FullName -Destination $product
  Copy-Item -LiteralPath $file.FullName -Destination $source
}
foreach ($target in @($product,$source)) { Copy-Item -LiteralPath (Join-Path $sourceRoot 'icons') -Destination $target -Recurse }
Get-ChildItem -LiteralPath $sourceRoot -File -Filter '*.md' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $source }
$sourceTests = Join-Path $source 'tests'
New-Item -ItemType Directory -Path $sourceTests | Out-Null
Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object { $_.Extension -in '.cjs','.mjs','.md','.ps1' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $sourceTests }
$instructions = @'
# 腾讯会议批量下载助手 v1.8.5

发布日期：2026-11-02。适用于 Chrome / Edge 116 及以上版本。

## 安装与升级

首次安装：解压成品包，在浏览器扩展管理页开启开发者模式，选择“加载已解压的扩展程序”，选择包含 manifest.json 的文件夹。

已有用户升级：先停止导出并等待传输结束，备份当前插件文件夹，再将成品包内文件复制到原来已加载的插件文件夹。保持原路径，在扩展管理页点“重新加载”，再回录制页按 F5。不要移除扩展重装，以免丢失设备授权、清单与下载记录。

## 使用

打开 https://meeting.tencent.com/user-center/meeting-record 并登录。点击录制页右下角悬浮按钮，工作台会在同一页面展开。依次连接录制目录、采集清单、勾选课程、开始导出。页面每页固定 30 条；导出时保持录制页前台。

可随时停止，之后继续导出。判断完成依据为浏览器下载记录的完成状态、字节数和文件存在状态；不再要求选择文件夹，也不读取 Word 正文。因此不能保证腾讯服务器生成的逐字稿非空或完整。

文件保存到浏览器设置的下载位置；可从工作台“改下载位置”打开设置。连续下载请关闭浏览器的“下载前询问每个文件的保存位置”。同名文件由浏览器自动添加后缀，不覆盖已有文件。

分享课程入口支持粘贴整段分享文本、识别课程及密码，选择视频或逐字稿下载。只下载您有权访问和保存的录制。

保留 3 天试用、设备申请码、限时及永久激活。需要激活时，将申请码发给麦爸（mai8ba）。有效期按联网校时判断。私钥生成器不随成品或源码包分发。

## 验证范围

本次回归记录见发布目录“发布检查.txt”。浏览器自动化使用隔离的 Edge 测试环境和受控录制页，不访问用户账号，不代表逐条复验全部线上课程。

源码包保留原开发说明、历史验证记录和测试脚本，历史文档中的旧版本行为以本说明为准。
'@
foreach ($target in @($product,$source,$releaseRoot)) { $instructions | Set-Content -LiteralPath (Join-Path $target '发行说明.md') -Encoding utf8 }
$references = @($manifest.background.service_worker, $manifest.action.default_popup) + @($manifest.icons.PSObject.Properties.Value) + @($manifest.content_scripts | ForEach-Object {$_.js}) + @($manifest.web_accessible_resources | ForEach-Object {$_.resources})
foreach ($reference in $references) { if (!(Test-Path -LiteralPath (Join-Path $product $reference))) { throw ('成品缺少资源：' + $reference) } }
$archives = @()
foreach ($target in @($product,$source)) {
  $zipPath = $target + '.zip'
  Compress-Archive -LiteralPath $target -DestinationPath $zipPath -CompressionLevel Optimal
  $archives += Get-Item -LiteralPath $zipPath
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($archive in $archives) {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($archive.FullName)
  try {
    $entries = @($zip.Entries)
    if (!($entries | Where-Object {$_.FullName -match '/manifest.json$'})) { throw '压缩包缺少 manifest.json。' }
    foreach ($entry in $entries) {
      if ($entry.FullName -match '(?i)(artifacts/|/profile/|\.crdownload$|\.log$|私钥内嵌|\.git/|\.workbuddy/)') { throw ('压缩包混入不应分发内容：' + $entry.FullName) }
      $stream = $entry.Open()
      try { $stream.CopyTo([System.IO.Stream]::Null) } finally { $stream.Dispose() }
    }
  } finally { $zip.Dispose() }
}
$archives | Get-FileHash -Algorithm SHA256 | ForEach-Object { $_.Hash + '  ' + (Split-Path -Leaf $_.Path) } | Set-Content -LiteralPath (Join-Path $releaseRoot 'SHA256校验.txt') -Encoding utf8
$archives | Select-Object Name,Length
