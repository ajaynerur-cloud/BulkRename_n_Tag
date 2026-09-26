// Applies the saved theme before first paint to avoid a flash.
(function () {
  try {
    var t = localStorage.getItem('nametag.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* ignore */ }
})();
