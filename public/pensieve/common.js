(() => {
  const back = document.createElement('a');
  back.className = 'hub-btn';
  back.href = '/index.html';
  back.textContent = '← Back to Hub';
  document.body.appendChild(back);

  window.proto = {
    setBar(id, pct){
      const el = document.getElementById(id);
      if (!el) return;
      el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    },
    setText(id, text){
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    }
  };
})();