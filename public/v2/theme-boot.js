// Classic (non-module) script in <head>: applies the cached UI theme before first paint (no flash).
// The server-side UiPrefs.uiTheme will be the source of truth once /api/v2/prefs exists (data-model.md §12).
(function () {
  try {
    var t = localStorage.getItem('ao.uiTheme');
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow the system */ }
})();
