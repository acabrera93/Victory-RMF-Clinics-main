
  let deferredPrompt;
  window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('btn-instalar').style.display = 'inline-block';
  });

  document.getElementById('btn-instalar').addEventListener('click', function() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function() { deferredPrompt = null; });
    }
  });

  const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const esSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const esChromeIOS = esIOS && /CriOS/i.test(navigator.userAgent);
  const yaInstalada = window.navigator.standalone === true;

  if (!yaInstalada && esIOS) {
    const panel = document.getElementById('ios-install');
    if (esChromeIOS) {
      // Chrome en iOS no puede instalar PWAs — pedir que abran en Safari
      panel.innerHTML = `
        <div style="width:36px;height:4px;background:rgba(255,255,255,0.25);border-radius:2px;margin:0 auto 16px;"></div>
        <div style="font-size:17px;font-weight:700;margin-bottom:12px;">Instala la app en tu iPhone</div>
        <div style="background:rgba(255,255,255,0.08);border-radius:12px;padding:16px;margin-bottom:18px;text-align:left;">
          <div style="font-weight:600;font-size:14px;margin-bottom:6px;">Abre esta página en Safari</div>
          <div style="color:rgba(255,255,255,0.6);font-size:13px;line-height:1.6;">En iPhone, la instalación solo funciona desde <strong style="color:#fff;">Safari</strong>. Chrome no lo permite.<br><br>Pulsa los tres puntos <strong style="color:#fff;">···</strong> arriba a la derecha y selecciona <strong style="color:#fff;">"Abrir en Safari"</strong>.</div>
        </div>
        <button onclick="document.getElementById('ios-install').style.display='none';document.getElementById('wa-circle').style.display='flex';" style="width:100%;background:rgba(255,255,255,0.12);border:none;color:#fff;padding:13px;border-radius:10px;cursor:pointer;font-size:14px;font-family:'DM Sans',sans-serif;font-weight:500;">Entendido</button>
      `;
      panel.style.display = 'block';
      document.getElementById('wa-circle').style.display = 'none';
    } else if (esSafari) {
      panel.style.display = 'block';
      document.getElementById('wa-circle').style.display = 'none';
    }
  }
