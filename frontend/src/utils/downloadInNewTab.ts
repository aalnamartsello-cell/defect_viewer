// src/utils/downloadInNewTab.ts
export function downloadInNewTab(blob: Blob, filename: string) {
  const fileUrl = URL.createObjectURL(blob);

  // HTML-страничка в новой вкладке, которая инициирует ОДИН download
  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>Скачивание ведомости...</title>
  <style>
    body{font-family:system-ui,Segoe UI,Roboto,Arial; padding:48px; color:#111}
    a{display:inline-block;margin-top:12px}
  </style>
</head>
<body>
  <h2>Скачивание ведомости...</h2>
  <div>Если скачивание не началось автоматически — нажмите ссылку ниже.</div>
  <a id="dl" href="${fileUrl}" download="${filename}">Скачать: ${filename}</a>
  <script>
    const a = document.getElementById('dl');
    setTimeout(() => a.click(), 50);
  </script>
</body>
</html>`;

  const pageBlob = new Blob([html], { type: "text/html;charset=utf-8" });
  const pageUrl = URL.createObjectURL(pageBlob);

  // ВАЖНО: открываем НЕ fileUrl, а html-страницу
  window.open(pageUrl, "_blank", "noopener,noreferrer");

  // чистим позже
  window.setTimeout(() => {
    URL.revokeObjectURL(fileUrl);
    URL.revokeObjectURL(pageUrl);
  }, 60_000);
}
